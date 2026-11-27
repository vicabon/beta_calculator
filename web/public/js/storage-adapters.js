/**
 * @fileoverview Pluggable StorageAdapter architecture providing seamless zero-reentry persistence:
 *  1. LocalIndexedDBAdapter (always-on default with localStorage fallback — zero login required)
 *  2. CloudflareD1EncryptedAdapter (/api/vault behind Cloudflare Zero Trust Access + optional AES-256-GCM E2EE)
 *  3. GoogleDriveAppDataAdapter (BYOS: stores directly in each user's own hidden Google Drive drive.appdata folder)
 */

import {
  decryptVaultPayload,
  encryptVaultPayload,
  isEncryptedEnvelope,
  validateVaultPayload,
} from '../core/crypto-vault.mjs';

const IDB_NAME = 'BetaCalculatorPrivateDB';
const IDB_STORE = 'vault_store';
const IDB_KEY = 'primary_vault';
const LS_FALLBACK_KEY = 'betacalc_vault_v1';

/* ============================================================================
 * 1. LocalIndexedDBAdapter (Zero-Login Instant Auto-Save)
 * ============================================================================ */
export class LocalIndexedDBAdapter {
  async openDb() {
    if (typeof indexedDB === 'undefined') return null;
    return new Promise((resolve) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  async load() {
    try {
      const db = await this.openDb();
      if (db) {
        const val = await new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
        if (val) return validateVaultPayload(val);
      }
    } catch {
      // Fallback to localStorage below
    }
    try {
      const raw = globalThis.localStorage?.getItem(LS_FALLBACK_KEY);
      if (raw) return validateVaultPayload(JSON.parse(raw));
    } catch {
      // Ignore corrupt local state
    }
    return null;
  }

  async save(payload) {
    const clean = validateVaultPayload({ ...payload, updatedAt: new Date().toISOString() });
    try {
      const db = await this.openDb();
      if (db) {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(clean, IDB_KEY);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
    } catch {
      // Always mirror to localStorage fallback
    }
    try {
      globalThis.localStorage?.setItem(LS_FALLBACK_KEY, JSON.stringify(clean));
    } catch {
      // Ignore storage quota errors
    }
    return clean;
  }
}

/* ============================================================================
 * 2. CloudflareD1EncryptedAdapter (/api/vault + Zero Trust + Client-Side E2EE)
 * ============================================================================ */
export class CloudflareD1EncryptedAdapter {
  constructor(apiBase = '') {
    this.apiBase = apiBase;
    this.lastVersion = null;
  }

  async upload(vaultPayload, { useE2ee = true, passphrase = '' } = {}) {
    const clean = validateVaultPayload({ ...vaultPayload, updatedAt: new Date().toISOString() });
    const bodyPayload = useE2ee ? await encryptVaultPayload(clean, passphrase) : clean;
    const resp = await fetch(`${this.apiBase}/api/vault`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: bodyPayload,
        expectedVersion: this.lastVersion,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = new Error(data.error || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.code = data.code;
      throw err;
    }
    this.lastVersion = data.version;
    return data;
  }

  async download({ passphrase = '' } = {}) {
    const resp = await fetch(`${this.apiBase}/api/vault`, { method: 'GET' });
    const data = await resp.json();
    if (!resp.ok) {
      const err = new Error(data.error || `HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    this.lastVersion = data.version || 0;
    if (!data.exists || !data.payload) {
      return { exists: false, version: 0, payload: null, userEmail: data.userEmail };
    }
    if (isEncryptedEnvelope(data.payload)) {
      if (!passphrase) {
        throw new Error('此雲端備份為零知識加密格式，請先輸入您的主密碼再下載解密。');
      }
      const decrypted = await decryptVaultPayload(data.payload, passphrase);
      return { exists: true, version: data.version, isEncrypted: true, payload: decrypted, userEmail: data.userEmail };
    }
    return { exists: true, version: data.version, isEncrypted: false, payload: validateVaultPayload(data.payload), userEmail: data.userEmail };
  }

  async remove() {
    const resp = await fetch(`${this.apiBase}/api/vault`, { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    this.lastVersion = 0;
    return data;
  }
}

/* ============================================================================
 * 3. GoogleDriveAppDataAdapter (BYOS — Non-Sensitive drive.appdata Scope)
 * ============================================================================ */
export class GoogleDriveAppDataAdapter {
  constructor() {
    this.accessToken = null;
    this.fileName = 'betacalculator_private_vault.json';
  }

  async ensureGisLoaded() {
    if (globalThis.google?.accounts?.oauth2) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('無法載入 Google Identity Services，請確認網路連線。'));
      document.head.appendChild(script);
    });
  }

  async requestToken(clientId) {
    if (!clientId || !clientId.trim()) {
      throw new Error('請先填入 Google OAuth Client ID。');
    }
    await this.ensureGisLoaded();
    return new Promise((resolve, reject) => {
      const tokenClient = globalThis.google.accounts.oauth2.initTokenClient({
        client_id: clientId.trim(),
        scope: 'https://www.googleapis.com/auth/drive.appdata',
        callback: (resp) => {
          if (resp.error) reject(new Error(resp.error));
          else {
            this.accessToken = resp.access_token;
            resolve(resp.access_token);
          }
        },
      });
      tokenClient.requestAccessToken({ prompt: this.accessToken ? '' : 'consent' });
    });
  }

  async findVaultFileId(token) {
    const q = encodeURIComponent(`name='${this.fileName}' and trashed=false`);
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`Google Drive 查詢失敗 (HTTP ${resp.status})`);
    const data = await resp.json();
    return data.files?.[0]?.id || null;
  }

  async upload(clientId, vaultPayload, { useE2ee = false, passphrase = '' } = {}) {
    const token = await this.requestToken(clientId);
    const clean = validateVaultPayload({ ...vaultPayload, updatedAt: new Date().toISOString() });
    const contentObj = useE2ee && passphrase ? await encryptVaultPayload(clean, passphrase) : clean;
    const fileId = await this.findVaultFileId(token);

    if (fileId) {
      const resp = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(contentObj),
      });
      if (!resp.ok) throw new Error(`Google Drive 更新失敗 (HTTP ${resp.status})`);
      return { ok: true, fileId, encrypted: Boolean(useE2ee && passphrase) };
    }

    const boundary = 'betacalc_boundary_' + Date.now();
    const metadata = { name: this.fileName, parents: ['appDataFolder'] };
    const multipartBody =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(contentObj)}\r\n--${boundary}--`;

    const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipartBody,
    });
    if (!resp.ok) throw new Error(`Google Drive 建立檔案失敗 (HTTP ${resp.status})`);
    const created = await resp.json();
    return { ok: true, fileId: created.id, encrypted: Boolean(useE2ee && passphrase) };
  }

  async download(clientId, { passphrase = '' } = {}) {
    const token = await this.requestToken(clientId);
    const fileId = await this.findVaultFileId(token);
    if (!fileId) return { exists: false, payload: null };
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`Google Drive 下載失敗 (HTTP ${resp.status})`);
    const parsed = await resp.json();
    if (isEncryptedEnvelope(parsed)) {
      if (!passphrase) throw new Error('Google Drive 檔案已啟用零知識加密，請先於左側輸入主密碼。');
      return { exists: true, isEncrypted: true, payload: await decryptVaultPayload(parsed, passphrase) };
    }
    return { exists: true, isEncrypted: false, payload: validateVaultPayload(parsed) };
  }
}
