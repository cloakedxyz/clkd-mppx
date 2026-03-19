#!/usr/bin/env node

/**
 * clkd-mppx CLI
 *
 * Setup and manage a Cloaked-backed mppx wallet for private agent payments.
 *
 * Usage:
 *   npx clkd-mppx setup       # Create Cloaked account, write mppx.config.ts
 *   npx clkd-mppx fund        # Show a payment address to fund the account
 *   npx clkd-mppx balance     # Check account balance
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { genKeys } from '@cloakedxyz/clkd-stealth/dist/client/genKeys.js';
import { HDKey } from '@scure/bip32';

const DEFAULT_API_URL = 'https://api.clkd.xyz/v1';

const command = process.argv[2];

switch (command) {
  case 'setup':
    await setup();
    break;
  case 'fund':
    await fund();
    break;
  case 'balance':
    await balance();
    break;
  default:
    console.log(`clkd-mppx — Private agent payments via Cloaked stealth addresses

Commands:
  setup     Create a Cloaked account and generate mppx.config.ts
  fund      Show a payment address to fund the account
  balance   Check account balance

After setup, your agent uses \`npx mppx <url>\` as normal — payments
route through Cloaked stealth addresses automatically.`);
    break;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function setup() {
  const apiUrl = process.env.CLKD_API_URL || DEFAULT_API_URL;
  const inviteCode = process.argv[3] || process.env.CLKD_INVITE_CODE;

  console.log('Generating stealth keys...');

  // 1. Generate keys using clkd-stealth
  const spendSecret = '0x' + crypto.randomBytes(32).toString('hex');
  const viewSecret = '0x' + crypto.randomBytes(32).toString('hex');
  const { p_spend, P_spend, p_view, P_view } = genKeys({ spendSecret, viewSecret });

  // Derive child viewing key
  const masterNode = HDKey.fromMasterSeed(Buffer.from(p_view.slice(2), 'hex'));
  const childNode = masterNode.derive('m/0');
  if (!childNode.privateKey) {
    throw new Error('Failed to derive child viewing node');
  }
  const child_p_view = '0x' + Buffer.from(childNode.privateKey).toString('hex');

  const spendAccount = privateKeyToAccount(p_spend as Hex);
  console.log(`  Spend address: ${spendAccount.address}`);

  // 2. Get SIWE nonce
  console.log('Authenticating...');
  const nonceRes = await fetch(`${apiUrl}/nonce?address=${spendAccount.address}`);
  if (!nonceRes.ok) throw new Error(`Failed to get nonce: ${nonceRes.statusText}`);
  const nonce = await nonceRes.text();

  // 3. Sign SIWE message
  // SIWE domain must be the app domain, not the API domain
  const apiHostname = new URL(apiUrl).hostname;
  const domain = apiHostname.replace('api-stg.', 'app-stg.').replace('api.', 'app.');
  const issuedAt = new Date().toISOString();
  const siweMessage = [
    `${domain} wants you to sign in with your Ethereum account:`,
    spendAccount.address,
    '',
    'Sign in to Cloaked',
    '',
    `URI: ${apiUrl}`,
    'Version: 1',
    `Chain ID: 1`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');

  const signature = await spendAccount.signMessage({ message: siweMessage });

  const verifyRes = await fetch(`${apiUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: siweMessage, signature }),
  });

  if (!verifyRes.ok) throw new Error(`SIWE verification failed: ${verifyRes.statusText}`);
  const { token, accountId: existingAccountId } = await verifyRes.json() as {
    token: string;
    accountId: string | null;
  };

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  let accountId = existingAccountId;

  if (!accountId) {
    // 4. Get HPKE public key and encrypt
    console.log('Registering account...');
    // Dynamic import — works when @cloakedxyz/clkd-sdk-client is installed or when
    // running from the monorepo with the built dist available.
    let fetchHpkePublicKey: (url: string) => Promise<Uint8Array>;
    let hpkeEncrypt: (plaintext: Uint8Array, key: Uint8Array) => { ciphertext: string; encapsulatedKey: string };
    try {
      const hpke = await import('@cloakedxyz/clkd-sdk-client/hpke' as string);
      fetchHpkePublicKey = hpke.fetchHpkePublicKey;
      hpkeEncrypt = hpke.hpkeEncrypt;
    } catch {
      // Fallback: try monorepo path
      const hpke = await import('/Users/oliviabarnett/Code/cloaked/sdk-client/dist/hpke.js' as string);
      fetchHpkePublicKey = hpke.fetchHpkePublicKey;
      hpkeEncrypt = hpke.hpkeEncrypt;
    }

    const serverPubKey = await fetchHpkePublicKey(apiUrl);
    const payload = new TextEncoder().encode(JSON.stringify({ P_spend, P_view, child_p_view }));
    const { ciphertext, encapsulatedKey } = hpkeEncrypt(payload, serverPubKey);

    const registerRes = await fetch(`${apiUrl}/accounts/`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        ciphertext,
        encapsulatedKey,
        ...(inviteCode && { inviteCode }),
      }),
    });

    if (!registerRes.ok) {
      const err = await registerRes.json().catch(() => ({}));
      throw new Error(`Registration failed: ${(err as { message?: string }).message || registerRes.statusText}`);
    }

    const registerData = await registerRes.json() as { accountId: string };
    accountId = registerData.accountId;
    console.log(`  Account created: ${accountId}`);
  } else {
    console.log(`  Account exists: ${accountId}`);
  }

  // 6. Write mppx.config.ts
  const configContent = `// Generated by clkd-mppx setup
import { defineConfig } from 'mppx/cli'
import { charge } from 'clkd-mppx'

export default defineConfig({
  methods: [
    charge({
      pSpend: process.env.CLKD_P_SPEND as \`0x\${string}\`,
      childPView: process.env.CLKD_CHILD_P_VIEW as \`0x\${string}\`,
      accountId: process.env.CLKD_ACCOUNT_ID!,
      apiKey: process.env.CLKD_API_KEY!,
    }),
  ],
})
`;

  fs.writeFileSync('mppx.config.ts', configContent);
  console.log('  Wrote mppx.config.ts');

  // 7. Write .env
  const envContent = `CLKD_P_SPEND=${p_spend}
CLKD_CHILD_P_VIEW=${child_p_view}
CLKD_ACCOUNT_ID=${accountId}
CLKD_API_KEY=${token}
`;

  fs.writeFileSync('.env.clkd', envContent);
  console.log('  Wrote .env.clkd');

  console.log(`
Setup complete. Next steps:

  1. Fund your account:
     npx clkd-mppx fund

  2. Source your env and use mppx as normal:
     source .env.clkd
     npx mppx https://some-mpp-service.com/api
`);
}

async function fund() {
  const apiUrl = process.env.CLKD_API_URL || DEFAULT_API_URL;
  const accountId = process.env.CLKD_ACCOUNT_ID;
  const apiKey = process.env.CLKD_API_KEY;

  if (!accountId || !apiKey) {
    console.error('Missing CLKD_ACCOUNT_ID or CLKD_API_KEY. Run `npx clkd-mppx setup` first.');
    process.exit(1);
  }

  const res = await fetch(`${apiUrl}/accounts/${accountId}/payment-address`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ chainId: 42431 }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Failed to generate address: ${(err as { message?: string }).message || res.statusText}`);
  }

  const { address } = await res.json() as { address: string };

  console.log(`Send pathUSD (or any TIP-20 token) on Tempo to:

  ${address}

This is a one-time stealth address. After funding, run:
  npx mppx <url>
`);
}

async function balance() {
  const apiUrl = process.env.CLKD_API_URL || DEFAULT_API_URL;
  const accountId = process.env.CLKD_ACCOUNT_ID;
  const apiKey = process.env.CLKD_API_KEY;

  if (!accountId || !apiKey) {
    console.error('Missing CLKD_ACCOUNT_ID or CLKD_API_KEY. Run `npx clkd-mppx setup` first.');
    process.exit(1);
  }

  const res = await fetch(`${apiUrl}/accounts/${accountId}/balance/42431`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Failed to get balance: ${(err as { message?: string }).message || res.statusText}`);
  }

  const data = await res.json() as { balances: Array<{ token: string; symbol: string; available: string; decimals: number }> };

  if (!data.balances || data.balances.length === 0) {
    console.log('No balances on Tempo. Fund your account with `npx clkd-mppx fund`.');
    return;
  }

  console.log('Tempo balances:');
  for (const b of data.balances) {
    const amount = (Number(b.available) / 10 ** b.decimals).toFixed(2);
    console.log(`  ${b.symbol}: ${amount}`);
  }
}
