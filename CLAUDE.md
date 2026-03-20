# clkd-mppx

Privacy-preserving MPP payments via Cloaked stealth addresses.

## Project Structure

Single-package TypeScript project:

- `src/charge.ts` — mppx adapter: Cloaked-backed `createCredential` that replaces `tempo.charge()` on the client side
- `src/cli.ts` — CLI commands: `setup`, `fund`, `balance`
- `src/index.ts` — package export

## First-time Setup

1. `npm install && npm run build`
2. Ask the user for an invite code, then: `node dist/cli.js setup <invite-code>`
3. `node dist/cli.js fund` — displays a payment address; user sends tokens to it
4. `node dist/cli.js balance` — verify funds arrived
5. `npx mppx https://parallelmpp.dev/api/search --method POST -J '{"query":"hello world","mode":"fast"}'` — make an MPP-authenticated request

## Key Commands

```bash
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
```

## How It Works

This package provides a drop-in replacement for mppx's `tempo.charge()` client method. When mppx encounters a 402 challenge:

1. Our `createCredential` calls Cloaked's `POST /accounts/:id/quote` with the challenge's amount/recipient/token
2. Derives stealth signing keys using `deriveStealthSigningKey(pSpend, childPView, derivationNonce)` for each intent
3. Signs intents (EIP-712) and delegations (EIP-7702) locally — self-custodial, keys never leave the client
4. Submits to Cloaked's `POST /accounts/:id/submit` for relay
5. Returns an MPP credential with the tx hash (type: "hash")

The returned object has `name: 'tempo'` and `intent: 'charge'` so mppx treats it as a standard tempo charge method.

## Dependencies

- `viem` — Ethereum/Tempo transaction building, signing
- `@cloakedxyz/clkd-stealth` — stealth key derivation (public npm package)
- `mppx` — peer dependency, the agent already has this

## Integration Points

- **mppx config**: users create `mppx.config.ts` using `defineConfig({ plugins: [plugin(...)] })` from `mppx/cli`
- **mppx CLI plugin resolution**: `src/cli/internal.ts` in mppx checks **config plugins → builtin plugins → config methods**, in that order. We MUST register as a `plugin` (not a `method`) because we share the `tempo` method name with mppx's built-in tempo plugin — if we used `methods`, the builtin would always win.
- **Cloaked API**: `POST /accounts/:id/quote` and `POST /accounts/:id/submit` — standard Cloaked send flow

## Cloaked API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /nonce?address=` | SIWE nonce for auth |
| `POST /verify` | SIWE verification, returns JWT |
| `GET /.well-known/hpke-public-key` | Server's HPKE key for registration |
| `POST /accounts/` | Register new account |
| `POST /accounts/:id/payment-address` | Generate stealth receive address (fund command) |
| `GET /accounts/:id/balance/:chainId` | Check balances |
| `POST /accounts/:id/quote` | Create send quote (selects spendables) |
| `POST /accounts/:id/submit` | Submit signed intents for relay |

## Formatting

Prettier: single quotes, trailing commas, 2-space indent.
