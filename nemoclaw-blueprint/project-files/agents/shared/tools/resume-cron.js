#!/usr/bin/env node
/**
 * Resume agent cron jobs after infrastructure recovery.
 *
 * Restores intervals from the pause-snapshot.json written by pause-cron.js.
 * If no snapshot exists, jobs are assumed to be running already.
 *
 * Usage: node resume-cron.js [reason]
 *   node resume-cron.js "LLM tunnel restored"
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const CRON_PATH = '/sandbox/.openclaw/cron/jobs.json';
const SNAPSHOT_PATH = '/sandbox/.openclaw/cron/pause-snapshot.json';

const [,, ...reasonParts] = process.argv;
const reason = reasonParts.join(' ') || 'infrastructure recovered';

if (!fs.existsSync(CRON_PATH)) {
  console.error(`[resume-cron] No jobs.json at ${CRON_PATH}`);
  process.exit(1);
}

// Not paused? Nothing to do
if (!fs.existsSync(SNAPSHOT_PATH)) {
  console.log('[resume-cron] Not paused, nothing to resume');
  process.exit(0);
}

const cron = JSON.parse(fs.readFileSync(CRON_PATH, 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));

// Restore each job's enabled state and cron expression
let restored = 0;
for (const saved of snapshot.jobs) {
  const job = cron.jobs.find(j => j.id === saved.id || j.name === saved.name);
  if (job) {
    job.enabled = saved.enabled;
    if (saved.cronExpr) {
      // Support both schedule.cron (seed format) and schedule.expr (set-cron-pace format)
      if (job.schedule.cron !== undefined) {
        job.schedule.cron = saved.cronExpr;
      }
      if (job.schedule.expr !== undefined) {
        job.schedule.expr = saved.cronExpr;
      }
    }
    restored++;
  }
}
fs.writeFileSync(CRON_PATH, JSON.stringify(cron, null, 2));

// Fix permissions — gateway runs as root and writes 0600.
// Ensure the file is readable by the sandbox user for future pause/resume.
try { fs.chmodSync(CRON_PATH, 0o644); } catch (_) { /* best-effort */ }

// Remove snapshot so we don't resume again
fs.unlinkSync(SNAPSHOT_PATH);

// Log to comms (best-effort)
try {
  const postComms = require('./post-comms.js');
  postComms({
    agent: 'SYSTEM',
    type: 'meta',
    message: `Cron jobs RESUMED: ${reason} (paused at ${snapshot.pausedAt} for: ${snapshot.reason})`,
  });
} catch (_) { /* best-effort */ }

console.log(`[resume-cron] Resumed ${restored} jobs — ${reason} (were paused at ${snapshot.pausedAt})`);
