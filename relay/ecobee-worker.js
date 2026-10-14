// Home Hub → ecobee relay (Cloudflare Worker).
//
// ecobee closed its developer program, so this signs in the way the consumer portal does (Auth0 password
// grant with the portal's public client id) and reads the same API the portal reads. Unofficial: if ecobee
// changes its login flow this stops working. The page only ever sees the normalised shape below, which a
// Home Assistant relay can produce identically later (see README "Climate data shape").
//
//   GET /thermostats?k=<RELAY_KEY>  ->  { at, source:'ecobee', thermostats:[{ id, name, temp, humidity,
//        heatSet, coolSet, mode, fan, running:[...], hold, sensors:[{ id, name, temp, occupied, open }] }] }
//
// Secrets: ECOBEE_USER, ECOBEE_PASSWORD, ECOBEE_TOTP (authenticator setup key, if 2-step is on), RELAY_KEY.
// KV binding STATE caches the access token.

const ALLOWED_ORIGINS = ['https://grollie.github.io', 'http://localhost:8787'];
const AUTH = 'https://auth.ecobee.com/oauth/token';
const CLIENT_ID = '183eORFPlXyz9BbDZwqexHPBQoVjgadh';         // the ecobee web portal's public client id
const AUDIENCE = 'https://prod.ecobee.com/api/v1';
const API = 'https://api.ecobee.com/1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) HomeHub/1.0';

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
      if (url.pathname === '/thermostats') return Response.json({ at: new Date().toISOString(), source: 'ecobee', thermostats: await thermostats(env) }, { headers: cors });
      if (url.pathname === '/raw') return Response.json(await api(env, url.searchParams.get('path') || '/thermostat', url.searchParams.get('json')), { headers: cors });
      // Setpoints: /set?id=<thermostat>&heat=68&cool=74[&hold=nextTransition|indefinite|2h]  — a hold overriding the schedule.
      if (url.pathname === '/set') return Response.json(await setHold(env, url.searchParams), { headers: cors });
      // Cancel the hold and go back to the schedule: /resume?id=<thermostat>
      if (url.pathname === '/resume') { await tpost(env, { selection: { selectionType: 'thermostats', selectionMatch: url.searchParams.get('id') }, functions: [{ type: 'resumeProgram', params: { resumeAll: true } }] }); return Response.json({ ok: true }, { headers: cors }); }
      if (url.pathname === '/logout') { mem = { access_token: '', exp: 0, refresh: '' }; await env.STATE.delete('ecobee:token').catch(() => {}); await env.STATE.delete('ecobee:refresh').catch(() => {}); return Response.json({ ok: true }, { headers: cors }); }
      // One-time connect for SMS 2-step: /connect/start sends the text, /connect/finish?code=123456 completes it
      // and stores the refresh token so the relay never has to ask again.
      if (url.pathname === '/connect/start') return Response.json(await smsStart(env), { headers: cors });
      if (url.pathname === '/connect/finish') return Response.json(await smsFinish(env, url.searchParams.get('code')), { headers: cors });
      if (url.pathname === '/connect/status') { const rt = await env.STATE.get('ecobee:refresh'); const tk = await env.STATE.get('ecobee:token', 'json'); return Response.json({ connected: !!rt, tokenUntil: tk ? new Date(tk.exp).toISOString() : null }, { headers: cors }); }
      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: cors });
    }
  },
};

// ---- auth ----
// Order: cached access token → refresh token (stored after the one-time SMS connect) → password grant
// (which succeeds outright only if the account has no 2-step, or answers TOTP from ECOBEE_TOTP).
const SCOPE = 'openid offline_access smartRead smartWrite piiRead';
const post = (body) => fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body) });
// Token lives in memory first (per isolate) and in KV second. KV writes are best-effort: the account's free
// KV quota is 1,000 writes/day and KV reads lag ~60 s, so leaning on KV for every call caused refresh storms.
let mem = { access_token: '', exp: 0, refresh: '' };
let refreshing = null;                                        // de-dupe concurrent refreshes in one isolate
async function saveToken(env, j) {
  mem = { access_token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 120) * 1000, refresh: j.refresh_token || mem.refresh };
  env.STATE.put('ecobee:token', JSON.stringify({ access_token: mem.access_token, exp: mem.exp })).catch(() => {});
  if (j.refresh_token) env.STATE.put('ecobee:refresh', j.refresh_token).catch(() => {});
  return j.access_token;
}
async function token(env, force = false) {
  if (!force && mem.access_token && Date.now() < mem.exp) return mem.access_token;
  if (!force) {
    const cached = await env.STATE.get('ecobee:token', 'json').catch(() => null);
    if (cached && Date.now() < cached.exp) { mem.access_token = cached.access_token; mem.exp = cached.exp; return cached.access_token; }
  }
  if (refreshing) return refreshing;
  refreshing = (async () => { try { return await loginFlow(env); } finally { refreshing = null; } })();
  return refreshing;
}
async function loginFlow(env) {
  const refresh = mem.refresh || (await env.STATE.get('ecobee:refresh').catch(() => null));
  if (refresh) {
    const r = await post({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refresh });
    const j = await r.json();
    if (r.ok && j.access_token) return saveToken(env, j);
    mem.refresh = ''; env.STATE.delete('ecobee:refresh').catch(() => {});   // refresh token revoked/expired → fall through
  }
  if (!env.ECOBEE_USER || !env.ECOBEE_PASSWORD) throw new Error('ECOBEE_USER / ECOBEE_PASSWORD not set');
  const r = await post({ grant_type: 'password', client_id: CLIENT_ID, audience: AUDIENCE, scope: SCOPE, username: env.ECOBEE_USER, password: env.ECOBEE_PASSWORD });
  let j = await r.json();
  if (j.error === 'mfa_required' && !env.ECOBEE_TOTP) throw new Error('ecobee: 2-step verification is on — open the Thermostats tile and use "Connect ecobee" to enter the SMS code once');
  // Account has 2-step verification: answer Auth0's MFA challenge with a TOTP code from ECOBEE_TOTP (the
  // authenticator "setup key"), exactly as the phone app would.
  if (j.error === 'mfa_required' && j.mfa_token) {
    if (!env.ECOBEE_TOTP) throw new Error('ecobee login: 2-step verification is on but ECOBEE_TOTP is not set');
    const r2 = await post({ grant_type: 'http://auth0.com/oauth/grant-type/mfa-otp', client_id: CLIENT_ID, mfa_token: j.mfa_token, otp: await totp(env.ECOBEE_TOTP) });
    j = await r2.json();
    if (!r2.ok || !j.access_token) throw new Error(`ecobee MFA: ${j.error_description || j.error || r2.status}`);
  } else if (!r.ok || !j.access_token) throw new Error(`ecobee login: ${j.error_description || j.error || r.status}`);
  return saveToken(env, j);
}

// ---- SMS 2-step: start = password grant → mfa_token → ask Auth0 to text the code; finish = exchange the code ----
async function smsStart(env) {
  if (!env.ECOBEE_USER || !env.ECOBEE_PASSWORD) throw new Error('ECOBEE_USER / ECOBEE_PASSWORD not set');
  const r = await post({ grant_type: 'password', client_id: CLIENT_ID, audience: AUDIENCE, scope: SCOPE, username: env.ECOBEE_USER, password: env.ECOBEE_PASSWORD });
  const j = await r.json();
  if (j.access_token) { await saveToken(env, j); return { sent: false, connected: true, note: 'No 2-step challenge — already signed in.' }; }
  if (j.error !== 'mfa_required') throw new Error(`ecobee login: ${j.error_description || j.error}`);
  const auths = await (await fetch('https://auth.ecobee.com/mfa/authenticators', { headers: { Authorization: 'Bearer ' + j.mfa_token, 'User-Agent': UA } })).json();
  const sms = (Array.isArray(auths) ? auths : []).find((a) => a.oob_channel === 'sms' && a.active) || (Array.isArray(auths) ? auths[0] : null);
  const cr = await fetch('https://auth.ecobee.com/mfa/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ mfa_token: j.mfa_token, client_id: CLIENT_ID, challenge_type: 'oob', authenticator_id: sms?.id }) });
  const ch = await cr.json();
  if (!cr.ok || !ch.oob_code) throw new Error(`ecobee MFA challenge: ${ch.error_description || ch.error || cr.status}`);
  await env.STATE.put('ecobee:mfa', JSON.stringify({ mfa_token: j.mfa_token, oob_code: ch.oob_code }), { expirationTtl: 600 });
  return { sent: true, to: sms?.name || 'your phone', authenticators: (Array.isArray(auths) ? auths : []).map((a) => `${a.authenticator_type}/${a.oob_channel || ''} ${a.name || ''}`.trim()) };
}
async function smsFinish(env, code) {
  const m = await env.STATE.get('ecobee:mfa', 'json');
  if (!m) throw new Error('No SMS challenge pending — start again');
  if (!code) throw new Error('code missing');
  const r = await post({ grant_type: 'http://auth0.com/oauth/grant-type/mfa-oob', client_id: CLIENT_ID, mfa_token: m.mfa_token, oob_code: m.oob_code, binding_code: String(code).trim() });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`ecobee MFA: ${j.error_description || j.error || r.status}`);
  await saveToken(env, j); await env.STATE.delete('ecobee:mfa');
  return { connected: true, refreshToken: !!j.refresh_token, expiresIn: j.expires_in };
}

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 setup key, via WebCrypto.
async function totp(secretB32, step = 30, digits = 6) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secretB32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '', bytes = [];
  for (const c of clean) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = await crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = new ArrayBuffer(8), view = new DataView(counter);
  view.setBigUint64(0, BigInt(Math.floor(Date.now() / 1000 / step)));
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

async function api(env, path, json, retry = true) {
  const t = await token(env);
  const u = `${API}${path}${json ? '?json=' + encodeURIComponent(json) : ''}`;
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', 'User-Agent': UA } });
  if (r.status === 401 && retry) { await token(env, true); return api(env, path, json, false); }
  const j = await r.json();
  if (!r.ok || (j.status && j.status.code !== 0)) throw new Error(`ecobee api ${r.status}: ${j.status?.message || JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// ---- writes: POST /thermostat with "functions" (setHold / resumeProgram) ----
async function tpost(env, body, retry = true) {
  const t = await token(env);
  const r = await fetch(`${API}/thermostat?format=json`, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body) });
  if (r.status === 401 && retry) { await token(env, true); return tpost(env, body, false); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.status && j.status.code !== 0)) throw new Error(`ecobee write ${r.status}: ${j.status?.message || JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// Set heat/cool setpoints as a hold. ecobee needs both values and a minimum gap between them (heatCoolMinDelta),
// so the missing one is taken from the thermostat and nudged if the gap is too small.
async function setHold(env, q) {
  const id = q.get('id'); if (!id) throw new Error('id missing');
  const cur = (await api(env, '/thermostat', JSON.stringify({ selection: { selectionType: 'thermostats', selectionMatch: id, includeRuntime: true, includeSettings: true } }))).thermostatList[0];
  if (!cur) throw new Error('thermostat not found');
  const mode = cur.settings.hvacMode, delta = (cur.settings.heatCoolMinDelta || 50) / 10;
  let heat = q.get('heat') != null ? +q.get('heat') : cur.runtime.desiredHeat / 10;
  let cool = q.get('cool') != null ? +q.get('cool') : cur.runtime.desiredCool / 10;
  if (mode === 'auto') { if (cool - heat < delta) { if (q.get('heat') != null) cool = heat + delta; else heat = cool - delta; } }
  else if (mode === 'cool') { if (cool - heat < delta) heat = cool - delta; }
  else if (mode === 'heat') { if (cool - heat < delta) cool = heat + delta; }
  const hold = q.get('hold') || 'nextTransition';
  const params = { heatHoldTemp: Math.round(heat * 10), coolHoldTemp: Math.round(cool * 10) };
  if (/^\d+h$/.test(hold)) { params.holdType = 'holdHours'; params.holdHours = parseInt(hold); } else params.holdType = hold;
  await tpost(env, { selection: { selectionType: 'thermostats', selectionMatch: id }, functions: [{ type: 'setHold', params }] });
  return { ok: true, id, heat, cool, hold: params.holdType, mode };
}

// ---- door/window SmartSensors: not in the live thermostat object, but ecobee's 5-minute runtime report carries
// them as "dryContact" columns (1 = closed/normal, 0 = open), typically 5–15 min behind. Cached 2 min per isolate.
const TZ = 'America/New_York';
const localDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
let doorCache = { at: 0, byThermostat: {} };
async function doorSensors(env, ids) {
  if (Date.now() - doorCache.at < 120e3) return doorCache.byThermostat;
  // the report's date range is interpreted in UTC (rows come back in thermostat local time), so ask in UTC
  const now = new Date(), end = now.toISOString().slice(0, 10), start = new Date(now.getTime() - 864e5).toISOString().slice(0, 10);
  const sel = { startDate: start, endDate: end, columns: 'zoneHvacMode', selection: { selectionType: 'thermostats', selectionMatch: ids.join(',') }, includeSensors: true };
  const out = {};
  try {
    const j = await api(env, '/runtimeReport', JSON.stringify(sel));
    for (const s of j.sensorList || []) {
      const cols = s.columns || [], names = Object.fromEntries((s.sensors || []).map((x) => [x.sensorId, x]));
      const dw = cols.map((c, i) => ({ c, i })).filter((x) => /^dw:/.test(x.c) && names[x.c] && names[x.c].sensorType === 'dryContact');
      if (!dw.length) continue;
      // last row where a dry-contact column has a value
      let last = null;
      for (let r = s.data.length - 1; r >= 0 && !last; r--) { const f = s.data[r].split(','); if (dw.some((x) => f[x.i] !== '')) last = f; }
      if (!last) continue;
      out[s.thermostatIdentifier] = dw.map((x) => ({ id: x.c, name: names[x.c].sensorName, type: 'door', open: last[x.i] === '0', asOf: `${last[0]} ${last[1]}` }));
    }
    doorCache = { at: Date.now(), byThermostat: out };
  } catch (e) { /* keep last good cache; doors just won't update this round */ }
  return doorCache.byThermostat;
}

// ---- normalise ecobee's thermostat object into the climate shape the page renders ----
async function thermostats(env) {
  const sel = { selection: { selectionType: 'registered', selectionMatch: '', includeRuntime: true, includeSensors: true, includeSettings: true, includeEvents: true, includeEquipmentStatus: true, includeWeather: true, includeProgram: true } };
  const j = await api(env, '/thermostat', JSON.stringify(sel));
  const f = (x) => (x == null ? null : Math.round(x) / 10);                 // ecobee sends °F ×10
  const doors = await doorSensors(env, (j.thermostatList || []).map((t) => t.identifier));
  return (j.thermostatList || []).map((t) => {
    const rt = t.runtime || {}, st = t.settings || {};
    const hold = (t.events || []).find((e) => e.running && e.type === 'hold');
    const cap = (s, type) => (s.capability || []).find((c) => c.type === type);
    const sensors = (t.remoteSensors || []).map((s) => {
      const temp = cap(s, 'temperature'), occ = cap(s, 'occupancy'), dry = cap(s, 'dryContact');
      return { id: s.id, name: s.name, type: s.type, inUse: s.inUse,
        temp: temp && temp.value !== 'unknown' ? f(+temp.value) : null,
        occupied: occ ? occ.value === 'true' : null,
        open: dry ? dry.value === 'true' : null };                            // door/window if ecobee exposes it
    });
    const wx = ((t.weather || {}).forecasts || [])[0] || {};
    return {
      id: t.identifier, name: t.name, model: t.modelNumber, connected: rt.connected,
      temp: f(rt.actualTemperature), humidity: rt.actualHumidity,
      heatSet: f(rt.desiredHeat), coolSet: f(rt.desiredCool), mode: st.hvacMode, fan: rt.desiredFanMode,
      running: (t.equipmentStatus || '').split(',').filter(Boolean),
      hold: hold ? { name: hold.name, until: hold.endDate ? `${hold.endDate} ${hold.endTime}` : null, heat: f(hold.heatHoldTemp), cool: f(hold.coolHoldTemp) } : null,
      climate: ((t.program || {}).currentClimateRef) || null,
      outside: wx.temperature != null ? { temp: f(wx.temperature), condition: wx.condition } : null,
      sensors: sensors.concat((doors[t.identifier] || []).map((d) => ({ ...d, temp: null, occupied: null, inUse: true }))),
    };
  });
}
