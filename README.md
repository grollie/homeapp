# Home Hub

One password-protected page for every smart device in the house: Solar Assistant (×2),
Smart Life batteries, Starlink, Ecobee, Nest, myQ garage doors, First Alert,
FortiRecorder, FortiCamera Cloud, Rachio, Whisker and Matic.

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
4. Put `vault.js` in this repo next to `index.html` and commit/push
   (on github.com: **Add file → Upload files**).

To change passwords or devices later, open setup.html, use **Edit an existing vault** with
your `vault.js` and your own login, make changes, download and commit again.

## Which devices open inside the page

| Device | Inside the page? | Why |
|---|---|---|
| Solar Assistant ×2, FortiRecorder | Yes (on home Wi-Fi / VPN) | Local web pages |
| Ecobee, Nest, Rachio, Starlink, FortiCamera Cloud, Smart Life | New tab | Those sites block being embedded |
| myQ, First Alert, Whisker, Matic | App only | No web portal exists; tile links to the vendor site |

Local devices only load when you're on the home network or connected to the home VPN.

## Local testing

`powershell -File serve.ps1` then open <http://localhost:8787>.
