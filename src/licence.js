'use strict';
const crypto = require('crypto');

// Licence keys are Ed25519-signed: MAVT-<TIER>-<YYYYMM>-<base64url signature over "MAVT|TIER|YYYYMM">.
// Only the public key ships; keys are issued with scripts/sign-licence.js and the private key.
const PUBLIC_KEY_DER = 'MCowBQYDK2VwAyEAkj9kMPNp8HzxJ5yfQsE/viSnw7vHaUACpF8DZpGqOqY=';
const TIERS = new Set(['SOLO', 'TEAM', 'ENT']);

function payload(tier, expiry) { return `MAVT|${tier}|${expiry}`; }

function validateLicence(key, { publicKey = PUBLIC_KEY_DER, now = Date.now() } = {}) {
  if (!key) return { valid: false };
  try {
    const parts = key.trim().split('-');
    if (parts.length < 4 || parts[0] !== 'MAVT') return { valid: false };
    const tier   = parts[1];
    const expiry = parts[2];
    const sig    = parts.slice(3).join('-'); // base64url may itself contain '-'
    if (!TIERS.has(tier) || !/^\d{6}$/.test(expiry)) return { valid: false };
    const pub = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, Buffer.from(payload(tier, expiry)), pub, Buffer.from(sig, 'base64url'))) return { valid: false };
    const year = parseInt(expiry.slice(0, 4)), month = parseInt(expiry.slice(4, 6));
    const expires = new Date(year, month - 1, 1); // first of expiry month
    if (now > expires.getTime()) return { valid: false, reason: 'expired' };
    return { valid: true, tier: tier.toLowerCase(), expires };
  } catch { return { valid: false }; }
}

function signLicence(tier, expiry, privateKeyPem) {
  if (!TIERS.has(tier)) throw new Error(`Unknown tier ${tier} (expected ${[...TIERS].join(', ')})`);
  if (!/^\d{6}$/.test(expiry)) throw new Error('Expiry must be YYYYMM');
  const sig = crypto.sign(null, Buffer.from(payload(tier, expiry)), crypto.createPrivateKey(privateKeyPem));
  return `MAVT-${tier}-${expiry}-${sig.toString('base64url')}`;
}

module.exports = { validateLicence, signLicence, TIERS };
