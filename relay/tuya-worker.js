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
        const list = await tuya(env, '/v2.0/cloud/thing/device?page_size=20');
        const devices = await Promise.all((list || []).map(async (d) => {
          const st = await tuya(env, `/v1.0/iot-03/devices/${d.id}/status`).catch(() => []);
          return { id: d.id, name: d.custom_name || d.name, product: d.product_name, category: d.category, online: d.is_online,
            status: Object.fromEntries((st || []).map((s) => [s.code, s.value])) };
        }));
        return Response.json({ at: new Date().toISOString(), devices }, { headers: cors });
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
