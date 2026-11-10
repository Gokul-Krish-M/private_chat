import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * End-to-end encryption. The server only ever sees ciphertext.
 *
 *   key      = PBKDF2-SHA256(passphrase, room.salt, 600k iterations) -> 32 bytes
 *   payload  = base64( iv[12] || ciphertext || gcmTag[16] )   (AES-256-GCM)
 *
 * The layout matches WebCrypto's AES-GCM output (ciphertext||tag), so a browser
 * client can decrypt with crypto.subtle using the same parameters.
 */
const pbkdf2 = promisify(crypto.pbkdf2);
export const KDF_ITERATIONS = 600_000;
const CHECK_VALUE = 'secret-chat:v1';

export const newSalt = () => crypto.randomBytes(16).toString('base64');

export function deriveKey(passphrase, saltB64) {
  return pbkdf2(passphrase.normalize('NFKC'), Buffer.from(saltB64, 'base64'), KDF_ITERATIONS, 32, 'sha256');
}

export function encrypt(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
}

/** Throws if the key is wrong or the data was tampered with. */
export function decrypt(key, b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 12 + 16) throw new Error('Ciphertext too short.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  const pt = Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

/** Encrypted known value stored with the room, so clients can tell a wrong passphrase. */
export const makeVerifier = (key) => encrypt(key, { check: CHECK_VALUE });

export function verifyKey(key, verifier) {
  try {
    return decrypt(key, verifier).check === CHECK_VALUE;
  } catch {
    return false;
  }
}
