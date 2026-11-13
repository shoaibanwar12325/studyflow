// Security tests for js/crypto.js (Web Crypto is built into Node ≥ 19).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../../js/crypto.js';

const state = { tasks: [{ id: 't1', title: 'Secret dissertation idea' }], profile: { name: 'Sam' } };

describe('encrypted vault', () => {
  test('round-trips data with the correct password', async () => {
    const { vault } = await v.createVault('correct horse battery', state);
    const { state: out } = await v.openVault('correct horse battery', vault);
    assert.deepEqual(out, state);
  });

  test('rejects the wrong password (AES-GCM authentication fails)', async () => {
    const { vault } = await v.createVault('correct horse battery', state);
    await assert.rejects(v.openVault('wrong password!', vault), /WRONG_PASSWORD/);
  });

  test('stored vault never contains plaintext or the password', async () => {
    const { vault } = await v.createVault('correct horse battery', state);
    const stored = JSON.stringify(vault);
    assert.ok(!stored.includes('Secret dissertation'));
    assert.ok(!stored.includes('Sam'));
    assert.ok(!stored.includes('correct horse'));
    assert.equal(vault.kdf, 'PBKDF2-SHA256');
    assert.ok(vault.iterations >= 310000);
  });

  test('uses a fresh salt per vault and a fresh IV per write', async () => {
    const a = await v.createVault('same password', state);
    const b = await v.createVault('same password', state);
    assert.notEqual(a.vault.salt, b.vault.salt);
    assert.notEqual(a.vault.data.ct, b.vault.data.ct);
    const sealed1 = await v.sealVault(a.key, a.vault, state);
    const sealed2 = await v.sealVault(a.key, a.vault, state);
    assert.notEqual(sealed1.data.iv, sealed2.data.iv);
    assert.notEqual(sealed1.data.ct, sealed2.data.ct);
  });

  test('tampering with the ciphertext is detected', async () => {
    const { vault } = await v.createVault('pw-12345678', state);
    const bytes = v.fromB64(vault.data.ct);
    bytes[0] ^= 0xff;
    const tampered = { ...vault, data: { ...vault.data, ct: v.toB64(bytes) } };
    await assert.rejects(v.openVault('pw-12345678', tampered), /WRONG_PASSWORD/);
  });

  test('binary (photo) encryption round-trip', async () => {
    const { key } = await v.createVault('pw-12345678', state);
    const img = v.randomBytes(200000);
    const enc = await v.encryptBytes(key, img);
    const dec = await v.decryptBytes(key, enc);
    assert.deepEqual(dec, img);
  });

  test('derived key is not extractable', async () => {
    const { key } = await v.createVault('pw-12345678', state);
    assert.equal(key.extractable, false);
    assert.equal(key.algorithm.name, 'AES-GCM');
    assert.equal(key.algorithm.length, 256);
  });

  test('base64 helpers handle large buffers', () => {
    const big = v.randomBytes(300000);
    assert.deepEqual(v.fromB64(v.toB64(big)), big);
  });
});
