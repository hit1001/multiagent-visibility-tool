#!/usr/bin/env node
/**
 * sign-licence — issue an agent-visibility licence key (maintainers only)
 *
 * Usage:
 *   node scripts/sign-licence.js TEAM 202712
 *   MAVT_LICENCE_PRIVATE_KEY=/path/key.pem node scripts/sign-licence.js ENT 202801
 *
 * The private key defaults to ~/.agentscope/licence-signing-key.pem and must never be committed.
 */
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { signLicence, validateLicence, TIERS } = require('../src/licence');

const [tier, expiry] = process.argv.slice(2);
if (!tier || !expiry) {
  console.error(`Usage: sign-licence <${[...TIERS].join('|')}> <YYYYMM>`);
  process.exit(1);
}
const keyPath = process.env.MAVT_LICENCE_PRIVATE_KEY || path.join(os.homedir(), '.agentscope', 'licence-signing-key.pem');
const key = signLicence(tier.toUpperCase(), expiry, fs.readFileSync(keyPath, 'utf8'));
if (!validateLicence(key).valid) { console.error('Signed key failed verification (wrong private key or already expired?)'); process.exit(1); }
console.log(key);
