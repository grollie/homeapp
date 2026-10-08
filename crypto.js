// Shared crypto for Home Hub. Everything behind the login lives in vault.json,
// encrypted with a random content key (AES-256-GCM). Each family member's
// password (PBKDF2-SHA256) wraps a copy of that key, so every person has their
// own login and nobody without one can read the device list.
const HH = (() => {
  const ITER = 600000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  async function userId(name) {
    const h = await crypto.subtle.digest('SHA-256', enc.encode('homeapp:' + name.trim().toLowerCase()));
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function kek(password, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  const aesKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  async function seal(key, bytes) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return { iv: b64(iv), ct: b64(ct) };
  }
  const open = (key, box) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));

  // Returns the raw content key (Uint8Array) or throws on a bad login.
  async function unlockKey(vault, name, password) {
    const entry = vault.users[await userId(name)];
    if (!entry) throw new Error('bad login');
    const k = await kek(password, unb64(entry.salt), entry.iter || ITER);
    return new Uint8Array(await open(k, entry.key));
  }

  async function readData(vault, rawKey) {
    return JSON.parse(dec.decode(await open(await aesKey(rawKey), vault.data)));
  }

  async function wrapFor(rawKey, password) {
    const salt = rand(16);
    return { salt: b64(salt), iter: ITER, key: await seal(await kek(password, salt, ITER), rawKey) };
  }

  async function writeData(rawKey, data) {
    return seal(await aesKey(rawKey), enc.encode(JSON.stringify(data)));
  }

  // vault object -> the text of vault.js
  const vaultText = (v) => 'window.HH_VAULT = ' + JSON.stringify(v, null, 1) + ';\n';

  // Commit vault.js to GitHub with a fine-grained token (Contents: read & write).
  async function publishToGitHub(repo, token, text, message = 'Update vault.js') {
    const api = `https://api.github.com/repos/${repo}/contents/vault.js`;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
    const cur = await fetch(api, { headers });
    const sha = cur.ok ? (await cur.json()).sha : undefined;
    const bytes = enc.encode(text);
    const content = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
    const r = await fetch(api, { method: 'PUT', headers, body: JSON.stringify({ message, content, sha }) });
    if (!r.ok) throw new Error(`GitHub said ${r.status}: ${(await r.json().catch(() => ({}))).message || ''}`);
  }

  const download = (text) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/javascript' })); a.download = 'vault.js'; a.click();
  };

  return { b64, unb64, rand, userId, unlockKey, readData, wrapFor, writeData, vaultText, publishToGitHub, download, REPO: 'grollie/homeapp' };
})();
