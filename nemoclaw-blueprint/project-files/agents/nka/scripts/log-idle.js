#!/usr/bin/env node
/**
 * Log an ARCHITECT idle decision to agent-comms.jsonl.
 *
 * Usage:
 *   node log-idle.js "reason why growth was deferred"
 *
 * The script reads state.json for context (wave count, last growth) and
 * formats a structured idle entry. The LLM only provides the reasoning string.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ARTIFACTS  = path.join(__dirname, '..', '..', '..', 'artifacts');
const STATE_FILE = path.join(ARTIFACTS, 'state.json');
const COMMS_FILE = path.join(ARTIFACTS, 'agent-comms.jsonl');

const reason = process.argv.slice(2).join(' ').trim();

if (!reason) {
  console.error('[log-idle] Usage: node log-idle.js "reason for idle"');
  process.exit(1);
}

// Read state for context
const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  : { growth_wave_count: 0, last_growth_at: null };

const entry = {
  at: new Date().toISOString(),
  from: 'ARCHITECT',
  to: 'ALL',
  type: 'idle',
  message: `${reason} State: wave=${state.growth_wave_count}, last_growth=${state.last_growth_at || 'never'}.`,
};

fs.appendFileSync(COMMS_FILE, JSON.stringify(entry) + '\n');

// Log decision for retrospective analysis
try {
  const logDecision = require('./log-decision');
  let advisory = null;
  const lines = fs.existsSync(COMMS_FILE)
    ? fs.readFileSync(COMMS_FILE, 'utf8').trim().split('\n').filter(Boolean) : [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.from === 'ORACLE' && e.to === 'ARCHITECT' && e.type === 'advisory') {
        advisory = e.message;
        break;
      }
    } catch {}
  }
  logDecision({
    agent: 'ARCHITECT',
    decision: 'idle',
    wave: state.growth_wave_count,
    advisory,
    reasoning: reason,
  });
} catch {}

console.log(`[log-idle] Posted: ${entry.message}`);
