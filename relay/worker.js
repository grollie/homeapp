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
    if (url.pathname !== '/metrics') return new Response('Not found', { status: 404, headers: cors });
    if (!env.RELAY_KEY || url.searchParams.get('k') !== env.RELAY_KEY) return new Response('Unauthorized', { status: 401, headers: cors });

    try {
      const sites = await authorizedSites(env, url.searchParams.has('fresh'));
      const results = await Promise.all(sites.map(async (s) => {
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
      return Response.json({ at: new Date().toISOString(), sites: results }, { headers: cors });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: cors });
    }
  },
};

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
