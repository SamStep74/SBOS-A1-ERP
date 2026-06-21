// server/finance/validate-hvhh.js — On-demand A1-Validator HVVH check.
//
// Used by POST /api/finance/customers/:id/validate-hvhh and
// POST /api/finance/vendors/:id/validate-hvhh. The admin calls these
// to verify a customer's or vendor's TIN is still valid (without
// writing anything). The response shape mirrors the A1-Validator
// client's return:
//   { ok: boolean, normalized?: string, error?: string,
//     _skipped?: string, _via?: 'a1-validator' }
//
// Same fail-soft 3-tier as the create-time wrapper:
//   (1) A1_VALIDATOR_URL unset → { ok: null, _skipped: 'a1-validator disabled' }
//   (2) URL set but unreachable → { ok: null, _skipped: 'a1-validator network error' }
//   (3) URL set + reachable → calls service, returns ok=true/false
//
// Unlike the create-time wrapper, this endpoint does NOT throw on
// invalid TIN — the caller asked for a verification, not a write.
// The HTTP response is always 200 (with ok=false in the body); 404
// only fires when the customer/vendor doesn't exist.

import { A1ValidatorClient } from '../../lib/a1-validator-client.js';

let _client = null;
function _getClient() {
  if (_client === null) {
    _client = new A1ValidatorClient({
      baseUrl: process.env.A1_VALIDATOR_URL,
      timeoutMs: 1500,
      retries: 0,
    });
  }
  return _client;
}

/**
 * On-demand HVVH validation via the A1-Validator HTTP service. Always
 * returns an object with an `ok` field; never throws.
 *
 * @param {{ hvhh?: string|null|undefined }} input
 * @returns {Promise<{
 *   ok: boolean|null,
 *   normalized?: string,
 *   error?: string,
 *   _skipped?: string,
 *   _via?: 'a1-validator'
 * }>}
 */
export async function validateHvhhOnDemand(input) {
  const raw = input?.hvhh;
  // Empty/missing hvhh → ok=null, _skipped (can't validate what isn't there).
  if (raw === null || raw === undefined || raw === '') {
    return { ok: null, _skipped: 'no hvhh to validate' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'hvhh must be a string of 8 digits' };
  }

  const client = _getClient();
  if (!client.enabled) {
    // Disabled — fall back to local regex (same behavior as create-time
    // wrapper). The caller is asking for verification, so we still
    // return a useful result (not _skipped) — just from the local path.
    const trimmed = raw.replace(/\s+/g, '');
    if (!/^\d{8}$/.test(trimmed)) {
      return { ok: false, normalized: trimmed, error: 'hvhh must be exactly 8 digits' };
    }
    return { ok: true, normalized: trimmed, _via: 'local-regex' };
  }

  // Service enabled — call it. Catch network errors and fall back.
  let result;
  try {
    result = await client.validate('hvvh', { hvhh: raw });
  } catch (_err) {
    // Network-level error — fall back to local regex.
    const trimmed = raw.replace(/\s+/g, '');
    if (!/^\d{8}$/.test(trimmed)) {
      return { ok: false, normalized: trimmed, error: 'hvhh must be exactly 8 digits', _skipped: 'a1-validator network error' };
    }
    return { ok: true, normalized: trimmed, _skipped: 'a1-validator network error' };
  }

  if (result && (result._skipped || result._error)) {
    // Service returned an envelope error — fall back to local regex.
    const trimmed = raw.replace(/\s+/g, '');
    if (!/^\d{8}$/.test(trimmed)) {
      return { ok: false, normalized: trimmed, error: 'hvhh must be exactly 8 digits', _skipped: result._error || 'a1-validator envelope error' };
    }
    return { ok: true, normalized: trimmed, _skipped: result._error || 'a1-validator envelope error' };
  }

  // Service says ok=true/false
  if (result && result.ok) {
    return {
      ok: true,
      normalized: result.normalized || raw.replace(/\s+/g, ''),
      _via: 'a1-validator',
    };
  }
  return {
    ok: false,
    normalized: (result && result.normalized) || raw.replace(/\s+/g, ''),
    error: (result && result.error) || 'hvhh is invalid (a1-validator rejected)',
    _via: 'a1-validator',
  };
}

/**
 * Reset the module-level client cache. Test-only.
 */
export function _resetClientForTesting() {
  _client = null;
}
