#!/usr/bin/env node
/**
 * Log an agentic decision to artifacts/agentic-log.jsonl.
 * Called by log-growth.js and log-idle.js — not by the LLM directly.
 *
 * Each entry captures the decision context so we can review
 * decision quality when the network reaches 8000 cells.
 *
 * Usage (from other scripts):
 *   require('./log-decision')({ agent, decision, ... })
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ARTIFACTS = path.join(__dirname, '..', '..', '..', 'artifacts');
const LOG_FILE  = path.join(ARTIFACTS, 'agentic-log.jsonl');

function logDecision(entry) {
  const record = {
    ts: new Date().toISOString(),
    agent: entry.agent || 'UNKNOWN',
    decision: entry.decision,         // 'grow' | 'idle' | 'remediate'
    wave: entry.wave || null,
    cells_before: entry.cellsBefore || null,
    cells_after: entry.cellsAfter || null,
    counties_chosen: entry.counties || [],
    counties_avoided: entry.avoided || [],
    oracle_advisory: entry.advisory || null,
    reasoning: entry.reasoning || null,
    model: entry.model || null,
    duration_ms: entry.durationMs || null,
  };

  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error(`[log-decision] Failed to write: ${err.message}`);
  }

  return record;
}

// If called directly from CLI: node log-decision.js '{"agent":"ARCHITECT",...}'
if (require.main === module) {
  const raw = process.argv[2];
  if (!raw) {
    console.error('Usage: node log-decision.js \'{"agent":"...","decision":"..."}\'');
    process.exit(1);
  }
  try {
    const entry = JSON.parse(raw);
    const record = logDecision(entry);
    console.log(`[log-decision] Logged: ${record.agent} ${record.decision}`);
  } catch (e) {
    console.error(`[log-decision] Invalid JSON: ${e.message}`);
    process.exit(1);
  }
}

module.exports = logDecision;
