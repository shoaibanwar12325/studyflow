/**
 * StudyFlow – crypto.js
 * Client-side encryption with the Web Crypto API (no third-party libraries).
 *  - Key derivation: PBKDF2-HMAC-SHA256, 310,000 iterations, 128-bit random salt.
 *  - Encryption:     AES-256-GCM, fresh 96-bit IV for every write (authenticated encryption).
 * The password is never stored. A wrong password fails GCM authentication, which is how
 * the unlock screen verifies it.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
export const PBKDF2_ITERATIONS = 310000;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Web Crypto is unavailable – the app must be served over HTTPS or localhost.');
  return s;
};

export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) globalThis.crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536))); // API limit: 64 KB per call
  return out;
}

export function toB64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i += 0x8000) bin += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Derive a non-extractable AES-GCM key from the password. */
export async function deriveKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  const material = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptBytes(key, bytes) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function decryptBytes(key, payload) {
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(payload.iv) }, key, fromB64(payload.ct));
  return new Uint8Array(pt);
}

export async function encryptJSON(key, obj) {
  return encryptBytes(key, enc.encode(JSON.stringify(obj)));
}

export async function decryptJSON(key, payload) {
  return JSON.parse(dec.decode(await decryptBytes(key, payload)));
}

/** Create a brand-new vault (salt + encrypted state) for sign-up. */
export async function createVault(password, state) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  const data = await encryptJSON(key, state);
  return { key, vault: { v: 1, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toB64(salt), data } };
}

/** Unlock an existing vault. Throws 'WRONG_PASSWORD' if authentication fails. */
export async function openVault(password, vault) {
  const key = await deriveKey(password, fromB64(vault.salt), vault.iterations || PBKDF2_ITERATIONS);
  try {
    const state = await decryptJSON(key, vault.data);
    return { key, state };
  } catch {
    throw new Error('WRONG_PASSWORD');
  }
}

export async function sealVault(key, vault, state) {
  return { ...vault, data: await encryptJSON(key, state), updatedAt: Date.now() };
}
