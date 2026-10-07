/**
 * Domain-level cell/site/topology access with hot-reload from growth zones.
 *
 * On startup, loads the base dataset from data-ireland.js (the 266 seed cells).
 * Every RELOAD_INTERVAL_MS, checks artifacts/accumulated-zones.json for new
 * growth zones added by ARCHITECT. If the file changed (by mtime), rebuilds
 * the full cell inventory by merging the base sites with growth-generated sites.
 *
 * This means SENTINEL/ORACLE see new cells without a server restart.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const baseData = require('../network/data-ireland');
const builder  = require('../network/ireland/builder');

const ZONES_FILE = process.env.ZONES_FILE || path.join(__dirname, '..', 'artifacts', 'accumulated-zones.json');
const RELOAD_INTERVAL_MS = 30_000; // check every 30s

const BASE_DN = 'SubNetwork=Ireland,MeContext={site},ManagedElement=1,GNBDUFunction=1';

// ---------------------------------------------------------------------------
// Mutable state — rebuilt when zones file changes
// ---------------------------------------------------------------------------

let currentSITES    = baseData.SITES;
let currentCELLS    = baseData.CELLS;
let currentCells    = baseData.cells;
let currentTopology = baseData.topology.cells;
let lastZonesMtime  = 0;

function cellUrn(siteId, localId) {
  return `urn:3gpp:dn:${BASE_DN.replace('{site}', siteId)},NRCellDU=${localId}`;
}

function sectorUrn(siteId, localId) {
  return `urn:3gpp:dn:${BASE_DN.replace('{site}', siteId)},NRSectorCarrier=${localId}`;
}

function buildCellsFromArrays(SITES, CELLS) {
  return CELLS.map(([si, localId]) => ({
    id: cellUrn(SITES[si].id, localId),
    site: SITES[si].id,
    localId,
    zone: SITES[si].zone,
    lat: SITES[si].lat,
    lon: SITES[si].lon,
  }));
}

function buildTopologyFromArrays(SITES, CELLS) {
  const cells = [], relationships = [];
  const date = new Date().toISOString().slice(0, 10);
  for (const [si, localId, nrpci, nrtac] of CELLS) {
    const site = SITES[si], urn = cellUrn(site.id, localId);
    cells.push({
      id: urn,
      attributes: { cellLocalId: localId, nCI: 10000 + localId, nRPCI: nrpci, nRTAC: nrtac },
      decorators: { site: site.id, lat: site.lat, lon: site.lon, zone: site.zone },
      classifiers: [], sourceIds: [urn],
      metadata: { reliabilityIndicator: 'OK', firstDiscovered: '2025-06-01T00:00:00Z', lastModified: `${date}T00:00:00Z` },
    });
    relationships.push({
      id: `urn:rel:NRCELLDU_USES_NRSECTORCARRIER:${localId}`,
      aSide: urn, bSide: sectorUrn(site.id, localId),
      metadata: { reliabilityIndicator: 'OK', firstDiscovered: '2025-06-01T00:00:00Z', lastModified: `${date}T00:00:00Z` },
    });
  }
  return {
    cells: {
      items: cells.map(c => ({ 'o-ran-smo-teiv-ran:NRCellDU': [c] })),
      totalCount: cells.length,
      _links: { self: { href: '/topology-inventory/v1/domains/RAN/entity-types/NRCellDU/entities' } },
    },
    relationships: {
      items: relationships.map(r => ({ 'o-ran-smo-teiv-ran:NRCELLDU_USES_NRSECTORCARRIER': [r] })),
      totalCount: relationships.length,
      _links: { self: { href: '/topology-inventory/v1/domains/RAN/relationship-types/NRCELLDU_USES_NRSECTORCARRIER/relationships' } },
    },
  };
}

// ---------------------------------------------------------------------------
// Hot reload
// ---------------------------------------------------------------------------

function tryReloadZones() {
  try {
    if (!fs.existsSync(ZONES_FILE)) return;

    const stat = fs.statSync(ZONES_FILE);
    const mtime = stat.mtimeMs;
    if (mtime === lastZonesMtime) return; // unchanged
    lastZonesMtime = mtime;

    const zones = JSON.parse(fs.readFileSync(ZONES_FILE, 'utf8'));
    if (!Array.isArray(zones) || zones.length === 0) return;

    // Build growth sites from accumulated zones using the existing builder
    const design = { zones, cells_per_site: { urban: 4, suburban: 4, rural: 3, motorway: 3 } };
    const growth = builder.buildNetwork(design);

    // Merge: base sites first, then growth sites (with adjusted indices)
    const mergedSITES = [...baseData.SITES, ...growth.SITES];

    // Rebuild CELLS with correct siteIdx offsets for growth cells
    const baseOffset = baseData.SITES.length;
    const baseCellIdMax = baseData.CELLS.reduce((max, c) => Math.max(max, c[1]), 0);
    const basePciMax = baseData.CELLS.reduce((max, c) => Math.max(max, c[2]), 0);

    const mergedCELLS = [...baseData.CELLS];
    for (const [si, localId, nrpci, nrtac] of growth.CELLS) {
      mergedCELLS.push([
        si + baseOffset,
        localId + baseCellIdMax,
        (nrpci + basePciMax + 1) % 1008,
        nrtac,
      ]);
    }

    // Rebuild derived data
    currentSITES    = mergedSITES;
    currentCELLS    = mergedCELLS;
    currentCells    = buildCellsFromArrays(mergedSITES, mergedCELLS);
    currentTopology = buildTopologyFromArrays(mergedSITES, mergedCELLS).cells;

    console.log(`[cells] hot-reload: ${zones.length} growth zones merged — ${mergedSITES.length} sites, ${mergedCELLS.length} cells total`);
  } catch (err) {
    console.error('[cells] hot-reload failed (keeping previous data):', err.message);
  }
}

// Initial load + periodic check
tryReloadZones();
setInterval(tryReloadZones, RELOAD_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Public API (same interface as before)
// ---------------------------------------------------------------------------

function getCells()    { return currentCells; }
function getTopology() { return currentTopology; }
function getSites()    { return currentSITES; }
function getRawCells() { return currentCELLS; }

module.exports = { getCells, getTopology, getSites, getRawCells, cellUrn, sectorUrn };
