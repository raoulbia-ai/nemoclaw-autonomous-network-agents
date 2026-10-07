#!/usr/bin/env node
/**
 * Fault fatigue tracker — prevents remediation amplification loops
 * and manages stuck-fault escalation lifecycle.
 *
 * Lifecycle states:
 *
 *   active → fatigued → stuck → recheck → (active | stuck)
 *
 * - active:   normal remediation in progress
 * - fatigued: 3+ failed attempts. Stop retrying. Escalate differently.
 * - stuck:    fatigue acknowledged + escalation posted. Periodic recheck.
 * - recheck:  new evidence detected. One retry allowed. If it fails → stuck again.
 *
 * Usage:
 *   node fault-fatigue.js record <eventId> <result>
 *   node fault-fatigue.js check [eventId]
 *   node fault-fatigue.js escalate <eventId> <type> <summary>
 *   node fault-fatigue.js acknowledge <eventId>
 *   node fault-fatigue.js recheck-due
 *   node fault-fatigue.js recheck-clear <eventId> <result>
 *   node fault-fatigue.js clear <eventId>
 *   node fault-fatigue.js status
 *
 * Fatigue file: artifacts/fault-fatigue.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ARTIFACTS         = path.join(__dirname, '..', '..', '..', 'artifacts');
const FATIGUE_FILE      = path.join(ARTIFACTS, 'fault-fatigue.json');
const FATIGUE_THRESHOLD = parseInt(process.env.FATIGUE_THRESHOLD || '3', 10);
const RECHECK_INTERVAL_HOURS = parseInt(process.env.RECHECK_INTERVAL_HOURS || '1', 10);

// Valid lifecycle states
const STATES = ['active', 'fatigued', 'stuck', 'recheck'];

function load() {
  if (!fs.existsSync(FATIGUE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FATIGUE_FILE, 'utf8')); }
  catch { return {}; }
}

function save(data) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const tmp = FATIGUE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, FATIGUE_FILE);
}

/**
 * Record a remediation attempt for a fault.
 * Transitions: active → fatigued (when attempts >= threshold)
 */
function record(eventId, result) {
  const data = load();
  const now = new Date().toISOString();
  const existing = data[eventId] || {
    state: 'active',
    attempts: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    lastResult: null,
    faultType: null,
    faultSummary: null,
    escalatedAt: null,
    acknowledgedAt: null,
    nextRecheckAt: null,
    recheckAttempts: 0,
  };
  existing.attempts++;
  existing.lastAttemptAt = now;
  existing.lastResult = result; // "changed" | "no_effect" | "error"
  if (!existing.firstAttemptAt) existing.firstAttemptAt = now;

  // State transition: active → fatigued when threshold hit
  if (existing.state === 'active' && existing.attempts >= FATIGUE_THRESHOLD) {
    existing.state = 'fatigued';
  }
  // If in recheck and this attempt failed, back to stuck
  if (existing.state === 'recheck' && result !== 'changed') {
    existing.recheckAttempts++;
    existing.state = 'stuck';
    existing.nextRecheckAt = new Date(Date.now() + RECHECK_INTERVAL_HOURS * 3600000).toISOString();
  }
  // If in recheck and this attempt succeeded, clear entirely
  if (existing.state === 'recheck' && result === 'changed') {
    delete data[eventId];
    save(data);
    return { eventId, state: 'resolved', attempts: existing.attempts, recheckAttempts: existing.recheckAttempts };
  }
  // If any state and remediation succeeded, clear entirely — the fault is resolved
  if (result === 'changed' && (existing.state === 'fatigued' || existing.state === 'stuck')) {
    delete data[eventId];
    save(data);
    return { eventId, state: 'resolved', attempts: existing.attempts };
  }

  data[eventId] = existing;
  save(data);
  return { eventId, ...existing, fatigued: existing.state !== 'active' };
}

/**
 * Escalate a fatigued fault — record the type and summary for the stuck-fault ticket.
 * Transitions: fatigued → stuck
 */
function escalate(eventId, faultType, summary) {
  const data = load();
  const entry = data[eventId];
  if (!entry) return { eventId, error: 'not found' };
  if (entry.state !== 'fatigued') return { eventId, error: `cannot escalate from state ${entry.state}` };

  entry.state = 'stuck';
  entry.faultType = faultType || null;
  entry.faultSummary = summary || null;
  entry.escalatedAt = new Date().toISOString();
  entry.nextRecheckAt = new Date(Date.now() + RECHECK_INTERVAL_HOURS * 3600000).toISOString();
  data[eventId] = entry;
  save(data);
  return { eventId, ...entry };
}

/**
 * Acknowledge a stuck fault — confirm that the escalation was posted.
 * No state change; just records the acknowledgment timestamp.
 */
function acknowledge(eventId) {
  const data = load();
  const entry = data[eventId];
  if (!entry) return { eventId, error: 'not found' };
  if (entry.state !== 'stuck') return { eventId, error: `cannot acknowledge from state ${entry.state}` };

  entry.acknowledgedAt = new Date().toISOString();
  data[eventId] = entry;
  save(data);
  return { eventId, ...entry };
}

/**
 * Find stuck faults that are due for a recheck.
 * Transitions: stuck → recheck
 */
function recheckDue() {
  const data = load();
  const now = Date.now();
  const due = [];

  for (const [eventId, entry] of Object.entries(data)) {
    if (entry.state !== 'stuck') continue;
    if (!entry.nextRecheckAt) continue;
    if (new Date(entry.nextRecheckAt).getTime() <= now) {
      entry.state = 'recheck';
      data[eventId] = entry;
      due.push({ eventId, ...entry });
    }
  }

  if (due.length > 0) save(data);
  return { due, count: due.length };
}

/**
 * Clear a recheck after the result is known.
 * If changed → remove (resolved).
 * If no_effect → back to stuck with new recheck time.
 */
function recheckClear(eventId, result) {
  const data = load();
  const entry = data[eventId];
  if (!entry) return { eventId, error: 'not found' };

  if (result === 'changed') {
    delete data[eventId];
    save(data);
    return { eventId, state: 'resolved', result };
  }

  entry.state = 'stuck';
  entry.recheckAttempts++;
  entry.nextRecheckAt = new Date(Date.now() + RECHECK_INTERVAL_HOURS * 3600000).toISOString();
  data[eventId] = entry;
  save(data);
  return { eventId, ...entry };
}

/**
 * Check fatigue state for one or all faults.
 */
function check(eventId) {
  const data = load();
  if (eventId) {
    const entry = data[eventId];
    if (!entry) return { eventId, state: 'unknown', fatigued: false };
    return { eventId, ...entry, fatigued: entry.state !== 'active' };
  }
  // Return grouped by state
  const grouped = { active: [], fatigued: [], stuck: [], recheck: [] };
  for (const [id, entry] of Object.entries(data)) {
    const group = grouped[entry.state] || grouped.active;
    group.push({ eventId: id, ...entry });
  }
  return {
    grouped,
    fatiguedCount: grouped.fatigued.length + grouped.stuck.length + grouped.recheck.length,
    stuckCount: grouped.stuck.length,
    recheckCount: grouped.recheck.length,
    threshold: FATIGUE_THRESHOLD,
  };
}

/**
 * Clear fatigue for a fault (resolved or manual override).
 */
function clear(eventId) {
  const data = load();
  const existed = !!data[eventId];
  const entry = data[eventId];
  delete data[eventId];
  save(data);
  return { eventId, cleared: existed, previousState: entry?.state || null };
}

/**
 * Human-readable status.
 */
function status() {
  const data = load();
  const all = Object.entries(data);
  if (all.length === 0) return 'No fault fatigue recorded.';

  const lines = [];
  for (const [id, e] of all) {
    const stateLabel = e.state.toUpperCase();
    const age = e.firstAttemptAt
      ? `${Math.round((Date.now() - new Date(e.firstAttemptAt).getTime()) / 60000)}min ago`
      : '?';
    let line = `  ${id}: ${stateLabel} (${e.attempts} attempts, first ${age})`;
    if (e.faultType) line += ` type=${e.faultType}`;
    if (e.state === 'stuck' && e.nextRecheckAt) {
      const recheckIn = Math.max(0, Math.round((new Date(e.nextRecheckAt).getTime() - Date.now()) / 60000));
      line += ` recheck in ${recheckIn}min`;
    }
    if (e.state === 'recheck') line += ' ⚡ RECHECK DUE';
    lines.push(line);
  }

  const fatigued = all.filter(([, e]) => e.state === 'fatigued').length;
  const stuck = all.filter(([, e]) => e.state === 'stuck').length;
  const recheck = all.filter(([, e]) => e.state === 'recheck').length;

  if (fatigued > 0) lines.push(`\n${fatigued} fatigued — awaiting escalation`);
  if (stuck > 0) lines.push(`${stuck} stuck — escalated, awaiting recheck`);
  if (recheck > 0) lines.push(`${recheck} due for recheck — one retry allowed`);

  return lines.join('\n');
}

// CLI
const [,, cmd, ...args] = process.argv;

if (!cmd) {
  console.error('Usage: node fault-fatigue.js <record|check|escalate|acknowledge|recheck-due|recheck-clear|clear|status> [args...]');
  process.exit(1);
}

switch (cmd) {
  case 'record': {
    const [eventId, result] = args;
    if (!eventId) { console.error('Usage: node fault-fatigue.js record <eventId> <result>'); process.exit(1); }
    const r = record(eventId, result || 'no_effect');
    console.log(JSON.stringify(r));
    if (r.state === 'fatigued') console.error(`[fault-fatigue] ⚠️ ${eventId} → FATIGUED (${r.attempts} attempts) — stop retrying, escalate`);
    break;
  }
  case 'check': {
    const r = check(args[0] || null);
    console.log(JSON.stringify(r, null, 2));
    break;
  }
  case 'escalate': {
    const [eventId, faultType, ...summaryParts] = args;
    if (!eventId) { console.error('Usage: node fault-fatigue.js escalate <eventId> <type> <summary>'); process.exit(1); }
    const r = escalate(eventId, faultType, summaryParts.join(' '));
    console.log(JSON.stringify(r, null, 2));
    break;
  }
  case 'acknowledge': {
    const [eventId] = args;
    if (!eventId) { console.error('Usage: node fault-fatigue.js acknowledge <eventId>'); process.exit(1); }
    const r = acknowledge(eventId);
    console.log(JSON.stringify(r, null, 2));
    break;
  }
  case 'recheck-due': {
    const r = recheckDue();
    console.log(JSON.stringify(r, null, 2));
    if (r.count > 0) console.error(`[fault-fatigue] ⚡ ${r.count} fault(s) due for recheck`);
    break;
  }
  case 'recheck-clear': {
    const [eventId, result] = args;
    if (!eventId) { console.error('Usage: node fault-fatigue.js recheck-clear <eventId> <result>'); process.exit(1); }
    const r = recheckClear(eventId, result || 'no_effect');
    console.log(JSON.stringify(r, null, 2));
    break;
  }
  case 'clear': {
    const [eventId] = args;
    if (!eventId) { console.error('Usage: node fault-fatigue.js clear <eventId>'); process.exit(1); }
    console.log(JSON.stringify(clear(eventId)));
    break;
  }
  case 'status': {
    console.log(status());
    break;
  }
  default:
    console.error(`Unknown command: ${cmd}. Use record|check|escalate|acknowledge|recheck-due|recheck-clear|clear|status.`);
    process.exit(1);
}
