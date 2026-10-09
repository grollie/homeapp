# Home Hub

One password-protected page for every smart device in the house: Solar Assistant (×2),
Smart Life batteries, Starlink, Ecobee, Nest, myQ garage doors, First Alert,
FortiRecorder (×2), FortiCamera Cloud, Rachio, Whisker Litter-Robot and Feeder-Robot, and Matic.

Hosted free on GitHub Pages. Each family member has their own name + password.

## How the security works

GitHub Pages can't run a server, so the protection is done in the browser:

- The device list (addresses, any device logins/notes you add) lives in `vault.js`,
  encrypted with AES-256-GCM.
- Each person's password (PBKDF2, 600k rounds) unlocks a copy of the key.
- Nothing readable is ever stored on GitHub, and nothing is sent anywhere — the page
  decrypts locally after sign-in. Signing out (or closing the tab) locks it again.

Anyone can download the encrypted `vault.js` from GitHub; without a family password it's
just random bytes. Use real passwords (8+ characters, not reused).

## First-time setup

1. Open **setup.html** on the site (or double-click it locally).
2. Add each family member with a password. Fix any device addresses
   (the local ones — Solar Assistant, FortiRecorder, Starlink dish — need your real IPs).
   Optionally add a device's own username/password so the family can see it after signing in.
3. Click **Build & download vault.js**.
4. Either paste a GitHub token and click **Build & publish**, or put the downloaded `vault.js` in this repo next to `index.html` and commit/push
   (on github.com: **Add file → Upload files**).

To change passwords or devices later, sign in and click **Accounts** — the current vault loads automatically. (Or open setup.html, use **Edit an existing vault** with
your `vault.js` and your own login.) Make changes, then build & publish or download and commit again.

## Which devices open inside the page

| Device | Inside the page? | Why |
|---|---|---|
| Solar Assistant (both sites, merged) | Yes — live power, load, battery, grid every 10 s | Via the Cloudflare Worker in `relay/worker.js` (Solar Assistant needs headers a browser cannot send) |
| Rachio | Yes — live zones, run/stop, rain delay | Uses the Rachio API with the key stored in the vault |
| FortiRecorder ×2 | Yes (on home Wi-Fi / VPN) | Local web pages |
| Ecobee, Nest, Starlink, FortiCamera Cloud | New tab | Those sites block being embedded |
| myQ, First Alert, Whisker (Litter-Robot, Feeder-Robot), Matic | App only | No web portal exists; tile links to the vendor site |

Local devices only load when you're on the home network or connected to the home VPN.

## Local testing

`powershell -File serve.ps1` then open <http://localhost:8787>.

## Device logins via Google Password Manager

Each device's own username/password is kept in [Google Password Manager](https://passwords.google.com/),
not in this site. Chrome fills them in automatically when a device is opened (as long as you're
signed into Chrome with your Google account). The dashboard has a Google Password Manager tile and a
🔑 Passwords button on every device for quick look-ups. To give family members access to the same
logins, share them from Google Password Manager (Share → family group).

## Passwords that expire

For a device whose password changes on a schedule (FortiCamera Cloud: every 42 days), the tile shows
"Password expires in N days" and turns red when it's due. Click **Update password** on the tile, type the
new one, and either **Save & publish** (with a GitHub token) or **Save & download** then commit `vault.js`.
Set the schedule in setup.html ("Password expires every N days").

## Solar relay (Cloudflare Worker)

`relay/worker.js` runs as the `solar-relay` worker on the Cloudflare account. It holds the Solar
Assistant cloud token (secret `SA_TOKEN`) and a shared `RELAY_KEY`; the page calls
`https://solar-relay.garyrollie.workers.dev/metrics?k=<RELAY_KEY>` and gets every site's metrics.
To redeploy after editing worker.js: Cloudflare dashboard → Workers & Pages → solar-relay → Edit code,
or `PUT /accounts/<id>/workers/scripts/solar-relay` with the Cloudflare API.

## Battery relay (Tuya / Smart Life)

`relay/tuya-worker.js` runs as the `tuya-relay` worker; it signs Tuya OpenAPI calls with the IoT project's
Access ID/Secret (secrets `TUYA_ID`, `TUYA_SECRET`) and returns every linked Smart Life device with its
status at `/devices?k=<RELAY_KEY>`. The Solar tile shows each battery as a chip under the site it belongs
to; the site mapping lives in the vault on the Solar Assistant tile (`batteries: { "<site name>": [ids or
name fragments] }`). Tuya's free Trial plan must be renewed periodically at iot.tuya.com → Cloud → project.

## MPPT fault alerts

Each inverter card shows its MPPT strings. If one string reads ≤5 W while another on the same inverter
makes >100 W, the card turns red with a message. The `solar-relay` worker also checks every 5 minutes
(cron) and emails garyrollie@yahoo.com + mandimurph@yahoo.com via Brevo once the fault has persisted for
two checks, reminds every 6 h, and sends a recovery note. Worker secrets: `BREVO_KEY`, `ALERT_TO`,
`ALERT_FROM`; state lives in the `homeapp-state` KV namespace (bound as `STATE`, see
`relay/worker.js.meta.json`). Manual check: `/alerts/check?k=…` (add `&force` to email now);
`/alerts/test?k=…` sends a test email.

## Thermostats (ecobee now, Home Assistant later)

ecobee closed its developer API, so `relay/ecobee-worker.js` (`ecobee-relay`) signs in the way the ecobee web
portal does (Auth0 password grant with the portal's public client id; secrets `ECOBEE_USER`, `ECOBEE_PASSWORD`,
`RELAY_KEY`; token cached in KV) and reads the same API the portal reads. This is unofficial and may break if
ecobee changes its login; it is a stop-gap until a Home Assistant bridge at the house takes over.

### Climate data shape
The Thermostats tile renders whatever `GET <climateRelay>/thermostats?k=…` returns, so any source works if it
produces this JSON (a Home Assistant relay would map `climate.*` / `sensor.*` / `binary_sensor.*` into it):

```json
{ "at": "ISO time", "source": "ecobee | homeassistant",
  "thermostats": [ { "id": "…", "name": "Main Floor", "connected": true,
      "temp": 72.3, "humidity": 41, "heatSet": 68, "coolSet": 74, "mode": "auto|heat|cool|off", "fan": "auto|on",
      "running": ["compCool1", "fan"], "hold": { "name": "Away", "until": "2026-10-08 18:00" } | null, "climate": "Home",
      "outside": { "temp": 88, "condition": "Sunny" } | null,
      "sensors": [ { "id": "…", "name": "Front Door", "temp": null, "occupied": null, "open": false, "inUse": true } ] } ] }
```
`open` is the door/window state (null when the source doesn't know it — ecobee's API generally doesn't;
Home Assistant via HomeKit does). Temperatures are °F.

## Remaining tasks

- [x] **ecobee (stop-gap): live** since 2026-10-08 — 2-step verification turned off on the ecobee account (Auth0 client disallows every MFA grant), `ECOBEE_PASSWORD` set as a worker secret, refresh token held in KV. 4 thermostats + 4 remote sensors. ecobee's API returns **no door/window SmartSensors** — those still need the Home Assistant route.
- [ ] **ecobee (proper): Home Assistant bridge** — pick the box (Pi / mini PC / VM / HA Green), thermostat models +
      HomeKit setup codes (unpair from Apple Home first), remote access (Cloudflare Tunnel needs a domain; or
      DuckDNS + FortiGate VIP), room/sensor names. Then build `ha-relay` producing the climate shape and switch
      the Thermostats tile's `climateRelay` to it. Door/window SmartSensors only become visible on this route.
- [ ] **Vault logins still missing:** Garage Doors (myQ), Matic.
- [ ] **More batteries:** append new Virtual IDs to `batteries` on the Solar Assistant tile (per site).
- [ ] **Tuya trial plan:** renew at iot.tuya.com when the battery chips go blank.
