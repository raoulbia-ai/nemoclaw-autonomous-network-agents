/**
 * Ireland mock network server — schema-faithful mock of 3GPP-style telecom APIs.
 *
 * Rewritten 2026-04-07 to drop the express dependency and the unused
 * routes/aliases inherited from earlier iterations. Only the endpoints the
 * agents actually call are mounted. Native node http only — zero npm
 * dependencies, which makes the sandbox-only deployment trivial (no
 * `npm install`, no `node_modules/` to bake into the sandbox image).
 *
 * Endpoints (the only ones any agent or script in this repo calls):
 *
 *   POST /auth/realms/master/protocol/openid-connect/token
 *     OAuth 2.0 stub. Returns the same bearer token regardless of body.
 *
 *   GET  /topology-inventory/v1/domains/RAN/entity-types/NRCellDU/entities
 *     3GPP topology — full cell inventory. Read by SENTINEL collect.sh and
 *     by ORACLE for cell counts.
 *
 *   GET  /data-management/v1/pm/cells
 *     PM counters generated dynamically from network state on each request.
 *
 *   GET  /data-management/v1/fm/alarms
 *     Active alarms generated dynamically from network state on each request.
 *
 *   GET  /data-management/v1/faults/active
 *     Canonical structured fault list. Read by remediate-all.js.
 *     Optional ?type=<event-type> filter.
 *
 *   GET  /data-management/v1/rebuild-status
 *     Reads artifacts/rebuild-status.json. Used by ARCHITECT growth gate.
 *     Returns {present:false} if the file is missing.
 *
 *   GET  /data-management/v1/remediate/cell?cellId=NRCellDU-N&action=...
 *     action ∈ {clear-alarm, restart-cell}. Mutates network state.
 *     This is a GET-with-side-effects deliberately — see the long comment
 *     above the handler. The constraint that forced it (the OpenClaw
 *     agent-session egress filter) only matters in host/sandbox split
 *     deployments. We keep it as a GET in the sandbox-only world too,
 *     for consistency with the agent's existing call sites.
 *
 *   GET  /data-management/v1/remediate/backhaul?siteId=...
 *     Same shape. Mutates network state.
 *
 * Run:
 *   node network/server.js                              (defaults: 0.0.0.0:8090)
 *   NETWORK_HOST=127.0.0.1 NETWORK_PORT=9000 node ...   (override)
 *
 * Removed in this rewrite:
 *   - express + express.json + express.urlencoded (~80 LOC saved, no npm dep)
 *   - GET /topology-inventory/.../relationships  (never called by any agent)
 *   - GET /network-configuration/v1/ch/:cmHandle/data/ds/:datastore  (never called)
 *   - POST /v1/remediate/cell + /v1/remediate/backhaul  (host-client aliases,
 *     no host clients in sandbox-only architecture)
 *   - POST /data-management/v1/remediate/* (allow-list workaround was for
 *     POST under the prefix; the GET versions work everywhere)
 *   - GET /v1/faults/active + /v1/rebuild-status  (host-client aliases)
 *   - DATA_SET environment switch (the Ireland dataset is the only one)
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const domain = require('../domain');

const REBUILD_STATUS_FILE = path.join(__dirname, '..', 'artifacts', 'rebuild-status.json');
const PORT         = parseInt(process.env.NETWORK_PORT || '8090', 10);
const NETWORK_HOST = process.env.NETWORK_HOST || '0.0.0.0';
const MOCK_TOKEN   = 'mock-bearer-token';

// State cache is now in domain/state.js — domain.state.loadCached() for reads,
// domain.state.loadFresh() + invalidateCache() for mutations.

// ---------------------------------------------------------------------------
// Tiny response helpers (replacing express's res.json / res.status().json())
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res) {
  sendJson(res, 404, { error: 'not found' });
}

function badRequest(res, msg) {
  sendJson(res, 400, { error: msg });
}

function unauthorized(res) {
  sendJson(res, 401, { error: 'Missing or invalid Bearer token' });
}

function requireAuth(req) {
  const auth = req.headers['authorization'];
  return !!(auth && auth.startsWith('Bearer '));
}

// 3GPP URN parsing moved to domain/urn.js — domain.urn.parseCellUrn()

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleAuthToken(req, res) {
  // The mock issues the same token unconditionally; we don't even read the
  // body. A real telecom OAM API would parse client_id/client_secret here.
  sendJson(res, 200, {
    access_token: MOCK_TOKEN,
    token_type:   'Bearer',
    expires_in:   3600,
  });
}

function handleTopology(req, res) {
  sendJson(res, 200, domain.cells.getTopology());
}

function handlePmCells(req, res) {
  sendJson(res, 200, domain.pm.generate(domain.cells.getCells(), domain.state.loadCached(), new Date()));
}

function handleFmAlarms(req, res) {
  sendJson(res, 200, domain.alarms.generate(domain.cells.getCells(), domain.state.loadCached(), new Date()));
}

function handleFaultsActive(req, res, query) {
  const state = domain.state.loadFresh();
  if (!state) return sendJson(res, 503, { error: 'network state unavailable' });

  const wantType = (query && query.type) || null;
  const out = [];
  for (const evt of state.events) {
    if (evt.resolved) continue;
    if (wantType && evt.type !== wantType) continue;

    const sites = new Set();
    const cells = [];
    for (const urn of evt.affectedCells) {
      const { siteId, cellId } = domain.urn.parseCellUrn(urn);
      if (siteId) sites.add(siteId);
      if (cellId) cells.push(cellId);
    }
    out.push({
      eventId:    evt.id,
      type:       evt.type,
      startedAt:  evt.startedAt,
      resolveAt:  evt.resolveAt,
      sites:      [...sites],
      cells,
      rerouted:   !!evt.rerouted,
      ghostAlarm: !!evt.ghostAlarm,
      alarmId:    evt.alarmId || null,
    });
  }
  sendJson(res, 200, { collectedAt: new Date().toISOString(), count: out.length, faults: out });
}

function handleRebuildStatus(req, res) {
  if (!fs.existsSync(REBUILD_STATUS_FILE)) {
    return sendJson(res, 200, { present: false });
  }
  try {
    const obj = JSON.parse(fs.readFileSync(REBUILD_STATUS_FILE, 'utf8'));
    sendJson(res, 200, { present: true, ...obj });
  } catch (e) {
    sendJson(res, 500, { present: false, error: e.message });
  }
}

// GET-with-side-effects: see the rationale block at the top of the file.
function handleRemediateCell(req, res, query) {
  const cellId = (query && query.cellId) || '';
  const action = (query && query.action) || '';
  if (!cellId || !action) return badRequest(res, 'cellId and action required');
  if (action !== 'clear-alarm' && action !== 'restart-cell') {
    return badRequest(res, 'action must be clear-alarm or restart-cell');
  }

  const state = domain.state.loadFresh();
  if (!state) return sendJson(res, 503, { error: 'network state unavailable' });

  // Accept short id ("NRCellDU-31") or full URN; normalise to NRCellDU-N
  const numMatch = cellId.match(/NRCellDU[=-](\d+)/);
  const wantNum  = numMatch ? numMatch[1] : null;
  if (!wantNum) return badRequest(res, `cellId not parseable: ${cellId}`);
  const wantSuffix = `NRCellDU=${wantNum}`;

  const now = new Date();
  let changed = false;
  let result  = '';
  let eventId = null;

  if (action === 'clear-alarm') {
    for (const evt of state.events) {
      if (!evt.ghostAlarm) continue;
      if (!evt.affectedCells.some(c => c.endsWith(wantSuffix))) continue;
      evt.ghostAlarm = false;
      evt.ghostAlarmExpiresAt = null;
      changed = true;
      eventId = evt.id;
      result = `Ghost alarm cleared on NRCellDU-${wantNum} (event ${evt.id}, alarm ${evt.alarmId})`;
      break;
    }
    if (!changed) {
      const real = state.events.find(e =>
        !e.resolved && e.type === 'equipment_fault' &&
        e.affectedCells.some(c => c.endsWith(wantSuffix))
      );
      result = real
        ? `Cannot clear alarm on NRCellDU-${wantNum} — fault still active (${real.id}). Use restart-cell.`
        : `No ghost alarm found on NRCellDU-${wantNum}. No action taken.`;
      eventId = real ? real.id : null;
    }
  } else { // restart-cell
    for (const evt of state.events) {
      if (evt.resolved) continue;
      if (evt.type !== 'equipment_fault') continue;
      if (!evt.affectedCells.some(c => c.endsWith(wantSuffix))) continue;
      evt.resolved = true;
      evt.resolvedAt = now.toISOString();
      evt.ghostAlarm = false;
      changed = true;
      eventId = evt.id;
      result = `Equipment fault force-resolved on NRCellDU-${wantNum} (event ${evt.id})`;
      break;
    }
    if (!changed) {
      result = `No active equipment_fault found on NRCellDU-${wantNum}. No action taken.`;
    }
  }

  if (changed) {
    domain.state.save(state);
    domain.state.invalidateCache();
    // Clear fault fatigue for this event — remediation succeeded
    try {
      const fatigueFile = path.join(__dirname, '..', 'artifacts', 'fault-fatigue.json');
      if (fs.existsSync(fatigueFile)) {
        const fatigueData = JSON.parse(fs.readFileSync(fatigueFile, 'utf8'));
        if (fatigueData[eventId]) {
          delete fatigueData[eventId];
          const tmp = fatigueFile + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(fatigueData, null, 2) + '\n');
          fs.renameSync(tmp, fatigueFile);
        }
      }
    } catch { /* best-effort: never block remediation on fatigue cleanup */ }
  }
  sendJson(res, 200, { changed, cellId: `NRCellDU-${wantNum}`, action, eventId, result });
}

function handleRemediateBackhaul(req, res, query) {
  const siteId = (query && query.siteId) || '';
  if (!siteId) return badRequest(res, 'siteId required');

  // Always read fresh — bypass the 5s cache so we don't clobber recent ticks.
  const state = domain.state.loadFresh();
  if (!state) return sendJson(res, 503, { error: 'network state unavailable' });

  const now = new Date();
  let changed = false;
  let result  = '';
  let eventId = null;

  for (const evt of state.events) {
    if (evt.resolved) continue;
    if (evt.type !== 'backhaul_fault') continue;
    if (evt.rerouted) continue;
    if (!evt.affectedCells.some(c => c.includes(`MeContext=${siteId},`))) continue;

    const remainingMs = new Date(evt.resolveAt).getTime() - now.getTime();
    if (remainingMs <= 0) continue;

    const newResolveAt = new Date(now.getTime() + remainingMs * 0.25);
    evt.resolveAt = newResolveAt.toISOString();
    evt.rerouted  = true;
    changed = true;
    eventId = evt.id;
    const savedMin = Math.round((remainingMs - remainingMs * 0.25) / 60000);
    result = `Backhaul rerouted for ${siteId} (event ${evt.id}). Remaining time cut by ${savedMin} min. New resolve: ${newResolveAt.toISOString().slice(11, 16)}`;
    break;
  }

  if (changed) {
    domain.state.save(state);
    domain.state.invalidateCache();
    // Clear fault fatigue for this event — remediation succeeded
    try {
      const fatigueFile = path.join(__dirname, '..', 'artifacts', 'fault-fatigue.json');
      if (fs.existsSync(fatigueFile)) {
        const fatigueData = JSON.parse(fs.readFileSync(fatigueFile, 'utf8'));
        if (fatigueData[eventId]) {
          delete fatigueData[eventId];
          const tmp = fatigueFile + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(fatigueData, null, 2) + '\n');
          fs.renameSync(tmp, fatigueFile);
        }
      }
    } catch { /* best-effort: never block remediation on fatigue cleanup */ }
    return sendJson(res, 200, { changed: true, siteId, eventId, result });
  }

  const stillActive = state.events.find(e =>
    !e.resolved && e.type === 'backhaul_fault' &&
    e.affectedCells.some(c => c.includes(`MeContext=${siteId},`))
  );
  if (stillActive && stillActive.rerouted) {
    result = `Backhaul on ${siteId} already rerouted (event ${stillActive.id}). No further action possible.`;
  } else {
    result = `No active backhaul_fault found for site ${siteId}. No action taken.`;
  }
  sendJson(res, 200, {
    changed: false,
    siteId,
    eventId: stillActive ? stillActive.id : null,
    result,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// Simple (method, pathname) → handler table. The auth-token route is the
// only POST and the only route that doesn't require auth.
const ROUTES = {
  'POST /auth/realms/master/protocol/openid-connect/token': { auth: false, handler: handleAuthToken },
  'GET /topology-inventory/v1/domains/RAN/entity-types/NRCellDU/entities': { auth: true, handler: handleTopology },
  'GET /data-management/v1/pm/cells':            { auth: true, handler: handlePmCells },
  'GET /data-management/v1/fm/alarms':           { auth: true, handler: handleFmAlarms },
  'GET /data-management/v1/faults/active':       { auth: true, handler: handleFaultsActive },
  'GET /data-management/v1/rebuild-status':      { auth: true, handler: handleRebuildStatus },
  'GET /data-management/v1/remediate/cell':      { auth: true, handler: handleRemediateCell },
  'GET /data-management/v1/remediate/backhaul':  { auth: true, handler: handleRemediateBackhaul },
};

const server = http.createServer((req, res) => {
  const start = Date.now();
  const parsed = url.parse(req.url, true);
  const key = `${req.method} ${parsed.pathname}`;

  // Logger fires on every response, including 404 and 401
  res.on('finish', () => {
    const ms = Date.now() - start;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
    const auth = req.headers['authorization'] ? 'auth' : 'no-auth';
    console.log(`[req] ${req.method} ${req.url} → ${res.statusCode} ${ms}ms src=${ip} ${auth}`);
  });

  const route = ROUTES[key];
  if (!route) return notFound(res);
  if (route.auth && !requireAuth(req)) return unauthorized(res);

  // Handlers receive the parsed query (the agent uses query strings for
  // remediate operations and faults filtering — see top-of-file rationale).
  try {
    route.handler(req, res, parsed.query);
  } catch (err) {
    console.error('[req] handler error:', err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, NETWORK_HOST, () => {
  console.log(`[network] listening on http://${NETWORK_HOST}:${PORT}`);
  console.log(`[network] ${Object.keys(ROUTES).length} routes mounted`);
});
