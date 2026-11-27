/**
 * @fileoverview Zero-Knowledge Client-Side End-to-End Encryption (E2EE) Vault module.
 * Uses native Web Crypto API (PBKDF2-SHA256 600,000 iterations + AES-256-GCM + random IV/salt).
 * Works identically in modern Browsers and Node.js 20+ (globalThis.crypto.subtle).
 */

import { WEB_CONFIG } from './config.mjs';

const PBKDF2_ITERATIONS = 600000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function getCrypto() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is required for E2EE Vault.');
  }
  return c;
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveAesKey(passphrase, saltBytes, iterations = PBKDF2_ITERATIONS) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('主密碼長度須至少 8 個字元以確保加密強度。');
  }
  const crypto = getCrypto();
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Generates a high-entropy human-readable Recovery Key (256-bit) users can store offline.
 */
export function generateRecoveryKey() {
  const bytes = new Uint8Array(24);
  getCrypto().getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{1,6}/g).join('-');
}

/**
 * Validates and normalizes a Vault payload before saving locally or encrypting for cloud sync.
 */
export function validateVaultPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Vault payload must be a valid object.');
  }
  const holdings = Array.isArray(payload.holdings) ? payload.holdings : [];
  if (holdings.length > 200) {
    throw new Error('Holdings count exceeds maximum allowed limit (200).');
  }
  return {
    schemaVersion: WEB_CONFIG.VAULT_SCHEMA_VERSION,
    updatedAt: payload.updatedAt || new Date().toISOString(),
    fireInputs: payload.fireInputs && typeof payload.fireInputs === 'object' ? payload.fireInputs : { ...WEB_CONFIG.FIRE_DEFAULTS },
    holdings,
    customPresets: payload.customPresets && typeof payload.customPresets === 'object' ? payload.customPresets : {},
    usdTwdRate: Number.isFinite(Number(payload.usdTwdRate)) && Number(payload.usdTwdRate) > 0 ? Number(payload.usdTwdRate) : 32.0,
  };
}

/**
 * Encrypts a portfolio vault object into a zero-knowledge AES-256-GCM envelope.
 * Note: Allows overriding `iterations` ONLY in fast unit tests; production defaults to 600,000.
 */
export async function encryptVaultPayload(payload, passphrase, options = {}) {
  const validated = validateVaultPayload(payload);
  const iterations = Number.isInteger(options.iterations) && options.iterations >= 10000
    ? options.iterations
    : PBKDF2_ITERATIONS;
  const crypto = getCrypto();
  const salt = new Uint8Array(SALT_BYTES);
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(salt);
  crypto.getRandomValues(iv);

  const key = await deriveAesKey(passphrase, salt, iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(validated));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return {
    format: 'BETACALC_E2EE_VAULT',
    schemaVersion: WEB_CONFIG.VAULT_SCHEMA_VERSION,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(cipherBuf)),
    updatedAt: validated.updatedAt,
  };
}

/**
 * Decrypts a zero-knowledge AES-256-GCM envelope back to the portfolio vault object.
 */
export async function decryptVaultPayload(envelope, passphrase) {
  if (!envelope || envelope.format !== 'BETACALC_E2EE_VAULT' || !envelope.salt || !envelope.iv || !envelope.ciphertext) {
    throw new Error('無效的加密保險庫格式。');
  }
  const crypto = getCrypto();
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const iterations = Number(envelope.iterations) || PBKDF2_ITERATIONS;

  const key = await deriveAesKey(passphrase, salt, iterations);
  let plainBuf;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  } catch {
    throw new Error('解密失敗：主密碼錯誤或密文已遭竄改。');
  }
  const parsed = JSON.parse(new TextDecoder().decode(plainBuf));
  return validateVaultPayload(parsed);
}

export function isEncryptedEnvelope(obj) {
  return Boolean(obj && typeof obj === 'object' && obj.format === 'BETACALC_E2EE_VAULT' && typeof obj.ciphertext === 'string');
}
