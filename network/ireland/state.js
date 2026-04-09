/**
 * Network state persistence.
 * Reads and writes network/ireland/state.json — the shared state between
 * the event engine (writer) and the network server (reader, plus the
 * remediation handlers which mutate via /data-management/v1/remediate/*).
 *
 * Both can call load() safely — returns null if the file is missing.
 */

'use strict';

const fs   = require('fs');
const { STATE_FILE } = require('./config');

/**
 * Initialise a fresh network state for the given cell list.
 * @param {Array<{id, site, localId}>} cells
 * @returns {object} initial state
 */
function init(cells) {
  return {
    version:    1,
    createdAt:  new Date().toISOString(),
    lastTickAt: null,
    tickCount:  0,
    events:     [],
  };
}

/**
 * Load network state from disk.
 * @returns {object|null} state, or null if file missing/corrupt
 */
function load() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Persist network state to disk (atomic write via temp file).
 *
 * Logs every save with caller frame, event count, and active count so we can
 * detect two-writer races between the event engine and the server-side
 * remediation endpoints. If a save log appears from an unexpected caller (or
 * the active count flips unexpectedly between back-to-back saves), that is
 * the smoking gun.
 *
 * @param {object} state
 */
function save(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);

  // Caller frame: skip Error + this function = caller is index 2
  let caller = '?';
  try {
    const frames = (new Error().stack || '').split('\n');
    caller = (frames[2] || '').trim().replace(/^at\s+/, '');
  } catch {}
  const total  = state.events ? state.events.length : 0;
  const active = state.events ? state.events.filter(e => !e.resolved).length : 0;
  console.log(`[network-state] save events=${total} active=${active} tick=${state.tickCount} caller=${caller}`);
}

module.exports = { init, load, save };
