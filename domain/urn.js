/**
 * 3GPP cell URN parsing — domain-level utility.
 *
 * Extracted from server.js so it can be reused by any handler or tool
 * without pulling in the full server.
 *
 *   urn:3gpp:dn:SubNetwork=Ireland,MeContext=Dublin-City-Centre-007,
 *     ManagedElement=1,GNBDUFunction=1,NRCellDU=31
 *   → { siteId: 'Dublin-City-Centre-007', cellId: 'NRCellDU-31' }
 */

'use strict';

/**
 * Parse a 3GPP DN URN into site and cell components.
 * @param {string} urn
 * @returns {{ siteId: string|null, cellId: string|null }}
 */
function parseCellUrn(urn) {
  const site = (urn.match(/MeContext=([^,]+)/) || [])[1] || null;
  const cell = (urn.match(/NRCellDU=([^,]+)/) || [])[1] || null;
  return { siteId: site, cellId: cell ? `NRCellDU-${cell}` : null };
}

/**
 * Extract the short cell ID from a full URN or short form.
 *   "urn:3gpp:dn:...,NRCellDU=31" → "NRCellDU-31"
 *   "NRCellDU-31" → "NRCellDU-31"
 * @param {string} cellId
 * @returns {string}
 */
function shortCellId(cellId) {
  const match = cellId.match(/NRCellDU[=-](\d+)/);
  return match ? `NRCellDU-${match[1]}` : cellId;
}

/**
 * Extract the numeric part of a cell ID.
 *   "NRCellDU-31" or "NRCellDU=31" → "31"
 * @param {string} cellId
 * @returns {string|null}
 */
function cellNum(cellId) {
  const match = cellId.match(/NRCellDU[=-](\d+)/);
  return match ? match[1] : null;
}

module.exports = { parseCellUrn, shortCellId, cellNum };
