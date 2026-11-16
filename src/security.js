'use strict';
// Encryption at rest for stored trace data (AES-256-GCM).
//
// Set VISIBILITY_ENCRYPTION_KEY to 64 hex characters (32 bytes) — generate one with
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// With a key set, event payloads (prompts, responses, tool inputs/outputs, memory values) are
// encrypted before they reach SQLite. Run goals and agent names stay in plain text so that run
// search keeps working. Losing the key means losing the stored events.
const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function parseKey(hex) {
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('VISIBILITY_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function generateKey() { return crypto.randomBytes(32).toString('hex'); }

function isEncrypted(text) { return typeof text === 'string' && text.startsWith(PREFIX); }

// plaintext string → "enc:v1:<iv>:<tag>:<ciphertext>" (base64 parts). A fresh IV per call.
function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), ct].map(b => b.toString('base64')).join(':');
}

// Throws when the key is missing, wrong, or the data was tampered with — never returns garbage.
function decrypt(key, text) {
  if (!isEncrypted(text)) return text;
  if (!key) throw new Error('Stored data is encrypted; set VISIBILITY_ENCRYPTION_KEY to read it');
  const parts = text.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted record');
  const [iv, tag, ct] = parts.map(p => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (_) {
    throw new Error('Could not decrypt stored data (wrong VISIBILITY_ENCRYPTION_KEY or corrupted record)');
  }
}

module.exports = { parseKey, generateKey, isEncrypted, encrypt, decrypt };
