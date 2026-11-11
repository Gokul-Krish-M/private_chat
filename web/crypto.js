// Browser twin of src/crypto.js (WebCrypto). Same format, so CLI and web can read each other:
//   key     = PBKDF2-SHA256(passphrase, room.salt, 600k) -> AES-256-GCM
//   payload = base64( iv[12] || ciphertext || tag[16] )
// WebCrypto needs a secure context: https:// or http://localhost.
const ITERATIONS = 600_000;
const CHECK_VALUE = 'secret-chat:v1';
const te = new TextEncoder();
const td = new TextDecoder();

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const fromB64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

export const newSalt = () => toB64(crypto.getRandomValues(new Uint8Array(16)));

export async function deriveKey(passphrase, saltB64) {
  const base = await crypto.subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations: ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: the key can't be read back out of the browser
    ['encrypt', 'decrypt'],
  );
}

export async function encrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toB64(out);
}

/** Rejects if the key is wrong or the data was tampered with. */
export async function decrypt(key, b64) {
  const buf = fromB64(b64);
  if (buf.length < 28) throw new Error('Ciphertext too short.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12));
  return JSON.parse(td.decode(pt));
}

export const makeVerifier = (key) => encrypt(key, { check: CHECK_VALUE });

export async function verifyKey(key, verifier) {
  try {
    return (await decrypt(key, verifier)).check === CHECK_VALUE;
  } catch {
    return false;
  }
}
