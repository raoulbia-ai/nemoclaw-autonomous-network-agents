#!/usr/bin/env node
/**
 * Track per-agent run outcomes for ATA.
 *
 * Records whether each cycle was productive (acted, skipped, error)
 * and persists snapshot hashes for delta-gating.
 *
 * Usage:
 *   node update-run-state.js SENTINEL '{"result":"acted","snapshot_hash":"abc123","comms_offset":42}'
 *   node update-run-state.js ORACLE '{"result":"skipped_no_change"}'
 *
 * Valid results: acted, skipped_no_change, skipped_self_assess, error, timeout
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ARTIFACTS  = path.join(__dirname, '..', '..', '..', 'artifacts');
const STATE_FILE = path.join(ARTIFACTS, 'last-run-state.json');
const RUNS_FILE  = path.join(ARTIFACTS, 'agent-runs.jsonl');

const VALID_RESULTS = ['acted', 'skipped_no_change', 'skipped_self_assess', 'error', 'timeout'];

function updateRunState(agentName, update) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  // Read current state
  let state = {};
  if (fs.existsSync(STATE_FILE)) {
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { state = {}; }
  }

  if (update.result && !VALID_RESULTS.includes(update.result)) {
    throw new Error(`Invalid result: "${update.result}". Valid: ${VALID_RESULTS.join(', ')}`);
  }

  const now = new Date().toISOString();
  const prev = state[agentName] || {};

  state[agentName] = {
    last_run: now,
    result: update.result || 'acted',
    snapshot_hash: update.snapshot_hash || prev.snapshot_hash || null,
    file_hashes: update.file_hashes || prev.file_hashes || {},
    last_seen_comms_offset: update.comms_offset !== undefined
      ? update.comms_offset
      : (prev.last_seen_comms_offset || 0),
    last_substantive_output_at: update.result === 'acted'
      ? now
      : (prev.last_substantive_output_at || null),
    summary: update.summary || null,
    tool_calls: update.tool_calls || null,
    consecutive_skips: update.result === 'skipped_no_change'
      ? (prev.consecutive_skips || 0) + 1
      : 0,
    total_runs: (prev.total_runs || 0) + 1,
    total_acted: (prev.total_acted || 0) + (update.result === 'acted' ? 1 : 0),
    total_skipped: (prev.total_skipped || 0) + (update.result?.startsWith('skipped') ? 1 : 0),
  };

  // Atomic write
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, STATE_FILE);

  // Append to runs log
  const runEntry = {
    at: now,
    agent: agentName,
    result: update.result || 'acted',
    summary: update.summary || null,
  };
  fs.appendFileSync(RUNS_FILE, JSON.stringify(runEntry) + '\n');

  return state[agentName];
}

module.exports = updateRunState;

if (require.main === module) {
  const agent = process.argv[2];
  const update = JSON.parse(process.argv[3] || '{}');

  if (!agent) {
    console.error('Usage: node update-run-state.js AGENT_NAME \'{"result":"acted"}\'');
    process.exit(1);
  }

  try {
    const result = updateRunState(agent.toUpperCase(), update);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`[update-run-state] Error: ${e.message}`);
    process.exit(1);
  }
}
