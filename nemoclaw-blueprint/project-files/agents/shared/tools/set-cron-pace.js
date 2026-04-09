#!/usr/bin/env node
/**
 * Dynamic cron pacing — agents adjust each other's schedules.
 *
 * Usage: node set-cron-pace.js <agent> <intervalMinutes> <reason>
 *
 * Examples:
 *   node set-cron-pace.js oracle 2 "3 cross-zone hits detected"
 *   node set-cron-pace.js architect 30 "network stable"
 *   node set-cron-pace.js sentinel 1 "verifying growth wave"
 *
 * Enforces floor=1min, ceiling=60min.
 * Logs pace change to agent-comms.jsonl for auditability.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CRON_PATH = '/sandbox/.openclaw/cron/jobs.json';
const FLOOR = 1, CEILING = 60;

const [,, target, minStr, ...reasonParts] = process.argv;
const reason = reasonParts.join(' ');

if (!target || !minStr || !reason) {
  console.error('Usage: node set-cron-pace.js <agent> <intervalMinutes> <reason>');
  process.exit(1);
}

const interval = Math.max(FLOOR, Math.min(CEILING, parseInt(minStr, 10)));
if (isNaN(interval)) { console.error('intervalMinutes must be a number'); process.exit(1); }

const cron = JSON.parse(fs.readFileSync(CRON_PATH, 'utf8'));
const job = cron.jobs.find(j => j.name === target.toLowerCase());
if (!job) { console.error(`No cron job named "${target}"`); process.exit(1); }

const oldExpr = job.schedule.expr;
job.schedule.expr = `*/${interval} * * * *`;
job.state = job.state || {};
job.state.nextRunAtMs = Date.now() + interval * 60000;
job.updatedAtMs = Date.now();

fs.writeFileSync(CRON_PATH, JSON.stringify(cron, null, 2));

// Log to agent-comms via post-comms.js
const commsScript = path.join(__dirname, 'post-comms.js');
const caller = (process.env.CRON_AGENT || 'SYSTEM').toUpperCase();
try {
  execFileSync('node', [commsScript, JSON.stringify({
    agent: caller,
    type: 'pace-change',
    to: target.toUpperCase(),
    message: `${target} pace ${oldExpr} → */${interval}min: ${reason}`
  })], { stdio: 'pipe' });
} catch (_) { /* best-effort logging */ }

console.log(`${target} pace set to ${interval}min (was ${oldExpr}): ${reason}`);
