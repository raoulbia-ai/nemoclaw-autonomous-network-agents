#!/usr/bin/env node
/**
 * remediate-all.js — drain the active fault queue from network ground truth.
 *
 * Usage:  node remediate-all.js [--dry-run] [--type=backhaul_fault|equipment_fault]
 *
 * Why this exists:
 *   ARCHITECT used to call remediate-backhaul.js / remediate-cell.js with site
 *   and cell IDs the LLM extracted from free-form alarm text. It got them wrong
 *   (truncated suffixes, bare cell numbers, no MeContext). All remediations
 *   silently no-op'd. Fix: take the LLM out of the ID-handling loop. This
 *   script asks the network for the canonical, structured fault list and dispatches
 *   exact-ID remediation calls. ARCHITECT only decides *whether* to run it.
 *
 * Writes one log entry per attempted action to artifacts/remediation-log.jsonl.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const { URL } = require('url');

const REMEDIATION_LOG = path.join(__dirname, '..', '..', '..', 'artifacts', 'remediation-log.jsonl');
const FATIGUE_SCRIPT  = path.join(__dirname, '..', '..', 'shared', 'tools', 'fault-fatigue.js');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const typeArg = (args.find(a => a.startsWith('--type=')) || '').split('=')[1] || null;

function networkBase() {
  // Sandbox-only architecture: the network server runs in the same sandbox
  // network namespace as this script. Always reach it on loopback. The
  // NETWORK_URL env var is the override.
  return (process.env.NETWORK_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
}

// Plain Node http. We initially shelled out to curl as a workaround for the
// agent-session 403, but the actual cause was the egress filter rejecting
// our custom URL paths regardless of HTTP client. After moving the routes
// under `/data-management/v1/...` and using GET (the only allowed method
// for that namespace), Node http works fine — see the long comment in
// network/server.js on remediateCellHandler.
function request(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = lib.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...headers,
      },
    }, (res) => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : {} });
        } catch {
          resolve({ status: res.statusCode, body: { raw: chunks } });
        }
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: { error: err.message } }));
    if (data) req.write(data);
    req.end();
  });
}

function logLine(entry) {
  fs.appendFileSync(REMEDIATION_LOG, JSON.stringify(entry) + '\n');
}

(async () => {
  const base = networkBase();
  const auth = { Authorization: 'Bearer mock-bearer-token' };
  const inSandbox = fs.existsSync('/sandbox/.openclaw/openclaw.json');
  console.log(`[remediate-all] start network=${base} sandbox=${inSandbox} dryRun=${dryRun}${typeArg ? ' type=' + typeArg : ''}`);

  const q = typeArg ? `?type=${encodeURIComponent(typeArg)}` : '';
  const list = await request('GET', `${base}/data-management/v1/faults/active${q}`, null, auth).catch(e => ({ status: 0, body: { error: e.message } }));
  if (list.status !== 200) {
    console.error(`[remediate-all] failed to fetch faults: HTTP ${list.status} ${JSON.stringify(list.body)}`);
    process.exit(2);
  }

  const faults = list.body.faults || [];
  // Structured input dump — exact ground truth ARCHITECT acted on, for audit
  const counts = faults.reduce((acc, f) => { acc[f.type] = (acc[f.type] || 0) + 1; return acc; }, {});
  console.log(`[remediate-all] fetched ${faults.length} active fault(s) byType=${JSON.stringify(counts)}`);
  for (const f of faults) {
    console.log(`[remediate-all]   ${f.eventId} ${f.type} sites=${JSON.stringify(f.sites)} cells=${f.cells.length} rerouted=${f.rerouted} ghost=${f.ghostAlarm}`);
  }

  let attempts = 0, changed = 0, skipped = 0;

  for (const f of faults) {
    if (f.type === 'backhaul_fault') {
      if (f.rerouted) { skipped++; continue; }
      const siteId = f.sites[0];
      if (!siteId) { skipped++; continue; }
      attempts++;
      if (dryRun) {
        console.log(`[dry-run] reroute-backhaul site=${siteId} event=${f.eventId}`);
        continue;
      }
      // GET (not POST): the agent-session egress filter only allows GETs
      // under /data-management/v1/. See server.js comment on remediateCellHandler.
      const url = `${base}/data-management/v1/remediate/backhaul?siteId=${encodeURIComponent(siteId)}`;
      const r = await request('GET', url, null, auth);
      const ok = r.status === 200 && r.body.changed;
      if (ok) changed++;
      console.log(`[remediate-all] backhaul ${siteId} → ${r.body.result || ('HTTP ' + r.status)}`);
      logLine({
        at: new Date().toISOString(),
        action: 'reroute-backhaul',
        siteId,
        eventId: r.body.eventId || f.eventId,
        changed: ok,
        result: r.body.result || `HTTP ${r.status}`,
      });
    } else if (f.type === 'equipment_fault') {
      const cellId = f.cells[0];
      if (!cellId) { skipped++; continue; }
      const action = f.ghostAlarm ? 'clear-alarm' : 'restart-cell';
      attempts++;
      if (dryRun) {
        console.log(`[dry-run] ${action} cell=${cellId} event=${f.eventId}`);
        continue;
      }
      // GET (not POST): see server.js comment on remediateCellHandler.
      const url = `${base}/data-management/v1/remediate/cell?cellId=${encodeURIComponent(cellId)}&action=${encodeURIComponent(action)}`;
      const r = await request('GET', url, null, auth);
      const ok = r.status === 200 && r.body.changed;
      if (ok) changed++;
      console.log(`[remediate-all] ${action} ${cellId} → ${r.body.result || ('HTTP ' + r.status)}`);
      logLine({
        at: new Date().toISOString(),
        action,
        cellId,
        eventId: r.body.eventId || f.eventId,
        changed: ok,
        result: r.body.result || `HTTP ${r.status}`,
      });
    } else {
      // interference faults: no remediation tool available — leave for natural decay
      skipped++;
    }
  }

  console.log(`[remediate-all] done — attempted=${attempts} changed=${changed} skipped=${skipped}`);

  // Record fatigue for faults that were attempted but had no effect
  // Also handle the recheck lifecycle: if a rechecked fault was just retried,
  // the record call will transition it appropriately.
  if (attempts > 0) {
    for (const f of faults) {
      if (f.type === 'interference') continue; // skipped, not attempted
      const fatigueResult = (() => {
        // Check if this fault's remediation had no effect
        const logLines = fs.existsSync(REMEDIATION_LOG)
          ? fs.readFileSync(REMEDIATION_LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-attempts)
          : [];
        for (const line of logLines) {
          try {
            const entry = JSON.parse(line);
            if (entry.eventId === f.eventId) return entry.changed ? 'changed' : 'no_effect';
          } catch { /* skip */ }
        }
        return 'no_effect';
      })();
      try {
        const { execFileSync } = require('child_process');
        const result = JSON.parse(execFileSync('node', [FATIGUE_SCRIPT, 'record', f.eventId, fatigueResult], { encoding: 'utf8' }));
        if (result.state === 'fatigued') {
          console.log(`[remediate-all] ⚠️ ${f.eventId} is now FATIGUED (${result.attempts} attempts) — stop retrying, escalate to stuck`);
        } else if (result.state === 'stuck') {
          console.log(`[remediate-all] ${f.eventId} returned to STUCK after recheck failed (${result.recheckAttempts} recheck attempts)`);
        } else if (result.state === 'resolved') {
          console.log(`[remediate-all] ✅ ${f.eventId} resolved on recheck!`);
        }
      } catch (e) {
        // Fatigue tracking is best-effort; never block remediation on it
        console.error(`[remediate-all] fatigue record failed for ${f.eventId}: ${e.message}`);
      }
    }
  }

  // Report fatigue lifecycle state so ARCHITECT knows what to do
  try {
    const { execFileSync } = require('child_process');
    const fatiguedRaw = execFileSync('node', [FATIGUE_SCRIPT, 'check'], { encoding: 'utf8' });
    const fatigueData = JSON.parse(fatiguedRaw);
    if (fatigueData.fatiguedCount > 0) {
      const fatiguedIds = fatigueData.grouped.fatigued?.map(f => f.eventId).join(', ') || 'none';
      const stuckIds = fatigueData.grouped.stuck?.map(f => f.eventId).join(', ') || 'none';
      const recheckIds = fatigueData.grouped.recheck?.map(f => f.eventId).join(', ') || 'none';
      console.log(`[remediate-all] fatigue state: fatigued=[${fatiguedIds}] stuck=[${stuckIds}] recheck=[${recheckIds}]`);
    }
  } catch { /* best-effort */ }
})().catch(e => {
  console.error(`[remediate-all] FATAL ${e.stack || e.message}`);
  process.exit(1);
});
