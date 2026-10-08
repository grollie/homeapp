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
// Secrets: ECOBEE_USER, ECOBEE_PASSWORD, RELAY_KEY.  KV binding STATE caches the access token.

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
      if (url.pathname === '/logout') { await env.STATE.delete('ecobee:token'); return Response.json({ ok: true }, { headers: cors }); }
      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: cors });
    }
  },
};

// ---- auth: password grant, token cached in KV until shortly before it expires ----
async function token(env, force = false) {
  const cached = !force && (await env.STATE.get('ecobee:token', 'json'));
  if (cached && Date.now() < cached.exp) return cached.access_token;
  if (!env.ECOBEE_USER || !env.ECOBEE_PASSWORD) throw new Error('ECOBEE_USER / ECOBEE_PASSWORD not set');
  const r = await fetch(AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ grant_type: 'password', client_id: CLIENT_ID, audience: AUDIENCE, scope: 'openid smartRead smartWrite piiRead',
      username: env.ECOBEE_USER, password: env.ECOBEE_PASSWORD }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`ecobee login: ${j.error_description || j.error || r.status}`);
  await env.STATE.put('ecobee:token', JSON.stringify({ access_token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 120) * 1000 }));
  return j.access_token;
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

// ---- normalise ecobee's thermostat object into the climate shape the page renders ----
async function thermostats(env) {
  const sel = { selection: { selectionType: 'registered', selectionMatch: '', includeRuntime: true, includeSensors: true, includeSettings: true, includeEvents: true, includeEquipmentStatus: true, includeWeather: true } };
  const j = await api(env, '/thermostat', JSON.stringify(sel));
  const f = (x) => (x == null ? null : Math.round(x) / 10);                 // ecobee sends °F ×10
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
      sensors,
    };
  });
}
