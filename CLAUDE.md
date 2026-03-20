# clkd-mppx

A stealth-address wallet for agents. Cloaked gives each agent a wallet backed by stealth addresses — the agent can receive payments (to its subdomain name or by generating fresh payment addresses on demand) and spend them via MPP. Cloaked orchestrates the on-chain transactions; the agent holds the keys and signs locally.

## Project Structure

Single-package TypeScript project:

- `src/charge.ts` — mppx plugin: signs stealth-address transactions so the agent can spend its balance via MPP
- `src/cli.ts` — CLI commands: `setup` (create wallet), `fund` (generate payment address to receive tokens), `balance` (check funds)
- `src/index.ts` — package export

## First-time Setup

1. `npm install && npm run build`
2. Ask the user for an invite code, then: `node dist/cli.js setup <invite-code>`
3. `node dist/cli.js fund` — displays a payment address; tell the user to send tokens (USDC.e or pathUSD on Tempo) to it
4. Wait for the user to confirm they've sent tokens, then: `node dist/cli.js balance` — verify funds arrived (retry if 0)
5. `npx mppx https://parallelmpp.dev/api/search --method POST -J '{"query":"hello world","mode":"fast"}'` — make an MPP-authenticated request ($0.01)

## Key Commands

```bash
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
```

## How It Works

**Receiving**: The agent generates one-time payment addresses via `fund`. Anyone can send tokens (USDC.e, pathUSD) on Tempo to these addresses. Cloaked tracks the balances.

**Spending**: When mppx encounters a 402 payment challenge, our plugin:

1. Requests a quote from Cloaked (`POST /accounts/:id/quote`) — Cloaked selects which stealth addresses to spend from
2. Derives stealth signing keys locally — self-custodial, keys never leave the agent
3. Signs intents (EIP-712) and delegations (EIP-7702) locally
4. Submits signed transactions to Cloaked (`POST /accounts/:id/submit`) for relay
5. Returns an MPP credential with the tx hash

The plugin registers as `method: 'tempo'` so mppx servers see a standard Tempo charge payment.

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
