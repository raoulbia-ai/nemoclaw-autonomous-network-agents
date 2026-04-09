#!/usr/bin/env node
/**
 * Self-assessment tool for ATA agents.
 *
 * Analyses an agent's recent behaviour to detect:
 * - Repetitive outputs (posting the same thing each cycle)
 * - Stuck remediation loops (same target attempted N times without effect)
 * - Low productivity (many skips, few substantive outputs)
 *
 * Usage:
 *   node self-assess.js SENTINEL
 *   node self-assess.js ARCHITECT
 *
 * Returns JSON with flags and recommendations.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ARTIFACTS  = path.join(__dirname, '..', '..', '..', 'artifacts');
const COMMS_FILE = path.join(ARTIFACTS, 'agent-comms.jsonl');
const REMED_FILE = path.join(ARTIFACTS, 'remediation-log.jsonl');
const STATE_FILE = path.join(ARTIFACTS, 'last-run-state.json');

const MAX_RECENT_POSTS = 10;
const MAX_RECENT_REMEDIATIONS = 20;
const REPETITION_THRESHOLD = 0.8; // 80% word overlap = repetitive
const STUCK_REMEDIATION_THRESHOLD = 3; // same target 3+ times with no effect

function getRecentPosts(agentName, limit) {
  if (!fs.existsSync(COMMS_FILE)) return [];
  const lines = fs.readFileSync(COMMS_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const posts = [];
  // Read from end (newest first)
  for (let i = lines.length - 1; i >= 0 && posts.length < limit; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.from === agentName) posts.push(entry);
    } catch { /* skip */ }
  }
  return posts;
}

function getRecentRemediations(limit) {
  if (!fs.existsSync(REMED_FILE)) return [];
  const lines = fs.readFileSync(REMED_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const entries = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    try { entries.push(JSON.parse(lines[i])); }
    catch { /* skip */ }
  }
  return entries;
}

function wordSet(text) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
}

function jaccardSimilarity(setA, setB) {
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function detectRepetition(posts) {
  if (posts.length < 2) return { repetitive: false, detail: 'not enough posts to compare' };

  const messages = posts.map(p => p.message || '');
  const wordSets = messages.map(wordSet);

  // Compare consecutive posts
  let highSimilarityCount = 0;
  const pairs = [];
  for (let i = 0; i < wordSets.length - 1; i++) {
    const sim = jaccardSimilarity(wordSets[i], wordSets[i + 1]);
    if (sim >= REPETITION_THRESHOLD) {
      highSimilarityCount++;
      pairs.push({ posts: [i, i + 1], similarity: Math.round(sim * 100) });
    }
  }

  const repetitive = highSimilarityCount >= Math.floor(posts.length / 2);
  return {
    repetitive,
    highSimilarityPairs: pairs.length,
    detail: repetitive
      ? `${highSimilarityCount} of ${posts.length - 1} consecutive post pairs are >80% similar — you are repeating yourself`
      : `${highSimilarityCount} of ${posts.length - 1} pairs similar — output is varied`,
  };
}

function detectStuckRemediation(remediations) {
  if (remediations.length === 0) return { stuck: false, targets: [] };

  // Count attempts per target that had no effect
  const targetCounts = {};
  for (const r of remediations) {
    const target = r.cellId || r.siteId || 'unknown';
    if (!r.changed) {
      targetCounts[target] = (targetCounts[target] || 0) + 1;
    }
  }

  const stuckTargets = Object.entries(targetCounts)
    .filter(([, count]) => count >= STUCK_REMEDIATION_THRESHOLD)
    .map(([target, count]) => ({ target, failedAttempts: count }));

  return {
    stuck: stuckTargets.length > 0,
    targets: stuckTargets,
    detail: stuckTargets.length > 0
      ? `${stuckTargets.length} target(s) attempted ${STUCK_REMEDIATION_THRESHOLD}+ times with no effect: ${stuckTargets.map(t => t.target).join(', ')}`
      : 'no stuck remediation loops detected',
  };
}

function getProductivity(agentName) {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const agent = state[agentName];
    if (!agent) return null;
    const ratio = agent.total_runs > 0
      ? Math.round((agent.total_acted / agent.total_runs) * 100)
      : null;
    return {
      totalRuns: agent.total_runs,
      totalActed: agent.total_acted,
      totalSkipped: agent.total_skipped,
      consecutiveSkips: agent.consecutive_skips,
      productivityPct: ratio,
      lastSubstantiveOutput: agent.last_substantive_output_at,
    };
  } catch { return null; }
}

function selfAssess(agentName) {
  const posts = getRecentPosts(agentName, MAX_RECENT_POSTS);
  const remediations = agentName === 'ARCHITECT'
    ? getRecentRemediations(MAX_RECENT_REMEDIATIONS)
    : [];

  const repetition = detectRepetition(posts);
  const stuckRemediation = detectStuckRemediation(remediations);
  const productivity = getProductivity(agentName);

  // Build recommendations
  const recommendations = [];

  if (repetition.repetitive) {
    recommendations.push('Your recent posts are highly similar. Either the situation genuinely hasn\'t changed (consider skipping), or you need to look at the data from a different angle.');
  }

  if (stuckRemediation.stuck) {
    for (const t of stuckRemediation.targets) {
      recommendations.push(`Stop retrying remediation on ${t.target} (${t.failedAttempts} failed attempts). Post a "meta" observation about why this isn't working and what alternative approach might help.`);
    }
  }

  if (productivity?.consecutiveSkips >= 5) {
    recommendations.push(`You have skipped ${productivity.consecutiveSkips} consecutive cycles. If nothing is changing, this is correct behaviour. But verify your delta-gating isn't broken.`);
  }

  if (productivity && productivity.productivityPct !== null && productivity.productivityPct < 20 && productivity.totalRuns >= 10) {
    recommendations.push(`Only ${productivity.productivityPct}% of your cycles produce output. Consider whether your schedule is too aggressive or your delta-gating threshold is too sensitive.`);
  }

  return {
    agent: agentName,
    assessedAt: new Date().toISOString(),
    recentPostCount: posts.length,
    repetition,
    stuckRemediation,
    productivity,
    recommendations,
    shouldAct: recommendations.length === 0,
    flags: [
      repetition.repetitive ? 'REPETITIVE_OUTPUT' : null,
      stuckRemediation.stuck ? 'STUCK_REMEDIATION' : null,
      productivity?.consecutiveSkips >= 5 ? 'LONG_IDLE_STREAK' : null,
    ].filter(Boolean),
  };
}

module.exports = selfAssess;

if (require.main === module) {
  const agent = process.argv[2];
  if (!agent) {
    console.error('Usage: node self-assess.js AGENT_NAME');
    process.exit(1);
  }
  console.log(JSON.stringify(selfAssess(agent.toUpperCase()), null, 2));
}
