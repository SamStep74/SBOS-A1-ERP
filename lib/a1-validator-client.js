// lib/a1-validator-client.js — Node.js client for the A1-Validator HTTP service.
//
// A1-Validator (github.com/Armosphera/A1-Validator) is a Python library + HTTP
// service that validates 37 international business ID formats (HHVH, INN,
// CNPJ, MX RFC, JP My Number, AR CUIT, CL RUT, etc.). When deployed as a
// service (docker run -p 8000:8000 ghcr.io/armosphera/a1-validator:v0.4.0),
// SBOS-A1-ERP can call it instead of doing regex checks locally.
//
// Usage:
//
//     import { A1ValidatorClient } from './lib/a1-validator-client.js';
//
//     const client = new A1ValidatorClient({ baseUrl: 'http://a1-validator:8000' });
//     const result = await client.validate('hvvh', { hvhh: '00123456' });
//     // → { ok: true, normalized: '00123456', error: null }
//
//     // List all available validators:
//     const kinds = await client.listKinds();
//     // → ['hhvh', 'inn', 'mx_rfc', ...]
//
// The client is opt-in: if A1_VALIDATOR_URL is not set, create a client with
// `enabled: false` and all calls return `{ ok: null, _skipped: true }`.
//
// This module has zero npm dependencies — uses Node 20+ built-in fetch.

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_RETRIES = 1;

export class A1ValidatorClient {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl] - Service URL (default: env A1_VALIDATOR_URL or http://localhost:8000)
   * @param {number} [options.timeoutMs] - Per-request timeout (default 2000ms)
   * @param {number} [options.retries] - Retry count on network error (default 1)
   * @param {boolean} [options.enabled] - Master switch (default: true if baseUrl is set)
   * @param {object} [options.fetch] - Inject for testing (default: global fetch)
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || process.env.A1_VALIDATOR_URL || 'http://localhost:8000').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    // Default to disabled unless the env var or an explicit baseUrl is set.
    // This matches the documented design: "If A1_VALIDATOR_URL is not set,
    // create a client with `enabled: false` and all calls return
    // { ok: null, _skipped: true }."
    const envSet = Boolean(process.env.A1_VALIDATOR_URL);
    const baseUrlSet = Boolean(options.baseUrl);
    this.enabled = options.enabled ?? (envSet || baseUrlSet);
    this._fetch = options.fetch || globalThis.fetch;
  }

  /**
   * Check if the service is reachable. Returns { ok: bool, error?: string, validators?: string[] }.
   * Use this at boot to log the integration state.
   */
  async health() {
    if (!this.enabled) {
      return { ok: false, error: 'disabled (A1_VALIDATOR_URL not set or enabled=false)' };
    }
    try {
      const res = await this._fetch(`${this.baseUrl}/`, this._requestOpts());
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status} from ${this.baseUrl}/` };
      }
      const body = await res.json();
      return {
        ok: true,
        name: body.name,
        version: body.version,
        validators: body.validators,
      };
    } catch (err) {
      return { ok: false, error: `unreachable: ${err.message}` };
    }
  }

  /**
   * List the validator kinds this service exposes.
   * @returns {Promise<string[]>}
   */
  async listKinds() {
    if (!this.enabled) return [];
    try {
      const res = await this._withRetry(`${this.baseUrl}/validators`, this._requestOpts());
      if (!res.ok) return [];
      const body = await res.json();
      return body.validators || [];
    } catch {
      return [];
    }
  }

  /**
   * Run a validator on a value.
   * @param {string} kind - One of the kinds from listKinds() (e.g. "hvvh", "mx_rfc")
   * @param {object} value - The validator-specific input (e.g. { hvhh: "00123456" })
   * @returns {Promise<{ok: bool|null, normalized?: string, error?: string|null, _skipped?: boolean, _error?: string}>}
   */
  async validate(kind, value) {
    if (!this.enabled) {
      return { ok: null, _skipped: true, error: 'A1-Validator client disabled' };
    }
    try {
      const res = await this._withRetry(
        `${this.baseUrl}/validate/${kind}`,
        this._requestOpts('POST', value),
      );
      if (!res.ok) {
        return { ok: null, _error: `HTTP ${res.status}` };
      }
      return await res.json();
    } catch (err) {
      return { ok: null, _error: `network: ${err.message}` };
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ────────────────────────────────────────────────────────────────────

  _requestOpts(method, body) {
    return {
      method: method || 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
  }

  async _withRetry(url, opts) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this._fetch(url, opts);
      } catch (err) {
        lastErr = err;
        // Don't retry on the last attempt
        if (attempt < this.retries) {
          // 100ms backoff
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
    throw lastErr;
  }
}
