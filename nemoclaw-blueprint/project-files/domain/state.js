/**
 * Domain-level network state access.
 *
 * Wraps the dataset-specific state module (ireland/state) behind a stable
 * interface. Adds a TTL-based cache to avoid hammering the disk on rapid
 * PM/FM polls — the cache is bypassed by remediation handlers which need
 * fresh state and invalidate the cache after writes.
 */

'use strict';

const networkState = require('../network/ireland/state');

const STATE_CACHE_TTL = 5_000;
let _stateCache   = null;
let _stateCacheAt = 0;

/**
 * Load network state (cached, TTL = 5s).
 * Use this for read-only endpoints (PM, FM, faults listing).
 */
function loadCached() {
  const now = Date.now();
  if (!_stateCache || now - _stateCacheAt > STATE_CACHE_TTL) {
    _stateCache   = networkState.load();
    _stateCacheAt = now;
  }
  return _stateCache;
}

/**
 * Load network state from disk (always fresh, no cache).
 * Use this for mutation endpoints (remediate) before reading,
 * then call invalidateCache() after writing.
 */
function loadFresh() {
  return networkState.load();
}

/**
 * Persist network state to disk (atomic write).
 * @param {object} state
 */
function save(state) {
  networkState.save(state);
}

/**
 * Invalidate the cache — call after any mutation (remediate handlers).
 */
function invalidateCache() {
  _stateCache = null;
}

/**
 * Initialise a fresh network state.
 * @param {Array<{id, site, localId}>} cells
 */
function init(cells) {
  return networkState.init(cells);
}

module.exports = { loadCached, loadFresh, save, invalidateCache, init };
