#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const BOUNDARY_PATH = path.join(ROOT, 'data', 'ireland-boundary.geojson');
const CITY_PARAMS_PATH = path.join(ROOT, 'artifacts', 'city-params.json');
const REJECTIONS_PATH = path.join(ROOT, 'artifacts', 'placement-rejections.jsonl');

// Ireland bounding box
const BBOX = { latMin: 51.4, latMax: 55.5, lonMin: -10.5, lonMax: -5.5 };

// Coastal tolerance in degrees (~1.1km)
const COASTAL_TOLERANCE = 0.01;

// --- Geometry helpers ---

/**
 * Ray-casting point-in-polygon test.
 * ring is an array of [lon, lat] pairs.
 */
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) &&
        lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Check if point is inside a polygon (exterior ring minus holes).
 * polygon is an array of rings: [exterior, ...holes]
 */
function pointInPolygon(lon, lat, polygon) {
  if (!pointInRing(lon, lat, polygon[0])) return false;
  // Check holes
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(lon, lat, polygon[i])) return false;
  }
  return true;
}

/**
 * Check if point is inside any polygon of a MultiPolygon.
 */
function pointInMultiPolygon(lon, lat, multiPolygon) {
  for (const polygon of multiPolygon) {
    if (pointInPolygon(lon, lat, polygon)) return true;
  }
  return false;
}

/**
 * Minimum distance from point to a line segment (in degrees).
 */
function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Minimum distance from point to any edge of the MultiPolygon (in degrees).
 */
function minDistToMultiPolygon(lon, lat, multiPolygon) {
  let minDist = Infinity;
  for (const polygon of multiPolygon) {
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const d = pointToSegmentDist(lon, lat, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
        if (d < minDist) minDist = d;
      }
    }
  }
  return minDist;
}

// --- Load boundary ---

let boundary = null;

function loadBoundary() {
  if (boundary !== null) return boundary;
  try {
    const geojson = JSON.parse(fs.readFileSync(BOUNDARY_PATH, 'utf8'));
    boundary = geojson.features[0].geometry.coordinates;
    return boundary;
  } catch (e) {
    console.error(`WARNING: Could not load boundary file (${e.message}). Using bounding-box only.`);
    boundary = false;
    return false;
  }
}

// --- Validation ---

function validateCoordinate(lat, lon) {
  if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) {
    return { feasible: false, reason: 'INVALID_COORDS' };
  }

  // Tier 1: Bounding box
  if (lat < BBOX.latMin || lat > BBOX.latMax || lon < BBOX.lonMin || lon > BBOX.lonMax) {
    return { feasible: false, reason: 'OUTSIDE_BOUNDS' };
  }

  // Tier 2: Point-in-polygon
  const mp = loadBoundary();
  if (mp === false) {
    // Boundary unavailable — Tier 1 passed, accept with warning
    return { feasible: true, reason: 'BBOX_ONLY' };
  }

  if (pointInMultiPolygon(lon, lat, mp)) {
    return { feasible: true, reason: 'ON_LAND' };
  }

  // Coastal tolerance
  const dist = minDistToMultiPolygon(lon, lat, mp);
  if (dist <= COASTAL_TOLERANCE) {
    return { feasible: true, reason: 'COASTAL_TOLERANCE', distance: dist };
  }

  return { feasible: false, reason: 'NOT_ON_LAND', distance: dist };
}

function filterZones(zones) {
  const kept = [];
  const rejected = [];
  for (const zone of zones) {
    const result = validateCoordinate(zone.lat, zone.lon);
    if (result.feasible) {
      kept.push(zone);
    } else {
      rejected.push({ zone, ...result });
    }
  }
  return { kept, rejected };
}

// --- CLI entry point ---

if (require.main === module) {
  let cityParams;
  try {
    cityParams = JSON.parse(fs.readFileSync(CITY_PARAMS_PATH, 'utf8'));
  } catch (e) {
    console.error(`ERROR: Cannot read ${CITY_PARAMS_PATH}: ${e.message}`);
    process.exit(1);
  }

  const zones = cityParams.newZones || [];
  if (zones.length === 0) {
    console.log('No newZones to validate.');
    process.exit(0);
  }

  const { kept, rejected } = filterZones(zones);

  // Log rejections
  if (rejected.length > 0) {
    const lines = rejected.map(r => JSON.stringify({
      ts: new Date().toISOString(),
      site: r.zone.site,
      lat: r.zone.lat,
      lon: r.zone.lon,
      reason: r.reason,
      distance: r.distance || null
    }));
    fs.appendFileSync(REJECTIONS_PATH, lines.join('\n') + '\n');
  }

  // Print summary
  console.log(`Validated ${zones.length} zones: ${kept.length} feasible, ${rejected.length} rejected.`);
  for (const r of rejected) {
    console.log(`  REJECTED: ${r.zone.site} (${r.zone.lat}, ${r.zone.lon}) — ${r.reason}`);
  }

  if (kept.length === 0) {
    console.log('All zones rejected. Skipping growth.');
    process.exit(1);
  }

  // Write back filtered city-params
  if (rejected.length > 0) {
    cityParams.newZones = kept;
    fs.writeFileSync(CITY_PARAMS_PATH, JSON.stringify(cityParams, null, 2) + '\n');
    console.log(`Updated city-params.json: ${kept.length} zones remaining.`);
  }

  process.exit(0);
}

module.exports = { validateCoordinate, filterZones, loadBoundary, BBOX, COASTAL_TOLERANCE };
