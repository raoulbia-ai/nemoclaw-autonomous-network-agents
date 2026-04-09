/**
 * Dynamic PM counter generator.
 *
 * Combines:
 *   1. Deterministic per-cell baseline (cell "personality" from localId)
 *   2. Time-of-day load factor
 *   3. Active event effects (from network state)
 *   4. Small per-request noise
 *
 * Pure given its inputs — no I/O, no side effects.
 */

'use strict';

const { loadFactor } = require('./time-profile');
const config         = require('./config');

// ---------------------------------------------------------------------------
// Base PM values (healthy urban cell at peak load)
// ---------------------------------------------------------------------------

const BASE = {
  dlThpCell:          90.0,
  ulThpCell:          45.0,
  errorRate:           0.4,
  cellAvailTime:      99.6,
  pmRrcConnEstabSucc: 1520,
  pmRrcConnEstabAtt:  1530,
};

// ---------------------------------------------------------------------------
// Deterministic per-cell baseline variation
// Gives each cell a consistent "personality" without randomness at request time.
// Using localId as a deterministic seed → same cell always has the same baseline.
// ---------------------------------------------------------------------------

function cellBaseline(localId) {
  // Map localId to a stable factor in [0.88, 1.12]
  const seed   = ((localId * 37 + 13) % 100) / 100;   // 0..1
  const factor = 0.88 + seed * 0.24;
  return {
    dlThpCell:          BASE.dlThpCell          * factor,
    ulThpCell:          BASE.ulThpCell          * factor,
    errorRate:          BASE.errorRate          * (2 - factor),  // inverse: lower-perf cell → higher error rate
    cellAvailTime:      BASE.cellAvailTime,
    pmRrcConnEstabSucc: BASE.pmRrcConnEstabSucc,
    pmRrcConnEstabAtt:  BASE.pmRrcConnEstabAtt,
  };
}

// ---------------------------------------------------------------------------
// Apply a single event effect to a counter set
// ---------------------------------------------------------------------------

function applyEffect(counters, effects) {
  const out = { ...counters };
  for (const [key, op] of Object.entries(effects)) {
    if (!(key in out)) continue;
    switch (op.mode) {
      case 'set':   out[key] = op.value;              break;
      case 'scale': out[key] = out[key] * op.value;   break;
      case 'add':   out[key] = out[key] + op.value;   break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apply small random noise
// ---------------------------------------------------------------------------

function addNoise(val, fraction) {
  return val * (1 + (Math.random() - 0.5) * 2 * fraction);
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Generate 3GPP-shaped PM response for all cells.
 *
 * @param {Array<{id, site, localId}>} cells
 * @param {object|null} networkState - current network state (null → no events)
 * @param {Date}        now
 * @returns {object} 3GPP-shaped PM response { items, totalCount }
 */
function generate(cells, networkState, now) {
  const load         = loadFactor(now);
  const activeEvents = (networkState?.events ?? []).filter(e => !e.resolved);
  const items        = [];

  for (const cell of cells) {
    const base = cellBaseline(cell.localId);

    // 1. Apply time-of-day load (throughput scales with load; error/availability unaffected)
    let counters = {
      dlThpCell:          base.dlThpCell          * load,
      ulThpCell:          base.ulThpCell          * load,
      errorRate:          base.errorRate,
      cellAvailTime:      base.cellAvailTime,
      pmRrcConnEstabSucc: Math.round(base.pmRrcConnEstabSucc * load),
      pmRrcConnEstabAtt:  base.pmRrcConnEstabAtt,
    };

    // 2. Apply active event effects (first matching event wins per cell;
    //    equipment_fault takes priority over interference if somehow both apply)
    const EVENT_PRIORITY = ['equipment_fault', 'maintenance', 'backhaul_fault', 'interference'];
    for (const type of EVENT_PRIORITY) {
      const evt = activeEvents.find(e => e.type === type && e.affectedCells.includes(cell.id));
      if (evt) {
        counters = applyEffect(counters, config.EVENT_EFFECTS[type]);
        break;
      }
    }

    // 3. Per-request noise (applied last so degraded values also jitter slightly)
    const noise = config.REQUEST_NOISE;
    counters = {
      dlThpCell:          +Math.max(0, addNoise(counters.dlThpCell,     noise)).toFixed(1),
      ulThpCell:          +Math.max(0, addNoise(counters.ulThpCell,     noise)).toFixed(1),
      errorRate:          +Math.max(0, addNoise(counters.errorRate,     noise)).toFixed(2),
      cellAvailTime:      +Math.min(100, Math.max(0, addNoise(counters.cellAvailTime, noise / 2))).toFixed(1),
      pmRrcConnEstabSucc: Math.max(0, Math.round(addNoise(counters.pmRrcConnEstabSucc, noise))),
      pmRrcConnEstabAtt:  counters.pmRrcConnEstabAtt,
    };

    items.push({
      cellId:    cell.id,
      timestamp: now.toISOString(),
      counters,
    });
  }

  return { items, totalCount: items.length };
}

module.exports = { generate };
