'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { validateLicence, signLicence } = require('../src/licence');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub  = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
const NOW  = new Date(2026, 10, 15).getTime();

test('accepts a key signed with the matching private key', () => {
  const key = signLicence('TEAM', '202712', priv);
  const r = validateLicence(key, { publicKey: pub, now: NOW });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.tier, 'team');
});

test('rejects keys whose tier or expiry was edited', () => {
  const sig = signLicence('TEAM', '202712', priv).split('-').slice(3).join('-');
  assert.strictEqual(validateLicence(`MAVT-ENT-202712-${sig}`, { publicKey: pub, now: NOW }).valid, false);
  assert.strictEqual(validateLicence(`MAVT-TEAM-209912-${sig}`, { publicKey: pub, now: NOW }).valid, false);
});

test('rejects keys signed by a different private key', () => {
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.strictEqual(validateLicence(signLicence('ENT', '202712', other), { publicKey: pub, now: NOW }).valid, false);
});

test('rejects old HMAC-format keys forged with the previously public secret', () => {
  const hmac8 = crypto.createHmac('sha256', 'mavt-licence-v1').update('TEAM202712').digest('hex').slice(0, 8);
  assert.strictEqual(validateLicence(`MAVT-TEAM-202712-${hmac8}`, { now: NOW }).valid, false);
});

test('rejects expired keys', () => {
  const r = validateLicence(signLicence('SOLO', '202601', priv), { publicKey: pub, now: NOW });
  assert.deepStrictEqual(r, { valid: false, reason: 'expired' });
});

test('rejects malformed input', () => {
  for (const k of [null, '', 'garbage', 'MAVT-TEAM', 'MAVT-BOGUS-202712-abc', 'MAVT-TEAM-2027-abc']) {
    assert.strictEqual(validateLicence(k, { publicKey: pub, now: NOW }).valid, false, String(k));
  }
});
