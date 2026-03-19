/**
 * Cloaked payment method adapter for mppx.
 *
 * Drop-in replacement for `tempo.charge()` on the mppx client side.
 * Routes payments through Cloaked's stealth address infrastructure
 * instead of signing with a static wallet.
 *
 * @example
 * ```ts
 * // mppx.config.ts
 * import { defineConfig } from 'mppx/cli'
 * import { charge } from 'clkd-mppx'
 *
 * export default defineConfig({
 *   methods: [
 *     charge({
 *       pSpend: process.env.CLKD_P_SPEND as `0x${string}`,
 *       pView: process.env.CLKD_P_VIEW as `0x${string}`,
 *       accountId: process.env.CLKD_ACCOUNT_ID!,
 *       apiKey: process.env.CLKD_API_KEY!,
 *     }),
 *   ],
 * })
 * ```
 */

import {
  bytesToHex,
  hexToBytes,
  decodeAbiParameters,
  parseAbiParameters,
  type Hex,
} from 'viem';
import { HDKey, privateKeyToAccount } from 'viem/accounts';
import { deriveChildViewingNode } from '@cloakedxyz/clkd-stealth';
import { deriveDeterministicEphemeralKey } from '@cloakedxyz/clkd-stealth/dist/shared/deriveDeterministicEphemeralKey.js';
import { genStealthPrivateKey } from '@cloakedxyz/clkd-stealth/dist/client/genStealthPrivateKey.js';

// ---------------------------------------------------------------------------
// Types (Cloaked API request/response shapes)
// ---------------------------------------------------------------------------

interface Intent {
  chainId: number;
  eoa: string;
  executionData: string;
  nonce: string;
  derivationNonce: string;
  payer: string;
  paymentToken: string;
  paymentMaxAmount: string;
  combinedGas: string;
  encodedPreCalls: string[];
  encodedFundTransfers: string[];
  settler: string;
  expiry: string;
  isMultichain: boolean;
  funder: string;
  funderSignature: string;
  settlerContext: string;
  paymentAmount: string;
  paymentRecipient: string;
  paymentSignature: string;
  supportedAccountImplementation: string;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: {
    Intent: Array<{ name: string; type: string }>;
    Call: Array<{ name: string; type: string }>;
  };
  primaryType: 'Intent';
}

interface Delegation {
  chainId: number;
  address: string;
  contractAddress: string;
  derivationNonce: number;
  authorizationNonce: number;
}

interface QuoteResponse {
  intents: Intent[];
  delegations: Delegation[];
  quoteId: string;
  expiresAt: string;
  resolvedDestination: string;
}

interface SubmitTransactionResponse {
  success: boolean;
  quoteId?: string;
  txHash?: string;
  status?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Stealth key derivation
// ---------------------------------------------------------------------------

function deriveStealthSigningKey(
  p_spend: Hex | string,
  p_view: Hex | string,
  derivationNonce: bigint,
): { p_stealth: Hex; stealthAddress: Hex } {
  const child_p_view_hdkey = deriveChildViewingNode(p_view as Hex);
  if (!child_p_view_hdkey.privateKey) {
    throw new Error('Failed to derive child viewing node private key');
  }

  const child_p_view_hex = bytesToHex(child_p_view_hdkey.privateKey);
  const childViewingNode = HDKey.fromMasterSeed(hexToBytes(child_p_view_hex));

  const { p_derived } = deriveDeterministicEphemeralKey(childViewingNode, derivationNonce);

  const account = privateKeyToAccount(p_derived as Hex);
  const P_derived = account.publicKey;

  const { p_stealth } = genStealthPrivateKey({
    p_spend: p_spend as Hex,
    P_derived: P_derived as Hex,
  });

  const stealthAccount = privateKeyToAccount(p_stealth as Hex);

  return {
    p_stealth: p_stealth as Hex,
    stealthAddress: stealthAccount.address,
  };
}

async function signIntentEip712(p_stealth: Hex, intent: Intent): Promise<Hex> {
  const stealthAccount = privateKeyToAccount(p_stealth);

  const calls = decodeAbiParameters(
    parseAbiParameters('(address to, uint256 value, bytes data)[]'),
    intent.executionData as Hex,
  )[0] as Array<{ to: Hex; value: bigint; data: Hex }>;

  const domain = {
    name: intent.domain.name,
    version: intent.domain.version,
    chainId: intent.domain.chainId,
    verifyingContract: intent.domain.verifyingContract as Hex,
  };

  const message = {
    multichain: intent.isMultichain,
    eoa: intent.eoa as Hex,
    calls,
    nonce: BigInt(intent.nonce),
    payer: intent.payer as Hex,
    paymentToken: intent.paymentToken as Hex,
    paymentMaxAmount: BigInt(intent.paymentMaxAmount),
    combinedGas: BigInt(intent.combinedGas),
    encodedPreCalls: intent.encodedPreCalls as Hex[],
    encodedFundTransfers: intent.encodedFundTransfers as Hex[],
    settler: intent.settler as Hex,
    expiry: BigInt(intent.expiry),
  };

  const rawSignature = await stealthAccount.signTypedData({
    domain,
    types: intent.types,
    primaryType: 'Intent',
    message,
  });

  if (rawSignature.length !== 132) {
    throw new Error(`Unexpected signature length: ${rawSignature.length} (expected 132)`);
  }

  return rawSignature;
}

// ---------------------------------------------------------------------------
// MPP challenge type
// ---------------------------------------------------------------------------

interface Challenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  request: {
    amount: string;
    currency: string;
    recipient?: string;
    methodDetails?: {
      chainId?: number;
      feePayer?: boolean;
      memo?: string;
    };
  };
  expires?: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface ChargeParameters {
  /** Stealth spending private key (hex). */
  pSpend: Hex;
  /** Stealth viewing private key (hex). */
  pView: Hex;
  /** Cloaked account ID. */
  accountId: string;
  /** Cloaked API key or JWT token. */
  apiKey: string;
  /** Cloaked API base URL. @default 'https://api.clkd.xyz/v1' */
  apiUrl?: string;
  /** Tempo chain ID. @default 42431 */
  chainId?: number;
  /** Token decimals. @default 6 */
  decimals?: number;
}

/**
 * Creates a Cloaked-backed charge method for mppx.
 *
 * Uses the `tempo` method name and `charge` intent so it's wire-compatible
 * with any mppx server running `tempo.charge()`. The difference is that
 * payment is routed through Cloaked: the quote endpoint selects spendables,
 * the agent signs with derived stealth keys, and Cloaked relays the
 * transaction — resulting in payments from unlinkable stealth addresses.
 */
export function charge(parameters: ChargeParameters) {
  const {
    pSpend,
    pView,
    accountId,
    apiKey,
    apiUrl = 'https://api.clkd.xyz/v1',
    chainId = 42431,
    decimals = 6,
  } = parameters;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  return {
    name: 'tempo' as const,
    intent: 'charge' as const,

    async createCredential({ challenge }: { challenge: Challenge }): Promise<string> {
      const { amount, currency, recipient } = challenge.request;

      if (!recipient) {
        throw new Error('Challenge missing recipient address');
      }

      // 1. Get a quote from Cloaked — selects spendables to cover the amount
      const quote = await fetchJson<QuoteResponse>(
        `${apiUrl}/accounts/${accountId}/quote`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            type: 'send',
            chainId,
            token: currency,
            amount,
            decimals,
            destinationAddress: recipient,
          }),
        },
      );

      // 2. Sign each intent with the derived stealth key
      const signedIntents = await Promise.all(
        quote.intents.map(async (intent) => {
          const { p_stealth, stealthAddress } = deriveStealthSigningKey(
            pSpend,
            pView,
            BigInt(intent.derivationNonce),
          );

          if (stealthAddress.toLowerCase() !== intent.eoa.toLowerCase()) {
            throw new Error(
              `Derived stealth address ${stealthAddress} does not match intent EOA ${intent.eoa}`,
            );
          }

          const signature = await signIntentEip712(p_stealth, intent);
          return { ...intent, signature };
        }),
      );

      // 3. Sign delegations (EIP-7702 authorizations)
      const signedDelegations = await Promise.all(
        quote.delegations.map(async (delegation) => {
          const { p_stealth } = deriveStealthSigningKey(
            pSpend,
            pView,
            BigInt(delegation.derivationNonce),
          );

          const account = privateKeyToAccount(p_stealth);
          const authorization = await account.signAuthorization({
            contractAddress: delegation.contractAddress as Hex,
            chainId: delegation.chainId,
            nonce: delegation.authorizationNonce,
          });

          return { ...delegation, signature: authorization };
        }),
      );

      // 4. Submit to Cloaked for relay
      const result = await fetchJson<SubmitTransactionResponse>(
        `${apiUrl}/accounts/${accountId}/submit`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            intents: signedIntents,
            delegations: signedDelegations,
            quoteId: quote.quoteId,
          }),
        },
      );

      if (!result.success || !result.txHash) {
        throw new Error(result.message || 'Transaction relay failed');
      }

      // 5. Build MPP credential with the tx hash
      const credential = {
        challenge: {
          id: challenge.id,
          realm: challenge.realm,
          method: challenge.method,
          intent: challenge.intent,
          request: btoa(JSON.stringify(challenge.request))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, ''),
          ...(challenge.expires && { expires: challenge.expires }),
        },
        payload: {
          hash: result.txHash,
          type: 'hash' as const,
        },
      };

      const json = JSON.stringify(credential);
      const base64url = btoa(json)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      return `Payment ${base64url}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(
      (body as { message?: string; error?: string }).message ||
        (body as { error?: string }).error ||
        `Error: ${response.status}`,
    );
  }
  return response.json() as Promise<T>;
}
