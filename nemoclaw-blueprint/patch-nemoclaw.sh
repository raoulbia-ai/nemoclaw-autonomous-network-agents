#!/usr/bin/env bash
# Patch nemoclaw source for Ireland Network Agents.
# Idempotent — safe to run multiple times. Use --unpatch to revert.
#
# Patches:
#   1. SSRF bypass (ssrf.js)
#   2. Custom CA certs + NODE_EXTRA_CA_CERTS (Dockerfile)
#   3. Project files baked into image (Dockerfile)
#   4. Startup: network server + workspace setup (nemoclaw-start.sh)
#
# Written against nemoclaw commit b999c0e (2026-04-04).
# Marker: # ── NKA-INA ──
set -euo pipefail

NEMOCLAW_SRC="$HOME/.nemoclaw/source"
SSRF_JS="$NEMOCLAW_SRC/nemoclaw/dist/blueprint/ssrf.js"
DOCKERFILE="$NEMOCLAW_SRC/Dockerfile"
STARTSH="$NEMOCLAW_SRC/scripts/nemoclaw-start.sh"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERTS_DIR="$PROJECT_DIR/network/certs"
MARKER="# ── NKA-INA ──"

for f in "$SSRF_JS" "$DOCKERFILE" "$STARTSH"; do
  [ -f "$f" ] || { echo "ERROR: $f not found" >&2; exit 1; }
done

unpatch() {
  sed -i "/$MARKER/d" "$SSRF_JS" "$DOCKERFILE" "$STARTSH"
  rm -rf "$NEMOCLAW_SRC/nemoclaw-blueprint/certs" \
         "$NEMOCLAW_SRC/nemoclaw-blueprint/project-files" \
         "$NEMOCLAW_SRC/nemoclaw-blueprint/playbooks"
  echo "Unpatched all files"
}

patch() {
  sed -i "/$MARKER/d" "$SSRF_JS" "$DOCKERFILE" "$STARTSH"
  sed -i "/# ── NKA custom/d" "$SSRF_JS"

  # 1. SSRF bypass
  sed -i '/^export async function validateEndpointUrl/a\    if (process.env.NEMOCLAW_ALLOW_PRIVATE_ENDPOINT === "1") return url; '"$MARKER" "$SSRF_JS"
  echo "1/4 Patched ssrf.js"

  # 2-3. Copy assets into nemoclaw-blueprint (included in build context)
  mkdir -p "$NEMOCLAW_SRC/nemoclaw-blueprint/certs"
  # Copy any .crt files from the certs directory
  cp "$CERTS_DIR"/*.crt "$NEMOCLAW_SRC/nemoclaw-blueprint/certs/" 2>/dev/null || true

  rm -rf "$NEMOCLAW_SRC/nemoclaw-blueprint/project-files" \
         "$NEMOCLAW_SRC/nemoclaw-blueprint/playbooks"
  cp -r "$PROJECT_DIR/nemoclaw-blueprint/project-files" \
        "$NEMOCLAW_SRC/nemoclaw-blueprint/project-files"
  cp -r "$PROJECT_DIR/nemoclaw-blueprint/playbooks" \
        "$NEMOCLAW_SRC/nemoclaw-blueprint/playbooks"

  # Dockerfile patches (all before ENTRYPOINT)
  # Only add cert COPY if certs exist
  CERT_LINES=""
  if ls "$NEMOCLAW_SRC/nemoclaw-blueprint/certs/"*.crt >/dev/null 2>&1; then
    CERT_LINES="$MARKER Custom CA certs\nCOPY nemoclaw-blueprint/certs/*.crt /usr/local/share/ca-certificates/\nRUN update-ca-certificates\nENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt"
  fi

  sed -i '/^ENTRYPOINT/i\'"$CERT_LINES"'\
'"$MARKER"' Project files baked into image\
COPY nemoclaw-blueprint/project-files/agents /sandbox/agents\
COPY nemoclaw-blueprint/project-files/network /sandbox/network\
COPY nemoclaw-blueprint/project-files/brief.md /sandbox/brief.md\
COPY nemoclaw-blueprint/playbooks /sandbox/playbooks\
RUN chown -R sandbox:sandbox /sandbox/agents /sandbox/network /sandbox/playbooks /sandbox/brief.md' "$DOCKERFILE"
  echo "2/4 Patched Dockerfile (certs + project files)"

  # 4. Startup: copy playbooks to workspace + start network server + create artifacts
  sed -i '/^verify_config_integrity()/i\'"$MARKER"' NKA-INA startup: workspace + network server + combined CA bundle\
ina_startup() {\
  if [ -d /sandbox/playbooks ]; then\
    cp /sandbox/playbooks/*.md /sandbox/.openclaw-data/workspace/ 2>/dev/null || true\
    [ -f /sandbox/playbooks/MEMORY.md.template ] && cp /sandbox/playbooks/MEMORY.md.template /sandbox/.openclaw-data/workspace/MEMORY.md 2>/dev/null || true\
    mkdir -p /sandbox/.openclaw-data/workspace/artifacts\
    touch /sandbox/.openclaw-data/workspace/artifacts/agent-comms.jsonl\
    echo "{\"growth_target\":8000,\"growth_wave_count\":0}" > /sandbox/.openclaw-data/workspace/artifacts/state.json\
    [ -f /sandbox/.openclaw-data/workspace/artifacts/signals.json ] || echo "[]" > /sandbox/.openclaw-data/workspace/artifacts/signals.json\
  fi\
  echo "{\"status\":\"ok\",\"rebuiltAt\":\"2026-04-08T07:00:00Z\",\"cells\":266,\"hash\":\"seed\"}" > /sandbox/.openclaw-data/workspace/artifacts/rebuild-status.json\
  rm -rf /sandbox/artifacts 2>/dev/null || true\
  ln -sf /sandbox/.openclaw-data/workspace/artifacts /sandbox/artifacts\
  ln -sf /sandbox/agents /sandbox/.openclaw-data/workspace/agents 2>/dev/null || true\
  ln -sf /sandbox/network /sandbox/.openclaw-data/workspace/network 2>/dev/null || true\
  if [ -f /etc/openshell-tls/openshell-ca.pem ] && [ -f /etc/ssl/certs/ca-certificates.crt ]; then\
    cat /etc/openshell-tls/openshell-ca.pem /etc/ssl/certs/ca-certificates.crt > /sandbox/.openclaw-data/combined-ca.pem\
    export NODE_EXTRA_CA_CERTS=/sandbox/.openclaw-data/combined-ca.pem\
    export SSL_CERT_FILE=/sandbox/.openclaw-data/combined-ca.pem\
    export REQUESTS_CA_BUNDLE=/sandbox/.openclaw-data/combined-ca.pem\
  fi\
  if [ -f /sandbox/network/server.js ] && ! pgrep -f "node server.js" >/dev/null 2>&1; then\
    cd /sandbox/network && nohup node server.js > /tmp/network-server.log 2>&1 &\
    echo "[NKA-INA] network server started (pid $!)" >&2\
    cd /sandbox\
  fi\
}\
ina_startup' "$STARTSH"
  echo "3/4 Patched nemoclaw-start.sh (workspace + network autostart)"

  echo "Done. Run: ./nemoclaw-blueprint/patch-nemoclaw.sh --unpatch  to revert"
}

case "${1:-}" in
  --unpatch) unpatch ;;
  *)         patch ;;
esac
