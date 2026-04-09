#!/usr/bin/env node
/**
 * Delta-gating for ATA agents.
 *
 * Checks whether anything has changed since the agent's last run.
 * If nothing changed, the agent can skip its cycle and save an LLM call.
 *
 * Watches: signals.json, alarms.json, agent-comms.jsonl (new entries),
 *          external-context.json
 *
 * Usage:
 *   node check-delta.js SENTINEL [--compact]
 *   node check-delta.js ORACLE [--compact]
 *   node check-delta.js ARCHITECT [--compact]
 *
 * Returns JSON: { changed: true|false, reason: "...", snapshot_hash, comms_offset, ... }
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ARTIFACTS  = path.join(__dirname, '..', '..', '..', 'artifacts');
const STATE_FILE = path.join(ARTIFACTS, 'last-run-state.json');
const COMMS_FILE = path.join(ARTIFACTS, 'agent-comms.jsonl');

// Files each agent cares about
const WATCH_FILES = {
  SENTINEL:  ['signals.json', 'alarms.json', 'external-context.json'],
  ORACLE:    ['signals.json', 'alarms.json', 'external-context.json', 'memory.json'],
  ARCHITECT: ['network-atlas.md', 'state.json', 'city-params.json'],
};

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return 'missing';
  const content = fs.readFileSync(filePath, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

function getState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function getCommsCount() {
  if (!fs.existsSync(COMMS_FILE)) return 0;
  return fs.readFileSync(COMMS_FILE, 'utf8').trim().split('\n').filter(Boolean).length;
}

function getNewCommsForAgent(agentName, sinceOffset) {
  if (!fs.existsSync(COMMS_FILE)) return { mentions: [], directed: [] };
  const lines = fs.readFileSync(COMMS_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const mentions = [];
  const directed = [];

  for (let i = sinceOffset; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      // Skip own posts
      if (entry.from === agentName) continue;

      // Directed messages (to this agent)
      if (entry.to && entry.to.toUpperCase() === agentName.toUpperCase()) {
        directed.push(entry);
      }

      // Mentions (agent name appears in message)
      const text = JSON.stringify(entry).toUpperCase();
      if (text.includes(agentName.toUpperCase())) {
        mentions.push(entry);
      }
    } catch { /* skip bad lines */ }
  }
  return { mentions, directed };
}

function checkDelta(agentName) {

  const state = getState();
  const agentState = state[agentName] || {};

  // Hash watched files
  const watchFiles = WATCH_FILES[agentName] || WATCH_FILES.SENTINEL;
  const hashParts = watchFiles.map(f => f + ':' + hashFile(path.join(ARTIFACTS, f)));
  const currentHash = crypto.createHash('sha256')
    .update(hashParts.join('|'))
    .digest('hex')
    .substring(0, 16);

  // Check comms
  const commsOffset = getCommsCount();
  const lastOffset = agentState.last_seen_comms_offset || 0;
  const { mentions, directed } = getNewCommsForAgent(agentName, lastOffset);

  // Build reasons
  const reasons = [];

  // Urgent trigger marker — always act if urgently woken
  const triggerFile = path.join(ARTIFACTS, `urgent-trigger-${agentName}.json`);
  if (fs.existsSync(triggerFile)) {
    try {
      const trigger = JSON.parse(fs.readFileSync(triggerFile, 'utf8'));
      reasons.push(`urgently triggered by ${trigger.by || 'unknown'}`);
    } catch { reasons.push('urgently triggered (marker file unreadable)'); }
  }

  if (currentHash !== (agentState.snapshot_hash || '')) {
    // Figure out which files changed
    const changedFiles = [];
    for (const f of watchFiles) {
      const h = hashFile(path.join(ARTIFACTS, f));
      const prev = (agentState.file_hashes || {})[f];
      if (h !== prev) changedFiles.push(f);
    }
    reasons.push(`data changed: ${changedFiles.join(', ')}`);
  }

  if (directed.length > 0) {
    reasons.push(`${directed.length} new message(s) directed to ${agentName}`);
  }

  if (mentions.length > 0 && directed.length === 0) {
    reasons.push(`${mentions.length} new comms mentioning ${agentName}`);
  }

  // For ARCHITECT: check if ORACLE posted a new atlas or advisory
  if (agentName === 'ARCHITECT') {
    const oracleAdvisories = directed.filter(e => e.from === 'ORACLE' && e.type === 'advisory');
    if (oracleAdvisories.length > 0) {
      reasons.push(`${oracleAdvisories.length} new ORACLE advisory(s)`);
    }
  }

  // For ORACLE: check if SENTINEL posted new handoffs
  if (agentName === 'ORACLE') {
    const sentinelHandoffs = mentions.filter(e => e.from === 'SENTINEL');
    if (sentinelHandoffs.length > 0) {
      reasons.push(`${sentinelHandoffs.length} new SENTINEL observation(s)`);
    }
  }

  // Per-file hashes for next run comparison
  const fileHashes = {};
  for (const f of watchFiles) {
    fileHashes[f] = hashFile(path.join(ARTIFACTS, f));
  }

  return {
    changed: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join('; ') : 'no change',
    snapshot_hash: currentHash,
    comms_offset: commsOffset,
    file_hashes: fileHashes,
    mention_count: mentions.length,
    directed_count: directed.length,
    directed_messages: directed.slice(0, 5), // cap for context window
  };
}

module.exports = checkDelta;

if (require.main === module) {
  const args = process.argv.slice(2);
  const compact = args.includes('--compact');
  const agent = args.find(a => !a.startsWith('--'));

  if (!agent) {
    console.error('Usage: node check-delta.js AGENT_NAME [--compact]');
    process.exit(1);
  }

  const result = checkDelta(agent.toUpperCase());

  if (compact) {
    console.log(JSON.stringify({
      changed: result.changed,
      reason: result.reason,
      snapshot_hash: result.snapshot_hash,
      comms_offset: result.comms_offset,
      mention_count: result.mention_count,
      directed_count: result.directed_count,
    }, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
