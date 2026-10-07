#!/usr/bin/env node
/**
 * Combined input reader for NKA agents — returns everything in one call.
 *
 * Usage:
 *   node read-cycle-inputs.js SENTINEL
 *   node read-cycle-inputs.js ORACLE
 *   node read-cycle-inputs.js ARCHITECT
 *
 * Returns JSON with agent-specific data. Reduces 5-7 tool calls to 1,
 * saving ~37% input tokens.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');

function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }
}

function readCommsLast(n, filter) {
  const file = path.join(ARTIFACTS, 'agent-comms.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const tail = lines.slice(-100); // read last 100, filter down
  const parsed = [];
  for (const line of tail) {
    try {
      const entry = JSON.parse(line);
      if (!filter || filter(entry)) parsed.push(entry);
    } catch { /* skip */ }
  }
  return parsed.slice(-n);
}

function readUrgentTrigger(agentName) {
  const triggerFile = path.join(ARTIFACTS, `urgent-trigger-${agentName}.json`);
  if (!fs.existsSync(triggerFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(triggerFile, 'utf8'));
    fs.unlinkSync(triggerFile); // one-shot: delete after reading
    return data;
  } catch { return null; }
}

// --- Agent-specific readers ---

function readFatigue() {
  const file = path.join(ARTIFACTS, 'fault-fatigue.json');
  const data = readJSON(file);
  if (!data) return { fatiguedEvents: [], fatiguedCount: 0, stuckEvents: [], stuckCount: 0, recheckEvents: [], recheckCount: 0 };
  const fatigued = [];
  const stuck = [];
  const recheck = [];
  for (const [eventId, e] of Object.entries(data)) {
    const entry = { eventId, state: e.state, attempts: e.attempts, lastResult: e.lastResult, faultType: e.faultType || null };
    if (e.nextRecheckAt) entry.nextRecheckAt = e.nextRecheckAt;
    if (e.state === 'fatigued') fatigued.push(entry);
    else if (e.state === 'stuck') stuck.push(entry);
    else if (e.state === 'recheck') recheck.push(entry);
  }
  return {
    fatiguedEvents: fatigued,
    fatiguedCount: fatigued.length,
    stuckEvents: stuck,
    stuckCount: stuck.length,
    recheckEvents: recheck,
    recheckCount: recheck.length,
  };
}

function sentinelInputs() {
  // SENTINEL-FAST.md only needs gateway/agent status — those are openclaw CLI calls,
  // not file reads. But we can still bundle signals for context.
  return {
    agent: 'SENTINEL',
    urgentTrigger: readUrgentTrigger('SENTINEL'),
    signals: readJSON(path.join(ARTIFACTS, 'signals.json')),
    state: readJSON(path.join(ARTIFACTS, 'state.json')),
    recent_comms: readCommsLast(5, null),
    fatigue: readFatigue(),
  };
}

function oracleInputs() {
  return {
    agent: 'ORACLE',
    urgentTrigger: readUrgentTrigger('ORACLE'),
    // Step 1: SENTINEL handoffs
    sentinel_handoffs: readCommsLast(5, e => e.from === 'SENTINEL'),
    // Step 2: network state
    signals: readJSON(path.join(ARTIFACTS, 'signals.json')),
    state: readJSON(path.join(ARTIFACTS, 'state.json')),
    memory: readFile(path.join(ROOT, 'MEMORY.md')),
    // Step 3: external context
    external_context: readJSON(path.join(ARTIFACTS, 'external-context.json')),
    // Fatigue: faults that have been remediation-attempted 3+ times with no effect
    fatigue: readFatigue(),
  };
}

function isExpired(entry) {
  if (!entry.expiresAt) return false; // no expiry = always active
  return new Date(entry.expiresAt) < new Date();
}

function architectInputs() {
  const advisories = readCommsLast(3, e =>
    e.from === 'ORACLE' && e.to === 'ARCHITECT' && e.type === 'advisory'
  );
  // Mark expired advisories so ARCHITECT knows they're historical
  for (const a of advisories) {
    if (isExpired(a)) a._expired = true;
  }
  return {
    agent: 'ARCHITECT',
    urgentTrigger: readUrgentTrigger('ARCHITECT'),
    // ORACLE advisories (expired ones marked with _expired: true)
    oracle_advisory: advisories,
    // Step 1: state
    state: readJSON(path.join(ARTIFACTS, 'state.json')),
    // Step 1: external context
    external_context: readJSON(path.join(ARTIFACTS, 'external-context.json')),
    // Step 4: city-params (needed if growing)
    city_params: readJSON(path.join(ARTIFACTS, 'city-params.json')),
    // Fatigue: faults that should NOT be re-attempted
    fatigue: readFatigue(),
  };
}

// --- Main ---
const agentName = (process.argv[2] || '').toUpperCase();

const readers = {
  SENTINEL: sentinelInputs,
  ORACLE: oracleInputs,
  ARCHITECT: architectInputs,
};

if (!readers[agentName]) {
  console.error('Usage: node read-cycle-inputs.js SENTINEL|ORACLE|ARCHITECT');
  process.exit(1);
}

const output = readers[agentName]();
console.log(JSON.stringify(output, null, 2));
