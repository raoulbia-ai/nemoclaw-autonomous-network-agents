# scripts/demo-lib/ui.sh — Presentation helpers (sourced, not run).

section() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
}

pause() {
  echo "  [waiting ${1}s...]"
  sleep "$1"
}

# Format agent-comms.jsonl lines into a readable table via stdin.
format_comms() {
  python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        e = json.loads(line)
        ts = e.get('at','?')[11:19]
        fr = e.get('from','?')
        tp = e.get('type','?')
        msg = e.get('message','')[:120]
        print(f'  {ts}  {fr:12}  {tp:12}  {msg}')
    except: pass
"
}
