/**
 * Domain layer — unified facade for network data, state, and generation.
 *
 * All server.js handlers and agent tools should import from here instead
 * of reaching into network/data-ireland.js or network/ireland/* directly.
 * When a second region is added, only the sub-modules change.
 *
 * Usage:
 *   const domain = require('../domain');
 *   domain.cells.getCells()
 *   domain.state.loadCached()
 *   domain.pm.generate(cells, state, now)
 */

'use strict';

const cells  = require('./cells');
const state  = require('./state');
const pm     = require('./pm');
const alarms = require('./alarms');
const urn    = require('./urn');

module.exports = { cells, state, pm, alarms, urn };
