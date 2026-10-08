// Home Hub → Solar Assistant relay (Cloudflare Worker).
//
// The Solar Assistant proxy requires Site-Id / Site-Key as HTTP headers, which a browser
// can't send, so this worker sits in between: the page calls GET /metrics?k=<RELAY_KEY>,
// the worker signs in to every site on the account and returns all metrics as one JSON.
//
// Secrets (Settings → Variables and Secrets):
//   SA_TOKEN   – Solar Assistant cloud API token (solar-assistant.io/user/edit#api)
//   RELAY_KEY  – any long random string; the same value goes in the Home Hub vault

const CLOUD = 'https://solar-assistant.io/api/v1/';
const ALLOWED_ORIGINS = ['https://grollie.github.io', 'http://localhost:8787'];
let siteCache = { at: 0, sites: [] };   // per-site tokens last 7 days; refresh daily

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'no-store',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!env.RELAY_KEY || url.searchParams.get('k') !== env.RELAY_KEY) return new Response('Unauthorized', { status: 401, headers: cors });

    try {
      if (url.pathname === '/metrics') return Response.json({ at: new Date().toISOString(), sites: await allMetrics(env, url.searchParams.has('fresh')) }, { headers: cors });
      if (url.pathname === '/alerts/check') return Response.json(await checkMppt(env, url.searchParams.has('force')), { headers: cors });
      if (url.pathname === '/alerts/test') {
        const to = url.searchParams.get('to');                 // optional override, e.g. &to=someone@example.com
        await sendMail(env, 'Home Hub test alert', 'This is a test from the solar-relay worker. MPPT alerts are working.', to);
        return Response.json({ sent: true, to: to || env.ALERT_TO }, { headers: cors });
      }
      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: cors });
    }
  },

  // Cron (every 5 min): look for a dead MPPT string and email about it.
  async scheduled(event, env, ctx) { ctx.waitUntil(checkMppt(env)); },
};

async function allMetrics(env, fresh) {
  const sites = await authorizedSites(env, fresh);
  return Promise.all(sites.map(async (s) => {
    try {
      const r = await fetch(`https://${s.host}/api/v1/metrics`, {
        headers: { Authorization: `Bearer ${s.token}`, 'Site-Id': String(s.site_id), 'Site-Key': s.site_key },
      });
      if (r.status === 401) siteCache.at = 0;            // token expired → re-authorize next call
      if (!r.ok) throw new Error(`site ${r.status}`);
      return { id: s.site_id, name: s.site_name, description: s.description, dashboard: `https://${s.site_host}/`, metrics: await r.json() };
    } catch (e) {
      return { id: s.site_id, name: s.site_name, description: s.description, dashboard: `https://${s.site_host}/`, error: e.message };
    }
  }));
}

// ---- MPPT fault alerting ----
// Fault = one PV string <= DEAD_W while another on the same inverter > LIVE_W. Alert after it persists for
// CONFIRM consecutive checks, remind every REMIND_H hours, and send a recovery note when it clears. State in KV.
const DEAD_W = 5, LIVE_W = 100, CONFIRM = 2, REMIND_H = 6;
const kW = (w) => (Math.abs(w) >= 1000 ? (w / 1000).toFixed(2) + ' kW' : Math.round(w) + ' W');

async function checkMppt(env, force = false) {
  const sites = await allMetrics(env);
  const report = [];
  for (const s of sites) {
    if (s.error) { report.push({ site: s.name, skipped: s.error }); continue; }
    const m = Object.fromEntries(s.metrics.map((x) => [x.topic, x]));
    const v = (t) => +((m[t] || {}).value) || 0;
    const strings = Object.keys(m).filter((t) => /^inverter_\d+\/pv_power_\d+$/.test(t)).sort()
      .map((t, i) => ({ n: i + 1, w: v(t), volts: v(t.replace('pv_power', 'pv_voltage')), amps: v(t.replace('pv_power', 'pv_current')) }));
    const dead = strings.filter((x) => x.w <= DEAD_W), live = strings.filter((x) => x.w > LIVE_W);
    const fault = strings.length > 1 && dead.length > 0 && live.length > 0;
    const key = `mppt:${s.id}`;
    const st = (await env.STATE.get(key, 'json')) || { count: 0, alertedAt: 0 };
    const label = s.description ? `${s.description} (${s.name})` : s.name;
    const detail = strings.map((x) => `MPPT ${x.n}: ${kW(x.w)} (${x.volts} V, ${x.amps} A)`).join('\n');
    let action = 'none';
    if (fault) {
      st.count++;
      const due = st.count >= CONFIRM && Date.now() - st.alertedAt > REMIND_H * 36e5;
      if (due || force) {
        const subject = `⚠ ${label}: ${dead.map((x) => 'MPPT ' + x.n).join(', ')} at 0 W while ${live.map((x) => 'MPPT ' + x.n + ' makes ' + kW(x.w)).join(', ')}`;
        await sendMail(env, subject, `${label}\n\n${detail}\n\nOne string is producing nothing while the other is in full sun. Check that string's breaker, fuse and connectors.\n\nDashboard: ${s.dashboard}\nHome Hub: https://grollie.github.io/homeapp/`);
        st.alertedAt = Date.now(); action = 'alerted';
      } else action = 'pending';
    } else {
      if (st.alertedAt) { await sendMail(env, `✅ ${label}: MPPT strings back to normal`, `${label}\n\n${detail}\n\nBoth strings are producing again.`); action = 'recovered'; }
      st.count = 0; st.alertedAt = 0;
    }
    await env.STATE.put(key, JSON.stringify(st));
    report.push({ site: label, fault, strings, count: st.count, action });
  }
  return { at: new Date().toISOString(), report };
}

async function sendMail(env, subject, text, toOverride) {
  if (!env.BREVO_KEY) throw new Error('BREVO_KEY not set');
  const to = (toOverride || env.ALERT_TO || '').split(',').map((e) => ({ email: e.trim() })).filter((e) => e.email);
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: { name: 'Home Hub', email: env.ALERT_FROM }, to, subject, textContent: text }),
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function authorizedSites(env, force) {
  if (!force && siteCache.sites.length && Date.now() - siteCache.at < 864e5) return siteCache.sites;
  const h = { Authorization: `Bearer ${env.SA_TOKEN}` };
  const list = await (await fetch(CLOUD + 'sites', { headers: h })).json();
  if (!Array.isArray(list)) throw new Error('cloud: bad token or response');
  const sites = await Promise.all(list.map(async (s) => {
    const a = await (await fetch(`${CLOUD}sites/${s.id}/authorize`, { method: 'POST', headers: h })).json();
    return { ...a, description: s.description };
  }));
  siteCache = { at: Date.now(), sites };
  return sites;
}
