/**
 * Domain-level PM counter generation.
 *
 * Wraps the dataset-specific PM generator (ireland/pm-generator) behind
 * a stable interface. Callers pass cells + state + timestamp; the domain
 * layer handles the wiring.
 */

'use strict';

const pmGenerator = require('../network/ireland/pm-generator');

/**
 * Generate 3GPP-shaped PM response for all cells.
 *
 * @param {Array<{id, site, localId}>} cells
 * @param {object|null}                networkState
 * @param {Date}                       now
 * @returns {object} { items, totalCount }
 */
function generate(cells, networkState, now) {
  return pmGenerator.generate(cells, networkState, now);
}

module.exports = { generate };
