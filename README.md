# clkd-mppx

Private agent payments via [Cloaked](https://clkd.xyz) stealth addresses on [Tempo](https://tempo.xyz).

Drop-in privacy layer for [mppx](https://mpp.dev). Your agent pays for MPP services from rotating stealth addresses — each payment comes from a different on-chain identity.

## Quick Start

```bash
# 1. Setup — creates Cloaked account, writes mppx.config.ts
npx clkd-mppx setup

# 2. Fund — get a stealth address to send tokens to
source .env.clkd
npx clkd-mppx fund

# 3. Use mppx as normal — payments route through Cloaked automatically
npx mppx https://parallelmpp.dev/api/search --method POST -J '{"query":"hello"}'
```

## How It Works

`clkd-mppx` provides a Cloaked-backed implementation of the `tempo.charge` method for mppx. When your agent hits a 402 payment challenge:

1. **mppx** parses the challenge (amount, recipient, token)
2. **clkd-mppx** calls Cloaked's quote API to select spendables (funds at stealth addresses)
3. **clkd-mppx** derives stealth signing keys and signs the transaction locally (self-custodial)
4. **clkd-mppx** submits to Cloaked for relay
5. **mppx** retries the request with the payment credential

The agent doesn't know Cloaked is involved. It just runs `npx mppx <url>`.

## Manual Setup

If you prefer to configure manually instead of using the CLI:

**1. Install:**
```bash
npm install clkd-mppx mppx
```

**2. Create `mppx.config.ts`:**
```typescript
import { defineConfig } from 'mppx/cli'
import { charge } from 'clkd-mppx'

export default defineConfig({
  methods: [
    charge({
      pSpend: process.env.CLKD_P_SPEND as `0x${string}`,
      pView: process.env.CLKD_P_VIEW as `0x${string}`,
      accountId: process.env.CLKD_ACCOUNT_ID!,
      apiKey: process.env.CLKD_API_KEY!,
    }),
  ],
})
```

**3. Set environment variables and use mppx:**
```bash
npx mppx https://some-mpp-service.com/api
```

## Programmatic Usage

```typescript
import { Mppx } from 'mppx/client'
import { charge } from 'clkd-mppx'

const client = Mppx.create({
  methods: [
    charge({
      pSpend: '0x...',
      pView: '0x...',
      accountId: 'clkd_acct_...',
      apiKey: 'clkd_...',
    }),
  ],
})

const response = await client.fetch('https://paid-api.example.com/resource')
```

## Commands

| Command | Description |
|---------|-------------|
| `npx clkd-mppx setup` | Generate stealth keys, register with Cloaked, write config files |
| `npx clkd-mppx fund` | Generate a payment address to fund the account |
| `npx clkd-mppx balance` | Check Tempo balance |

## License

MIT
