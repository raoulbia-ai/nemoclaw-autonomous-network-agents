'use strict';
/**
 * normalize.js — post-process raw EIAP artifacts into WebUI-ready format.
 * Called by collect.sh after fetching raw data.
 * Writes: topology.json (normalized), performance.json (classified), alarms.json (classified), signals.json
 */

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '../../..');
const ARTIFACTS = path.join(ROOT, 'artifacts');

const THRESHOLDS = {
  DL_THP_MIN_MBPS:   25,
  ERROR_RATE_MAX_PCT: 2,
  AVAIL_MIN_PCT:     95,
};

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS, `${name}.json`), 'utf8'));
}

function write(name, data) {
  fs.writeFileSync(path.join(ARTIFACTS, `${name}.json`), JSON.stringify(data, null, 2));
}

// ── Topology ──────────────────────────────────────────────────────────────────
const rawTopo = read('topology');
const cellList = rawTopo.items.map(item => {
  const cell = item['o-ran-smo-teiv-ran:NRCellDU'][0];
  return {
    id:                  cell.id,
    cellLocalId:         cell.attributes.cellLocalId,
    nCI:                 cell.attributes.nCI,
    nRPCI:               cell.attributes.nRPCI,
    nRTAC:               cell.attributes.nRTAC,
    site:                cell.decorators.site,
    lat:                 cell.decorators.lat,
    lon:                 cell.decorators.lon,
    reliabilityIndicator: cell.metadata?.reliabilityIndicator,
    lastModified:         cell.metadata?.lastModified,
  };
});

const siteMap = {};
for (const cell of cellList) {
  if (!siteMap[cell.site]) siteMap[cell.site] = [];
  siteMap[cell.site].push(cell.id);
}

write('topology', {
  collectedAt: new Date().toISOString(),
  totalCells:  cellList.length,
  sites: Object.entries(siteMap).map(([siteId, cellIds]) => ({ siteId, cellCount: cellIds.length, cellIds })),
  cells: cellList,
});

// ── Performance ───────────────────────────────────────────────────────────────
const rawPerf = read('performance');
const perfCells = rawPerf.items;

const avgDl = perfCells.reduce((sum, c) => sum + c.counters.dlThpCell, 0) / (perfCells.length || 1);

const outliers = [], elevated = [], normal = [];
for (const cell of perfCells) {
  const c = cell.counters;
  const flags = [];
  if (c.dlThpCell    < THRESHOLDS.DL_THP_MIN_MBPS)    flags.push(`dlThp degraded (${c.dlThpCell} Mbps, threshold ${THRESHOLDS.DL_THP_MIN_MBPS})`);
  if (c.errorRate    > THRESHOLDS.ERROR_RATE_MAX_PCT)  flags.push(`errorRate elevated (${c.errorRate}%, threshold ${THRESHOLDS.ERROR_RATE_MAX_PCT}%)`);
  if (c.cellAvailTime < THRESHOLDS.AVAIL_MIN_PCT)      flags.push(`availability degraded (${c.cellAvailTime}%, threshold ${THRESHOLDS.AVAIL_MIN_PCT}%)`);
  const entry = { cellId: cell.cellId, timestamp: cell.timestamp, counters: c, flags };
  if      (flags.length >= 2) outliers.push(entry);
  else if (flags.length === 1) elevated.push(entry);
  else                         normal.push(entry);
}

write('performance', {
  collectedAt:  new Date().toISOString(),
  totalCells:   perfCells.length,
  avgDlThpMbps: +avgDl.toFixed(1),
  summary:      { outliers: outliers.length, elevated: elevated.length, normal: normal.length },
  outliers, elevated, normal,
});

// ── Alarms ────────────────────────────────────────────────────────────────────
const rawAlarms = read('alarms');
const alarmItems = rawAlarms.items;

const SEVERITY_ORDER = { CRITICAL: 0, MAJOR: 1, MINOR: 2, WARNING: 3, INDETERMINATE: 4 };
const bySeverity = {};
for (const alarm of alarmItems) {
  const sev = alarm.perceivedSeverity;
  if (!bySeverity[sev]) bySeverity[sev] = [];
  bySeverity[sev].push(alarm);
}
const affectedCells = [...new Set(alarmItems.map(a => a.managedObjectInstance))];

write('alarms', {
  collectedAt:   new Date().toISOString(),
  totalAlarms:   alarmItems.length,
  affectedCells,
  bySeverity:    Object.fromEntries(
    Object.entries(bySeverity).sort(([a], [b]) => (SEVERITY_ORDER[a] ?? 99) - (SEVERITY_ORDER[b] ?? 99))
  ),
  alarms: [...alarmItems].sort((a, b) => (SEVERITY_ORDER[a.perceivedSeverity] ?? 99) - (SEVERITY_ORDER[b.perceivedSeverity] ?? 99)),
});

// ── Signals ───────────────────────────────────────────────────────────────────
const topology   = read('topology');
const performance = read('performance');
const alarms      = read('alarms');

const perfFlagged  = new Set([...performance.outliers.map(c => c.cellId), ...performance.elevated.map(c => c.cellId)]);
const alarmFlagged = new Set(alarms.affectedCells);

const crossZone = [...perfFlagged].filter(id => alarmFlagged.has(id)).map(cellId => {
  const perfEntry   = [...performance.outliers, ...performance.elevated].find(c => c.cellId === cellId);
  const alarmEntries = alarms.alarms
    .filter(a => a.managedObjectInstance === cellId)
    .map(a => ({ alarmId: a.alarmId, severity: a.perceivedSeverity, problem: a.specificProblem }));
  return { cellId, perfFlags: perfEntry?.flags ?? [], alarms: alarmEntries, signal: 'CELL FLAGGED BY BOTH PERFORMANCE AND ALARM AGENTS — HIGH INTEREST' };
});

write('signals', {
  collectedAt: new Date().toISOString(),
  crossZoneSignals: crossZone,
  summary: {
    totalCells:    topology.totalCells,
    perfOutliers:  performance.summary.outliers,
    perfElevated:  performance.summary.elevated,
    activeAlarms:  alarms.totalAlarms,
    crossZoneHits: crossZone.length,
  },
});

console.log(`[normalize] ${topology.totalCells} cells | outliers: ${performance.summary.outliers} | elevated: ${performance.summary.elevated} | alarms: ${alarms.totalAlarms} | cross-zone: ${crossZone.length}`);
