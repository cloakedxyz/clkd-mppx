# clkd-mppx

Private agent payments via [Cloaked](https://clkd.xyz) stealth addresses on [Tempo](https://tempo.xyz).

Drop-in privacy layer for [mppx](https://mpp.dev). Your agent gets an ENS identity (`agent.clkd.eth`), can receive payments to fresh stealth addresses, and sends from them — no static wallet address exposed on-chain.

## Quick Start

```bash
# Clone and install
git clone https://github.com/cloakedxyz/clkd-mppx.git
cd clkd-mppx
npm install

# 1. Setup — creates a Cloaked account, writes mppx.config.ts and .env.clkd
npx tsx src/cli.ts setup <invite-code>

# 2. Fund — generates a stealth address to send tokens to
source .env.clkd
npx tsx src/cli.ts fund
# Send pathUSD on Tempo Moderato to the address shown

# 3. Check balance
source .env.clkd
npx tsx src/cli.ts balance

# 4. Use mppx as normal — payments route through Cloaked automatically
source .env.clkd
npx mppx https://mpp.dev/api/ping/paid
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
      childPView: process.env.CLKD_CHILD_P_VIEW as `0x${string}`,
      accountId: process.env.CLKD_ACCOUNT_ID!,
      apiKey: process.env.CLKD_API_KEY!,
    }),
  ],
})
```

**3. Set environment variables and use mppx:**
```bash
source .env.clkd
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
      childPView: '0x...',
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
| `npx tsx src/cli.ts setup <invite-code>` | Generate stealth keys, register with Cloaked, write config files |
| `npx tsx src/cli.ts fund` | Generate a payment address to fund the account |
| `npx tsx src/cli.ts balance` | Check Tempo balance |

## Environment Variables

After `setup`, credentials are written to `.env.clkd`. Source it before running other commands:

| Variable | Description |
|----------|-------------|
| `CLKD_P_SPEND` | Stealth spending private key (hex) |
| `CLKD_CHILD_P_VIEW` | Child viewing private key (hex) |
| `CLKD_ACCOUNT_ID` | Cloaked account ID |
| `CLKD_API_KEY` | JWT token for Cloaked API |

## License

MIT
