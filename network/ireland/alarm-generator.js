/**
 * Dynamic alarm generator.
 *
 * Generates 3GPP-shaped FM alarms from active events in the network state.
 *
 * Event → alarm mapping:
 *   equipment_fault (active)  → MAJOR alarm on affected cell
 *   backhaul_fault  (active)  → CRITICAL alarm per affected cell
 *   equipment_fault (resolved + ghostAlarm=true) → stale MAJOR alarm (ghost)
 *
 * Interference and maintenance do not raise alarms (perf-only signals).
 *
 * Pure given its inputs — no I/O, no side effects.
 */

'use strict';

function shortCellId(cellId) {
  const match = cellId.match(/NRCellDU=(\d+)/);
  return match ? `NRCellDU-${match[1]}` : cellId;
}

function siteFromCellId(cells, cellId) {
  return cells.find(c => c.id === cellId)?.site ?? 'unknown';
}

/**
 * @param {Array<{id, site, localId}>} cells
 * @param {object|null}                networkState
 * @param {Date}                       now
 * @returns {object} 3GPP-shaped FM alarms response { items, totalCount }
 */
function generate(cells, networkState, now) {
  const events = networkState?.events ?? [];
  const items  = [];
  const ts     = now.toISOString();

  for (const evt of events) {
    // Active equipment fault → MAJOR alarm
    if (evt.type === 'equipment_fault' && !evt.resolved) {
      const cellId = evt.affectedCells[0];
      items.push({
        alarmId:              evt.alarmId,
        managedObjectInstance: cellId,
        alarmType:            'CommunicationsAlarm',
        perceivedSeverity:    'MAJOR',
        probableCause:        'degradedSignal',
        specificProblem:      `DL throughput degraded below threshold`,
        alarmRaisedTime:      evt.startedAt,
        alarmChangedTime:     ts,
        additionalText:       `${shortCellId(cellId)} sustained throughput degradation.`,
      });
    }

    // Active backhaul fault → CRITICAL per cell
    if (evt.type === 'backhaul_fault' && !evt.resolved) {
      const site = siteFromCellId(cells, evt.affectedCells[0]);
      for (const cellId of evt.affectedCells) {
        items.push({
          alarmId:              `${evt.id}-${shortCellId(cellId)}`,
          managedObjectInstance: cellId,
          alarmType:            'CommunicationsAlarm',
          perceivedSeverity:    'CRITICAL',
          probableCause:        'transmissionError',
          specificProblem:      'Backhaul link degraded — site-level fault',
          alarmRaisedTime:      evt.startedAt,
          alarmChangedTime:     ts,
          additionalText:       `Site ${site} backhaul degradation. All cells at site affected.`,
        });
      }
    }

    // Ghost alarm: equipment_fault resolved but alarm not yet cleared
    if (evt.type === 'equipment_fault' && evt.resolved && evt.ghostAlarm) {
      const cellId = evt.affectedCells[0];
      items.push({
        alarmId:              evt.alarmId,
        managedObjectInstance: cellId,
        alarmType:            'CommunicationsAlarm',
        perceivedSeverity:    'MAJOR',
        probableCause:        'degradedSignal',
        specificProblem:      'DL throughput degraded below threshold (possible stale alarm)',
        alarmRaisedTime:      evt.startedAt,
        alarmChangedTime:     evt.resolvedAt,
        additionalText:       `POSSIBLE GHOST ALARM: ${shortCellId(cellId)} PM counters may have recovered. Alarm not yet cleared — verify manually.`,
      });
    }
  }

  return { items, totalCount: items.length };
}

module.exports = { generate };
