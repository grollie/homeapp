// Home Hub → Tuya / Smart Life relay (Cloudflare Worker).
//
// Signs Tuya OpenAPI requests (HMAC-SHA256) so the page never sees the keys, and returns
// every linked device with its current status: GET /devices?k=<RELAY_KEY>
//
// Secrets: TUYA_ID (Access ID), TUYA_SECRET (Access Secret), RELAY_KEY (shared with the page)
// Optional var: TUYA_BASE (default https://openapi.tuyaus.com = Western America)

const ALLOWED_ORIGINS = ['https://grollie.github.io', 'http://localhost:8787'];
let tokenCache = { token: '', exp: 0 };

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
      if (url.pathname === '/devices') {
        // Tuya's trial plan has a small monthly call quota and every page poll used to cost 1 + N calls.
        // Serve a shared cached snapshot (Cloudflare edge cache, CACHE_SECONDS, default 600) and only go to Tuya
        // when it's stale; on a Tuya error, fall back to the last good snapshot so the page keeps showing data.
        const ttl = +(env.CACHE_SECONDS || 600);
        const ck = new Request('https://tuya-relay.internal/devices-snapshot');
        const hit = await caches.default.match(ck);
        if (hit) { const j = await hit.json(); if (Date.now() - Date.parse(j.at) < ttl * 1000) return Response.json({ ...j, cached: true }, { headers: cors }); }
        let fresh;
        try { fresh = await snapshot(env); }
        catch (e) { if (hit) { const j = await (await caches.default.match(ck)).json().catch(() => null); if (j) return Response.json({ ...j, cached: true, stale: true, error: e.message }, { headers: cors }); } throw e; }
        await caches.default.put(ck, new Response(JSON.stringify(fresh), { headers: { 'Cache-Control': 'max-age=86400' } }));
        return Response.json(fresh, { headers: cors });
      }
      if (url.pathname === '/raw') {                      // debugging: any GET path
        return Response.json(await tuya(env, url.searchParams.get('path') || '/v1.0/token?grant_type=1'), { headers: cors });
      }
      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: cors });
    }
  },
};

// One fresh reading of every linked device (1 list call, cached for hours, + 1 shadow call per device).
async function snapshot(env) {
  const list = await devicesList(env);
  let quota = null;
  const devices = await Promise.all(list.map(async (d) => {
    try {
      const sh = await tuya(env, `/v2.0/cloud/thing/${d.id}/shadow/properties`);
      const p = Object.fromEntries((sh.properties || []).map((x) => [x.code, x.value]));
      // SmartLi "EOS" packs: voltages/currents ×100, temps ×10, capacities in 10 mAh, remain_time in minutes
      const v = p.pack_voltage / 100, a = p.pack_current / 100;
      return { id: d.id, name: d.name, online: d.online, soc: p.soc, soh: p.soh, volts: v, amps: a, watts: Math.round(v * a),
        temp: p.cell_temp / 10, cycles: p.cycle_counts, remainMin: p.remain_time, capAh: p.full_cap / 100, remainAh: p.remain_cap / 100,
        warning: p.warning_flag || 0, protection: p.protections_fag || 0 };
    } catch (e) { if (/quota/i.test(e.message)) quota = e; return { id: d.id, name: d.name, online: false, error: e.message }; }
  }));
  if (quota) throw quota;                                    // don't cache a snapshot of errors
  return { at: new Date().toISOString(), devices };
}

// Device list with real names (the list endpoint only has product-ish names); cached 6 h — it rarely changes.
let listCache = { at: 0, list: [] };
async function devicesList(env) {
  if (listCache.list.length && Date.now() - listCache.at < 6 * 36e5) return listCache.list;
  const raw = (await tuya(env, '/v2.0/cloud/thing/device?page_size=20')) || [];
  const list = await Promise.all(raw.map(async (d) => {
    const det = await tuya(env, `/v1.0/iot-03/devices/${d.id}`).catch(() => ({}));
    return { id: d.id, name: det.name || d.custom_name || d.name, online: det.online ?? d.is_online };
  }));
  listCache = { at: Date.now(), list };
  return list;
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(s, key) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(s))).toUpperCase();
}

// Signed GET against the Tuya OpenAPI; returns `result` or throws with Tuya's message.
async function tuya(env, path, withToken = true) {
  const base = env.TUYA_BASE || 'https://openapi.tuyaus.com';
  const token = withToken ? await accessToken(env) : '';
  const t = String(Date.now()), nonce = crypto.randomUUID().replace(/-/g, '');
  const strToSign = `GET\n${await sha256('')}\n\n${path}`;
  const sign = await hmac(env.TUYA_ID + token + t + nonce + strToSign, env.TUYA_SECRET);
  const headers = { client_id: env.TUYA_ID, sign, t, nonce, sign_method: 'HMAC-SHA256' };
  if (token) headers.access_token = token;
  const r = await (await fetch(base + path, { headers })).json();
  if (!r.success) {
    if (r.code === 1010) tokenCache.exp = 0;              // token invalid → refresh next time
    throw new Error(`Tuya ${r.code}: ${r.msg}`);
  }
  return r.result;
}

async function accessToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const r = await tuya(env, '/v1.0/token?grant_type=1', false);
  tokenCache = { token: r.access_token, exp: Date.now() + (r.expire_time - 60) * 1000 };
  return r.access_token;
}
