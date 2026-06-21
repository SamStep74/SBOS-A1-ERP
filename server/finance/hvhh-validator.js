// server/finance/hvhh-validator.js — HHVH validation with A1-Validator fallback.
//
// Wire the A1-Validator HTTP service (see docs/SBOS_VS_A1_ERP_HY.md for the
// canonical URL — kept out of the source per the open-core boundary contract)
// into the HHVH validation path. The A1-Validator service can apply the
// official HVVH check-digit algorithm, plus future refinements (length
// normalization, locale-specific forms, etc.). The local regex fallback
// (^\d{8}$) is the existing SBOS behavior — we keep it as a fail-soft
// fallback when the A1-Validator service is unreachable.
//
// Contract:
//   validateHvhh({ hvhh: "00123456" }) returns { ok: boolean, normalized?: string, error?: string }
//   validateHvhh({ hvhh: "" })       returns { ok: true,  _skipped: "empty (optional)" }
//   validateHvhh({ hvhh: null })     returns { ok: true,  _skipped: "null (optional)" }
//
// The createCustomer endpoint will:
//   1. Call validateHvhh with the input
//   2. If !ok, throw ValueError (the existing 400/404 path)
//   3. If ok or _skipped, proceed
//   4. If _skipped (service down), the local regex is already enforced as
//      a belt-and-suspenders check
//
// This is "opt-in" via env: A1_VALIDATOR_URL unset → the client is disabled
// and validateHvhh always returns { ok: true, _skipped: 'a1-validator disabled' }
// (with the local regex still running).

import { A1ValidatorClient } from '../../lib/a1-validator-client.js';

let _client = null;
function _getClient() {
  if (_client === null) {
    _client = new A1ValidatorClient({
      baseUrl: process.env.A1_VALIDATOR_URL,
      timeoutMs: 1500,
      retries: 0,  // fail fast — the API boundary can't wait
    });
  }
  return _client;
}

// Local regex fallback — same as the previous assertOptionalHvhh regex.
// Used when the A1-Validator service is unreachable or disabled.
const _HARSERJ = /^\d{8}$/;

/**
 * Validate an HHVH via the A1-Validator HTTP service, with local regex
 * fallback. Always returns an object with an `ok` boolean.
 *
 * @param {{ hvhh?: string|null|undefined }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   normalized?: string,
 *   error?: string,
 *   _skipped?: string,
 *   _via?: 'a1-validator'
 * }>}
 */
export async function validateHvhh(input) {
  const raw = input?.hvhh;
  // Optional field — null/undefined/empty string all pass.
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, _skipped: 'empty (optional)' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'hvhh must be a string' };
  }

  const client = _getClient();
  // If the client is disabled (no A1_VALIDATOR_URL), use the local regex only.
  if (!client.enabled) {
    return _localOnly(raw);
  }

  // Service is enabled — call it. Catch network errors and fall back.
  let result;
  try {
    result = await client.validate('hvvh', { hvhh: raw });
  } catch {
    // Network-level error — fall back to local regex
    return _localOnly(raw, 'a1-validator network error');
  }

  // Service reachable but returned a meta-result (skipped / error envelope).
  if (result && (result._skipped || result._error)) {
    return _localOnly(raw, 'a1-validator skipped/error');
  }

  // Service says ok=true or ok=false
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
 * Reset the module-level client cache. Test-only — production code should
 * never call this.
 */
export function _resetClientForTesting() {
  _client = null;
}

function _localOnly(raw, skipReason = 'a1-validator disabled') {
  const trimmed = raw.replace(/\s+/g, '');
  if (!_HARSERJ.test(trimmed)) {
    return { ok: false, normalized: trimmed, error: 'hvhh must be exactly 8 digits', _skipped: skipReason };
  }
  return { ok: true, normalized: trimmed, _skipped: skipReason };
}
