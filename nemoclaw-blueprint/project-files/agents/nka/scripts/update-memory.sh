#!/usr/bin/env bash
# NKA heartbeat Step 3 — update memory.json from signals.json
# Usage: bash agents/nka/scripts/update-memory.sh
# Reads artifacts/signals.json, updates artifacts/memory.json, prints summary.

set -euo pipefail
cd "$(dirname "$0")/../../.."

python3 - << 'PYEOF'
import json, datetime, sys, os

now = datetime.datetime.utcnow().isoformat() + 'Z'
signals_path = 'artifacts/signals.json'
memory_path  = 'artifacts/memory.json'

# Load signals
with open(signals_path) as f:
    signals = json.load(f)

flagged_dns = [s['cellId'] for s in signals.get('crossZoneSignals', [])]
summary = signals.get('summary', {})

# Load memory
with open(memory_path) as f:
    memory = json.load(f)

# Update flagged cells
for dn in flagged_dns:
    if dn not in memory['cells']:
        memory['cells'][dn] = {
            'consecutiveCycles': 0,
            'firstFlaggedAt': now,
            'lastFlaggedAt': now,
            'classification': 'transient',
            'resolvedAt': None,
            'stale': False
        }
    c = memory['cells'][dn]
    c['consecutiveCycles'] = c.get('consecutiveCycles', 0) + 1
    c['lastFlaggedAt'] = now
    c['resolvedAt'] = None
    c['stale'] = False
    n = c['consecutiveCycles']
    c['classification'] = 'chronic' if n >= 4 else ('persistent' if n >= 2 else 'transient')

# Mark previously-flagged cells as resolved
for dn, c in memory['cells'].items():
    if dn not in flagged_dns and c.get('classification') not in ('resolved',):
        c['classification'] = 'resolved'
        c['resolvedAt'] = now
        c['consecutiveCycles'] = 0

# Increment cycle
memory['cycleCount'] = memory.get('cycleCount', 0) + 1
memory['lastCycleAt'] = now

# Write back atomically
tmp = memory_path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(memory, f)
os.replace(tmp, memory_path)

# Count by classification
from collections import Counter
classes = Counter(c['classification'] for c in memory['cells'].values())

print(f"memory_updated cycleCount={memory['cycleCount']} chronic={classes.get('chronic',0)} persistent={classes.get('persistent',0)} transient={classes.get('transient',0)} resolved={classes.get('resolved',0)}")
print(f"flagged_cells={len(flagged_dns)} totalCells={summary.get('totalCells',0)}")
for dn in flagged_dns:
    c = memory['cells'][dn]
    short = dn.split('NRCellDU=')[-1] if 'NRCellDU=' in dn else dn[-20:]
    print(f"  cell={short} class={c['classification']} streak={c['consecutiveCycles']}")
PYEOF
