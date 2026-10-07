#!/usr/bin/env node
/**
 * Pause all agent cron jobs when infrastructure is down.
 *
 * Saves current intervals to a snapshot file, then disables all jobs.
 * Resume with resume-cron.js.
 *
 * Usage: node pause-cron.js <reason>
 *   node pause-cron.js "LLM tunnel down"
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const CRON_PATH = '/sandbox/.openclaw/cron/jobs.json';
const SNAPSHOT_PATH = '/sandbox/.openclaw/cron/pause-snapshot.json';

const [,, ...reasonParts] = process.argv;
const reason = reasonParts.join(' ') || 'unspecified';

if (!fs.existsSync(CRON_PATH)) {
  console.error(`[pause-cron] No jobs.json at ${CRON_PATH}`);
  process.exit(1);
}

const cron = JSON.parse(fs.readFileSync(CRON_PATH, 'utf8'));

// Already paused? Skip
if (fs.existsSync(SNAPSHOT_PATH)) {
  console.log('[pause-cron] Already paused, skipping');
  process.exit(0);
}

// Snapshot current state before modifying
const snapshot = {
  pausedAt: new Date().toISOString(),
  reason,
  jobs: cron.jobs.map(j => ({
    id: j.id,
    name: j.name,
    enabled: j.enabled,
    cronExpr: j.schedule.cron || j.schedule.expr,
  })),
};
fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));

// Disable all jobs
for (const job of cron.jobs) {
  job.enabled = false;
}
fs.writeFileSync(CRON_PATH, JSON.stringify(cron, null, 2));

// Fix permissions — gateway runs as root and writes 0600.
// Ensure the file is readable by the sandbox user for future pause/resume.
try { fs.chmodSync(CRON_PATH, 0o644); } catch (_) { /* best-effort */ }

// Log to comms (best-effort)
try {
  const postComms = require('./post-comms.js');
  postComms({
    agent: 'SYSTEM',
    type: 'meta',
    message: `All cron jobs PAUSED: ${reason}`,
  });
} catch (_) { /* best-effort */ }

const names = cron.jobs.map(j => j.name).join(', ');
console.log(`[pause-cron] Paused: ${names} — ${reason}`);
