/**
 * Domain-level alarm generation.
 *
 * Wraps the dataset-specific alarm generator (ireland/alarm-generator) behind
 * a stable interface.
 */

'use strict';

const alarmGenerator = require('../network/ireland/alarm-generator');

/**
 * Generate 3GPP-shaped FM alarms response.
 *
 * @param {Array<{id, site, localId}>} cells
 * @param {object|null}                networkState
 * @param {Date}                       now
 * @returns {object} { items, totalCount }
 */
function generate(cells, networkState, now) {
  return alarmGenerator.generate(cells, networkState, now);
}

module.exports = { generate };
