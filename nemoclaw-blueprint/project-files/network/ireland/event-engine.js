/**
 * Ireland network event engine.
 *
 * Runs as a separate process alongside the network server.
 * On each tick: resolves expired events, probabilistically spawns new ones,
 * persists updated state to network/ireland/state.json.
 *
 * Usage:
 *   node network/ireland/event-engine.js              — normal mode (5-min ticks)
 *   FAST_MODE=1 node network/ireland/event-engine.js  — fast mode (30s ticks, 10× spawn rate)
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const networkState = require('./state');
const config       = require('./config');

let nextEventId = 1;

// ---------------------------------------------------------------------------
// Event history log — ground truth for auditing agent decisions
// ---------------------------------------------------------------------------

const EVENT_LOG_FILE = path.join(__dirname, '..', '..', 'artifacts', 'event-history.jsonl');

function logEvent(action, evt, extra = {}) {
  const entry = {
    at: new Date().toISOString(),
    action,
    eventId: evt.id,
    type: evt.type,
    cells: evt.affectedCells.map(shortId),
    ghostAlarm: evt.ghostAlarm || false,
    ...extra,
  };
  try {
    fs.appendFileSync(EVENT_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

// ---------------------------------------------------------------------------
// Weather-correlated fault spawning
// ---------------------------------------------------------------------------

const EXTERNAL_CONTEXT_FILE = path.join(__dirname, '..', '..', 'artifacts', 'external-context.json');

// Risk → spawn probability multiplier
const RISK_MULTIPLIERS = {
  'storm-warning-red':    5.0,
  'storm-warning-orange': 3.0,
  'storm-warning-yellow': 1.5,
  'high-wind':            2.0,
  'event-load':           1.0,  // events don't cause faults
};

// Extract county from site ID: "Dublin-City-Centre-001" → "Dublin"
// "Tralee-001" → "Tralee" → county via lookup
// Town/city → county lookup (covers all site ID prefixes in data-ireland.js)
const TOWN_TO_COUNTY = {
  'dublin': 'Dublin', 'dun laoghaire': 'Dublin',
  'cork': 'Cork', 'cobh': 'Cork', 'mallow': 'Cork',
  'galway': 'Galway', 'tuam': 'Galway', 'oranmore': 'Galway', 'loughrea': 'Galway',
  'limerick': 'Limerick', 'newcastle west': 'Limerick', 'castleconnell': 'Limerick',
  'waterford': 'Waterford', 'dungarvan': 'Waterford',
  'tralee': 'Kerry', 'killarney': 'Kerry', 'kenmare': 'Kerry', 'dingle': 'Kerry',
  'sligo': 'Sligo', 'strandhill': 'Sligo',
  'donegal': 'Donegal', 'letterkenny': 'Donegal', 'buncrana': 'Donegal',
  'ballyshannon': 'Donegal', 'bundoran': 'Donegal',
  'monaghan': 'Monaghan', 'cavan': 'Cavan', 'carlow': 'Carlow', 'tullow': 'Carlow',
  'wexford': 'Wexford', 'enniscorthy': 'Wexford',
  'clonmel': 'Tipperary', 'tipperary': 'Tipperary', 'nenagh': 'Tipperary', 'cashel': 'Tipperary',
  'roscommon': 'Roscommon', 'longford': 'Longford', 'ballymore': 'Longford',
  'carrick on shannon': 'Leitrim',
  'mullingar': 'Westmeath', 'athlone': 'Westmeath',
  'drogheda': 'Louth', 'dundalk': 'Louth', 'navan': 'Meath',
  'kilkenny': 'Kilkenny', 'newbridge': 'Kildare', 'naas': 'Kildare',
  'wicklow': 'Wicklow', 'bray': 'Wicklow',
  'ennis': 'Clare', 'castlebar': 'Mayo', 'westport': 'Mayo', 'newcastle west': 'Limerick',
  'tullamore': 'Offaly', 'portlaoise': 'Laois',
};

function siteToCounty(siteId) {
  // "Dublin-City-Centre-001" → strip trailing "-NNN"
  const prefix = siteId.replace(/-\d{3}$/, '');
  // Try full prefix first (handles "Newcastle-West" → "newcastle west")
  const fullTown = prefix.replace(/-/g, ' ').toLowerCase();
  if (TOWN_TO_COUNTY[fullTown]) return TOWN_TO_COUNTY[fullTown];
  // Then try stripping zone suffixes
  const suffixes = ['-Town', '-City-Centre', '-City', '-Centre', '-North', '-South', '-East', '-West', '-Suburbs'];
  let base = prefix;
  for (const s of suffixes) {
    if (base.endsWith(s)) { base = base.slice(0, -s.length); break; }
  }
  const town = base.replace(/-/g, ' ').toLowerCase();
  return TOWN_TO_COUNTY[town] ?? null;
}

function loadZoneRisks() {
  try {
    const data = JSON.parse(fs.readFileSync(EXTERNAL_CONTEXT_FILE, 'utf8'));
    return data.zoneRisks ?? {};
  } catch {
    return {};
  }
}

function getCountyMultiplier(county, zoneRisks) {
  const risk = zoneRisks[county];
  if (!risk || risk === 'none') return 1.0;
  return RISK_MULTIPLIERS[risk] ?? 1.0;
}

// ---------------------------------------------------------------------------
// Fault spreading — geographic proximity
// ---------------------------------------------------------------------------

const SPREAD_INNER_KM = 3;   // strong spread radius
const SPREAD_OUTER_KM = 8;   // weak spread radius
const SPREAD_INNER_MULT = 4.0;
const SPREAD_OUTER_MULT = 2.0;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Pre-computed site coordinate lookup (populated in main())
let siteCoords = {};

function findNearbySites(faultedSiteId, allSites) {
  const origin = siteCoords[faultedSiteId];
  if (!origin) return [];
  const nearby = [];
  for (const site of allSites) {
    if (site.id === faultedSiteId) continue;
    const d = haversineKm(origin.lat, origin.lon, site.lat, site.lon);
    if (d <= SPREAD_INNER_KM) {
      nearby.push({ site: site.id, distance: d, multiplier: SPREAD_INNER_MULT });
    } else if (d <= SPREAD_OUTER_KM) {
      nearby.push({ site: site.id, distance: d, multiplier: SPREAD_OUTER_MULT });
    }
  }
  return nearby;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function minutesToMs(minutes) {
  return minutes * 60_000;
}

function shortId(cellId) {
  const match = cellId.match(/NRCellDU=(\d+)/);
  return match ? `NRCellDU-${match[1]}` : cellId;
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

function pickAffectedCells(cells, type) {
  const ids   = cells.map(c => c.id);
  const sites = [...new Set(cells.map(c => c.site))];

  switch (type) {
    case 'equipment_fault':
    case 'maintenance':
      return [randomItem(ids)];

    case 'backhaul_fault': {
      const site = randomItem(sites);
      return cells.filter(c => c.site === site).map(c => c.id);
    }

    case 'interference': {
      // 4–6 cells; prefer cells from neighbouring sites for realism
      const count    = 4 + Math.floor(Math.random() * 3);
      const shuffled = [...ids].sort(() => Math.random() - 0.5);
      return shuffled.slice(0, count);
    }

    default:
      return [];
  }
}

function makeEvent(type, cells, now) {
  const [dMin, dMax] = config.EVENT_DURATION_MINUTES[type];
  const durationMs   = minutesToMs(randomBetween(dMin, dMax));
  const id           = `evt-${String(nextEventId++).padStart(4, '0')}`;

  return {
    id,
    type,
    affectedCells:  pickAffectedCells(cells, type),
    startedAt:      now.toISOString(),
    resolveAt:      new Date(now.getTime() + durationMs).toISOString(),
    resolved:       false,
    resolvedAt:     null,
    ghostAlarm:     false,
    ghostAlarmExpiresAt: null,
    // Only equipment_fault raises a named alarm
    alarmId: type === 'equipment_fault'
      ? `ALM-${now.getFullYear()}-${String(nextEventId + 999).slice(-4)}`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

function tick(state, cells, now) {
  state.lastTickAt = now.toISOString();
  state.tickCount++;

  // 1. Resolve expired events; possibly leave ghost alarms
  for (const evt of state.events) {
    if (evt.resolved) {
      // Expire any active ghost alarm
      if (evt.ghostAlarm && evt.ghostAlarmExpiresAt && new Date(evt.ghostAlarmExpiresAt) <= now) {
        evt.ghostAlarm = false;
        console.log(`[event-engine] ghost alarm cleared for ${evt.alarmId}`);
        logEvent('ghost_alarm_expired', evt);
      }
      continue;
    }

    if (new Date(evt.resolveAt) <= now) {
      evt.resolved   = true;
      evt.resolvedAt = now.toISOString();

      const label = evt.affectedCells.map(shortId).join(', ');
      console.log(`[event-engine] resolved ${evt.type} → ${label}`);
      logEvent('resolved', evt);

      if (evt.type === 'equipment_fault' && Math.random() < config.GHOST_ALARM_PROBABILITY) {
        const [gMin, gMax] = config.GHOST_ALARM_DURATION_MINUTES;
        evt.ghostAlarm          = true;
        evt.ghostAlarmExpiresAt = new Date(
          now.getTime() + minutesToMs(randomBetween(gMin, gMax))
        ).toISOString();
        console.log(`[event-engine] ghost alarm set for ${evt.alarmId} (expires ${evt.ghostAlarmExpiresAt.slice(11, 16)})`);
        logEvent('ghost_alarm_created', evt, { expiresAt: evt.ghostAlarmExpiresAt });
      }
    }
  }

  // 2. Prune old resolved events (keep 2 hours of history for context)
  const historyMs = 2 * 60 * 60_000;
  state.events = state.events.filter(evt =>
    !evt.resolved ||
    evt.ghostAlarm ||
    (evt.resolvedAt && now.getTime() - new Date(evt.resolvedAt).getTime() < historyMs)
  );

  // 3. Spawn new events (weather-correlated)
  const zoneRisks = loadZoneRisks();
  const hasRisks  = Object.keys(zoneRisks).length > 0;

  for (const [type, baseProb] of Object.entries(config.SPAWN_PROBABILITY)) {
    // Weather only boosts equipment_fault, interference, backhaul_fault — not maintenance
    const weatherTypes = ['equipment_fault', 'interference', 'backhaul_fault'];

    if (hasRisks && weatherTypes.includes(type)) {
      // Try spawning per county — cells in storm-warned counties get boosted probability
      const activeCount = state.events.filter(e => e.type === type && !e.resolved).length;
      if (activeCount >= config.MAX_CONCURRENT[type]) continue;

      // Group cells by county
      const cellsByCounty = {};
      for (const cell of cells) {
        const county = siteToCounty(cell.site);
        if (!county) continue;
        (cellsByCounty[county] ??= []).push(cell);
      }

      // Roll once per county that has a risk multiplier > 1
      let spawned = false;
      for (const [county, mult] of Object.entries(zoneRisks).map(
        ([c, r]) => [c, RISK_MULTIPLIERS[r] ?? 1.0]
      )) {
        if (mult <= 1.0) continue;
        if (Math.random() > baseProb * mult) continue;
        const countyCells = cellsByCounty[county];
        if (!countyCells || countyCells.length === 0) continue;

        const evt = makeEvent(type, countyCells, now);
        state.events.push(evt);
        const label = evt.affectedCells.map(shortId).join(', ');
        console.log(`[event-engine] +${evt.type} → ${label} [${county} ${zoneRisks[county]}] (until ${evt.resolveAt.slice(11, 16)})`);
        logEvent('spawned', evt, { trigger: 'weather', county, risk: zoneRisks[county] });
        spawned = true;
        break; // one weather-correlated spawn per type per tick
      }

      // Also roll the base probability for non-weather faults
      if (!spawned && Math.random() <= baseProb) {
        const evt   = makeEvent(type, cells, now);
        const label = evt.affectedCells.map(shortId).join(', ');
        state.events.push(evt);
        console.log(`[event-engine] +${evt.type} → ${label} (until ${evt.resolveAt.slice(11, 16)})`);
        logEvent('spawned', evt, { trigger: 'random' });
      }
    } else {
      // Non-weather types (maintenance) — original logic
      if (Math.random() > baseProb) continue;

      const activeCount = state.events.filter(e => e.type === type && !e.resolved).length;
      if (activeCount >= config.MAX_CONCURRENT[type]) continue;

      const evt   = makeEvent(type, cells, now);
      const label = evt.affectedCells.map(shortId).join(', ');
      state.events.push(evt);
      console.log(`[event-engine] +${evt.type} → ${label} (until ${evt.resolveAt.slice(11, 16)})`);
      logEvent('spawned', evt, { trigger: 'random' });
    }
  }

  // 4. Fault spreading — active backhaul faults boost interference on nearby sites
  const activeBackhauls = state.events.filter(e => e.type === 'backhaul_fault' && !e.resolved);
  if (activeBackhauls.length > 0) {
    const interferenceCount = state.events.filter(e => e.type === 'interference' && !e.resolved).length;
    if (interferenceCount < config.MAX_CONCURRENT.interference) {
      const baseIntProb = config.SPAWN_PROBABILITY.interference;

      for (const bh of activeBackhauls) {
        // Find the site of the backhaul fault
        const faultedSiteId = cells.find(c => bh.affectedCells.includes(c.id))?.site;
        if (!faultedSiteId) continue;

        const allSites = [...new Set(cells.map(c => c.site))].map(siteId => {
          const coords = siteCoords[siteId];
          return coords ? { id: siteId, lat: coords.lat, lon: coords.lon } : null;
        }).filter(Boolean);

        const nearby = findNearbySites(faultedSiteId, allSites);
        for (const { site: nearbySiteId, multiplier, distance } of nearby) {
          if (Math.random() > baseIntProb * multiplier) continue;

          const siteCells = cells.filter(c => c.site === nearbySiteId);
          if (siteCells.length === 0) continue;

          const evt = makeEvent('interference', siteCells, now);
          state.events.push(evt);
          const label = evt.affectedCells.map(shortId).join(', ');
          console.log(`[event-engine] +interference → ${label} [spread from ${faultedSiteId}, ${distance.toFixed(1)}km] (until ${evt.resolveAt.slice(11, 16)})`);
          logEvent('spawned', evt, { trigger: 'backhaul_spread', source: faultedSiteId, distance: distance.toFixed(1) });
          break; // one spread event per backhaul per tick
        }
      }
    }
  }

  return state;
}

// ---------------------------------------------------------------------------
// Seed initial equipment fault on a fresh network (cell 7 = original anomaly)
// ---------------------------------------------------------------------------

function seedInitialFault(state, cells, now) {
  const target = cells.find(c => c.localId === 7);
  if (!target) return;

  const [dMin, dMax] = config.EVENT_DURATION_MINUTES.equipment_fault;
  const durationMs   = minutesToMs(randomBetween(dMin, dMax));
  const id           = `evt-${String(nextEventId++).padStart(4, '0')}`;

  state.events.push({
    id,
    type:           'equipment_fault',
    affectedCells:  [target.id],
    startedAt:      now.toISOString(),
    resolveAt:      new Date(now.getTime() + durationMs).toISOString(),
    resolved:       false,
    resolvedAt:     null,
    ghostAlarm:     false,
    ghostAlarmExpiresAt: null,
    alarmId:        `ALM-${now.getFullYear()}-0341`,
  });

  console.log(`[event-engine] seeded equipment_fault on NRCellDU-7 (until ${
    state.events[state.events.length - 1].resolveAt.slice(11, 16)
  })`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { SITES, CELLS, cellUrn } = require('../data-ireland');

  const cells = CELLS.map(([siteIdx, localId]) => ({
    id:      cellUrn(SITES[siteIdx].id, localId),
    site:    SITES[siteIdx].id,
    localId,
  }));

  // Build site coordinate lookup for fault spreading
  for (const site of SITES) {
    siteCoords[site.id] = { lat: site.lat, lon: site.lon };
  }

  const now   = new Date();
  let state   = networkState.load();
  let isNew   = false;

  if (!state) {
    state = networkState.init(cells);
    isNew = true;
  } else {
    // Re-sync nextEventId from persisted events
    for (const evt of state.events) {
      const n = parseInt(evt.id.replace('evt-', ''), 10);
      if (!isNaN(n) && n >= nextEventId) nextEventId = n + 1;
    }
    const active = state.events.filter(e => !e.resolved).length;
    console.log(`[event-engine] resuming network (tick ${state.tickCount}, ${active} active events)`);
  }

  if (isNew) {
    seedInitialFault(state, cells, now);
    networkState.save(state);
    console.log(`[event-engine] network initialised`);
  }

  function runTick() {
    const t     = new Date();
    // Reload from disk so any external mutations (e.g. server-side
    // remediation endpoints) are honored instead of being clobbered by
    // our stale in-memory copy. The engine is still the only writer for
    // ticks, but it is no longer the only writer overall.
    const fresh = networkState.load();
    if (fresh) state = fresh;
    state       = tick(state, cells, t);
    networkState.save(state);

    const active = state.events.filter(e => !e.resolved);
    if (active.length > 0) {
      const summary = active.map(e =>
        `${e.type}(${e.affectedCells.map(shortId).join(',')})`
      ).join(' | ');
      console.log(`[event-engine] tick ${state.tickCount} — ${summary}`);
    } else {
      console.log(`[event-engine] tick ${state.tickCount} — no active events`);
    }
  }

  // First tick immediately, then on interval
  runTick();
  setInterval(runTick, config.TICK_INTERVAL_MS);
  console.log(`[event-engine] running — tick every ${config.TICK_INTERVAL_MS / 1000}s, FAST_MODE=${process.env.FAST_MODE === '1'}`);
}

module.exports = { tick };

if (require.main === module) main();
