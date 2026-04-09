#!/usr/bin/env node
/**
 * Log a growth wave — derives everything from city-params.json automatically.
 *
 * Usage:
 *   node log-growth.js [--note "description"]
 *
 * The script reads city-params.json newZones and state.json to auto-compute:
 *   - wave number (state.growth_wave_count + 1)
 *   - sites added (newZones.length)
 *   - cells added (sum of newZones[].cells)
 *   - counties (unique from newZones[].county)
 *
 * The LLM's job is to write city-params.json with newZones. This script handles
 * all deterministic bookkeeping: counters, logging, state updates.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ARTIFACTS       = path.join(__dirname, '..', '..', '..', 'artifacts');
const GROWTH_LOG      = path.join(ARTIFACTS, 'growth-log.json');
const STATE_FILE      = path.join(ARTIFACTS, 'state.json');
const COMMS_FILE      = path.join(ARTIFACTS, 'agent-comms.jsonl');
const CITY_PARAMS     = path.join(ARTIFACTS, 'city-params.json');
const ACCUMULATED     = path.join(ARTIFACTS, 'accumulated-zones.json');

// Fail fast if artifacts dir doesn't exist
if (!fs.existsSync(ARTIFACTS)) {
  console.error(`[log-growth] Artifacts dir not found: ${ARTIFACTS}`);
  process.exit(1);
}

// --- Parse optional --note arg ---
const noteIdx = process.argv.indexOf('--note');
const note = noteIdx !== -1 ? (process.argv[noteIdx + 1] || '') : '';

// --- Read city-params.json for newZones ---
if (!fs.existsSync(CITY_PARAMS)) {
  console.error('[log-growth] city-params.json not found');
  process.exit(1);
}

const params = JSON.parse(fs.readFileSync(CITY_PARAMS, 'utf8'));
const newZones = params.newZones || [];

if (newZones.length === 0) {
  console.log('[log-growth] No newZones in city-params.json — nothing to log');
  process.exit(0);
}

// --- Derive all values from newZones (LLM doesn't compute these) ---
const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  : { growth_wave_count: 0 };

const wave       = (state.growth_wave_count || 0) + 1;
const sitesAdded = newZones.length;
const cellsAdded = newZones.reduce((sum, z) => sum + (z.cells || 0), 0);
const counties   = [...new Set(newZones.map(z => z.county).filter(Boolean))];

console.log(`[log-growth] Wave ${wave}: +${sitesAdded} sites, +${cellsAdded} cells, counties: ${counties.join(', ')}`);

// --- Read existing growth log ---
let entries = [];
if (fs.existsSync(GROWTH_LOG)) {
  const raw = fs.readFileSync(GROWTH_LOG, 'utf8').trim();
  if (raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      entries = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      console.error(`[log-growth] Could not parse ${GROWTH_LOG}: ${e.message}`);
      process.exit(1);
    }
  }
}

// --- Duplicate wave guard ---
const existingWaves = new Set(entries.filter(e => !e.phantom).map(e => e.wave));
if (existingWaves.has(wave)) {
  console.warn(`[log-growth] Wave ${wave} already exists. Clearing stale newZones.`);
  params.newZones = [];
  fs.writeFileSync(CITY_PARAMS, JSON.stringify(params, null, 2) + '\n', 'utf8');
  process.exit(0);
}

// --- Build entry ---
const entry = {
  at: new Date().toISOString(),
  wave,
  sitesAdded,
  cellsAdded,
  counties,
};
if (note) entry.note = note;

entries.push(entry);

// --- Atomic write growth-log.json ---
const tmp = path.join(os.tmpdir(), `growth-log-${process.pid}.json.tmp`);
fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf8');
fs.renameSync(tmp, GROWTH_LOG);

// --- Update state.json ---
state.growth_wave_count = wave;
state.last_growth_at = entry.at;
const tmpState = path.join(os.tmpdir(), `state-${process.pid}.json.tmp`);
fs.writeFileSync(tmpState, JSON.stringify(state, null, 2) + '\n', 'utf8');
fs.renameSync(tmpState, STATE_FILE);

// --- Append to agent-comms.jsonl ---
const commsEntry = {
  at: entry.at,
  from: 'ARCHITECT',
  to: 'ALL',
  type: 'growth',
  message: `Growth wave ${wave}: +${sitesAdded} sites, +${cellsAdded} cells in ${counties.join(', ')}. ${note}`.trim(),
};
fs.appendFileSync(COMMS_FILE, JSON.stringify(commsEntry) + '\n');

// --- Append newZones to accumulated-zones.json (persistent record of all growth) ---
let accumulated = [];
if (fs.existsSync(ACCUMULATED)) {
  try { accumulated = JSON.parse(fs.readFileSync(ACCUMULATED, 'utf8')); } catch {}
}
const existingNames = new Set(accumulated.map(z => z.name));
const zonesForAccum = newZones.map(z => ({
  name:       z.site || z.name,
  county:     z.county || '',
  type:       z.type || 'suburban',
  lat:        z.lat,
  lon:        z.lon,
  radius_km:  z.radius_km || (z.type === 'urban' ? 3 : z.type === 'rural' ? 5 : 2),
  site_count: z.site_count || 1,
})).filter(z => !existingNames.has(z.name));

if (zonesForAccum.length > 0) {
  accumulated.push(...zonesForAccum);
  fs.writeFileSync(ACCUMULATED, JSON.stringify(accumulated, null, 2));
  console.log(`[log-growth] +${zonesForAccum.length} zones added to accumulated-zones.json (total: ${accumulated.length})`);
}

// --- Clear newZones from city-params (consumed) ---
params.newZones = [];
fs.writeFileSync(CITY_PARAMS, JSON.stringify(params, null, 2) + '\n', 'utf8');

// --- Log decision for retrospective analysis ---
try {
  const logDecision = require('./log-decision');
  // Read latest ORACLE advisory for context
  let advisory = null;
  if (fs.existsSync(COMMS_FILE)) {
    const lines = fs.readFileSync(COMMS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.from === 'ORACLE' && e.to === 'ARCHITECT' && e.type === 'advisory') {
          advisory = e.message;
          break;
        }
      } catch {}
    }
  }
  logDecision({
    agent: 'ARCHITECT',
    decision: 'grow',
    wave,
    cellsAfter: cellsAdded,
    counties,
    advisory,
    reasoning: note || `Wave ${wave}: ${counties.join(', ')}`,
  });
} catch {}

console.log(`[log-growth] Done. State: wave=${wave}, growth-log: ${entries.length} entries`);

// --- Run autonomy-monitor if available ---
try {
  const monitorPath = path.join(__dirname, 'autonomy-monitor.js');
  if (fs.existsSync(monitorPath)) {
    require('child_process').execSync(`node "${monitorPath}"`, { stdio: 'inherit', timeout: 10000 });
  }
} catch { /* non-fatal */ }
