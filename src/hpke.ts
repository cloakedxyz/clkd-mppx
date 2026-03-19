/**
 * HPKE (Hybrid Public Key Encryption) using Noble cryptographic primitives.
 * Implements RFC 9180 Base mode with:
 *   KEM:  DHKEM(X25519, HKDF-SHA256)  (0x0020)
 *   KDF:  HKDF-SHA256                 (0x0001)
 *   AEAD: AES-128-GCM                 (0x0001)
 *
 * Pure JS — works on web and Node.
 */

// @ts-ignore — noble subpath exports
import { x25519 } from '@noble/curves/ed25519';
// @ts-ignore
import { extract as hkdfExtract, expand as hkdfExpand } from '@noble/hashes/hkdf';
// @ts-ignore
import { sha256 } from '@noble/hashes/sha256';
// @ts-ignore
import { concatBytes, randomBytes } from '@noble/hashes/utils';
// @ts-ignore
import { gcm } from '@noble/ciphers/aes';

// ---------------------------------------------------------------------------
// Base64 utilities
// ---------------------------------------------------------------------------

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(base64, 'base64'));
  }
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
  const uint8Array = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(uint8Array).toString('base64');
  }
  let binaryString = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binaryString += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binaryString);
}

// ---------------------------------------------------------------------------
// RFC 9180 constants
// ---------------------------------------------------------------------------

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0001;
const N_SECRET = 32;
const NK = 16;
const NN = 12;

const HPKE_LABEL = new Uint8Array([0x48, 0x50, 0x4b, 0x45, 0x2d, 0x76, 0x31]); // "HPKE-v1"

function i2osp(n: number, w: number): Uint8Array {
  const r = new Uint8Array(w);
  for (let i = w - 1; i >= 0; i--) {
    r[i] = n & 0xff;
    n >>>= 8;
  }
  return r;
}

function strToBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

const KEM_SUITE_ID = concatBytes(strToBytes('KEM'), i2osp(KEM_ID, 2));
const HPKE_SUITE_ID = concatBytes(
  strToBytes('HPKE'),
  i2osp(KEM_ID, 2),
  i2osp(KDF_ID, 2),
  i2osp(AEAD_ID, 2),
);

// ---------------------------------------------------------------------------
// Labeled Extract / Expand (RFC 9180 §4)
// ---------------------------------------------------------------------------

function labeledExtract(
  suiteId: Uint8Array,
  salt: Uint8Array | undefined,
  label: string,
  ikm: Uint8Array,
): Uint8Array {
  const labeledIkm = concatBytes(HPKE_LABEL, suiteId, strToBytes(label), ikm);
  return hkdfExtract(sha256, labeledIkm, salt);
}

function labeledExpand(
  suiteId: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  L: number,
): Uint8Array {
  const labeledInfo = concatBytes(i2osp(L, 2), HPKE_LABEL, suiteId, strToBytes(label), info);
  return hkdfExpand(sha256, prk, labeledInfo, L);
}

// ---------------------------------------------------------------------------
// DHKEM(X25519, HKDF-SHA256) Encapsulate (RFC 9180 §4.1)
// ---------------------------------------------------------------------------

function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const prk = labeledExtract(KEM_SUITE_ID, undefined, 'eae_prk', dh);
  return labeledExpand(KEM_SUITE_ID, prk, 'shared_secret', kemContext, N_SECRET);
}

function encap(pkR: Uint8Array): { sharedSecret: Uint8Array; enc: Uint8Array } {
  const skE = randomBytes(32);
  const pkE = x25519.getPublicKey(skE);
  const dh = x25519.getSharedSecret(skE, pkR);
  const enc = pkE;
  const kemContext = concatBytes(enc, pkR);
  const sharedSecret = extractAndExpand(dh, kemContext);
  return { sharedSecret, enc };
}

// ---------------------------------------------------------------------------
// Key Schedule (RFC 9180 §5.1) — Base mode only
// ---------------------------------------------------------------------------

interface SenderContext {
  key: Uint8Array;
  baseNonce: Uint8Array;
  enc: Uint8Array;
}

function keyScheduleS(sharedSecret: Uint8Array, enc: Uint8Array): SenderContext {
  const empty = new Uint8Array(0);
  const mode = 0;
  const pskIdHash = labeledExtract(HPKE_SUITE_ID, undefined, 'psk_id_hash', empty);
  const infoHash = labeledExtract(HPKE_SUITE_ID, undefined, 'info_hash', empty);
  const ksContext = concatBytes(new Uint8Array([mode]), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE_ID, sharedSecret, 'secret', empty);
  const key = labeledExpand(HPKE_SUITE_ID, secret, 'key', ksContext, NK);
  const baseNonce = labeledExpand(HPKE_SUITE_ID, secret, 'base_nonce', ksContext, NN);
  return { key, baseNonce, enc };
}

function sealPlaintext(ctx: SenderContext, plaintext: Uint8Array): Uint8Array {
  const aes = gcm(ctx.key, ctx.baseNonce);
  return aes.encrypt(plaintext);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function hpkeEncrypt(
  plaintext: Uint8Array,
  serverPublicKey: Uint8Array,
): { ciphertext: string; encapsulatedKey: string } {
  if (serverPublicKey.length !== 32) {
    throw new Error(`Invalid X25519 public key: expected 32 bytes, got ${serverPublicKey.length}`);
  }
  const { sharedSecret, enc } = encap(serverPublicKey);
  const ctx = keyScheduleS(sharedSecret, enc);
  const ciphertext = sealPlaintext(ctx, plaintext);
  return {
    ciphertext: bytesToBase64(ciphertext),
    encapsulatedKey: bytesToBase64(enc),
  };
}

export async function fetchHpkePublicKey(baseUrl: string): Promise<Uint8Array> {
  const response = await fetch(`${baseUrl}/.well-known/hpke-public-key`);
  if (!response.ok) {
    throw new Error(`Failed to fetch HPKE public key: ${response.status}`);
  }
  const text = (await response.text()).trim();
  try {
    const data = JSON.parse(text);
    if (data.publicKeyBase64) {
      return base64ToBytes(data.publicKeyBase64);
    }
    throw new Error('Server returned JSON without publicKeyBase64 field');
  } catch (e) {
    if (e instanceof SyntaxError) {
      // Not JSON — try hex
    } else {
      throw e;
    }
  }
  return hexToBytes(text);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${clean.length}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
