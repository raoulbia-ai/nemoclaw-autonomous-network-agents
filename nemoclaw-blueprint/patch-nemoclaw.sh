#!/usr/bin/env bash
# Patch nemoclaw source for the autonomous-ops template.
# Truly idempotent: every run first restores upstream source from git HEAD
# (and rebuilds the generated dist/ files from clean TS), then applies
# patches on that known-clean base. No residue, no drift, no manual strip.
#
# Patches:
#   1. SSRF bypass (ssrf.js)
#   2. Custom CA certs + NODE_EXTRA_CA_CERTS (Dockerfile, only when *.crt
#      files are staged in network/certs/)
#   3. Config rewrite: inference.local → real provider endpoint (Dockerfile)
#   4. Project files baked into image (Dockerfile)
#   5. Startup: network server + workspace setup (nemoclaw-start.sh)
#   6. Build context: stage extra blueprint dirs (sandbox-build-context.ts + .js)
#
# Commands:
#   (no args)         restore pristine + apply patches
#   --unpatch         restore pristine (drops all modifications)
#   --verify-clean    restore pristine + assert zero marker residue remains
#
# Environment variables:
#   OPS_CONFIG_URL    Override the baseUrl written into openclaw.json by
#                     the config-rewrite step. Defaults to a local
#                     OpenAI-compatible proxy (see patch-dockerfile.py). Use this
#                     to route the sandbox at a different OpenAI-compatible
#                     endpoint without editing this script.
#
# Requirements (one-time, auto-checked):
#   - ~/.nemoclaw/source is a git checkout
#   - Top-level deps installed: (cd ~/.nemoclaw/source && npm install --ignore-scripts)
#   - nemoclaw/ subpackage deps installed: (cd ~/.nemoclaw/source/nemoclaw && npm install)
#
# Written against nemoclaw commit e53167c (2026-04-10).
# Marker: # ── ops ──
set -euo pipefail

NEMOCLAW_SRC="$HOME/.nemoclaw/source"
SSRF_JS="$NEMOCLAW_SRC/nemoclaw/dist/blueprint/ssrf.js"
DOCKERFILE="$NEMOCLAW_SRC/Dockerfile"
STARTSH="$NEMOCLAW_SRC/scripts/nemoclaw-start.sh"
BUILD_CTX_TS="$NEMOCLAW_SRC/src/lib/sandbox-build-context.ts"
BUILD_CTX_JS="$NEMOCLAW_SRC/dist/lib/sandbox-build-context.js"
SSRF_TS="$NEMOCLAW_SRC/nemoclaw/src/blueprint/ssrf.ts"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CERTS_DIR="$PROJECT_DIR/network/certs"
MARKER="# ── ops ──"

# Validate all target files exist
for f in "$SSRF_JS" "$DOCKERFILE" "$STARTSH" "$BUILD_CTX_TS" "$BUILD_CTX_JS" "$SSRF_TS"; do
  [ -f "$f" ] || { echo "ERROR: $f not found" >&2; exit 1; }
done

# ── Restore every patched file to upstream pristine state ──
# Single source of truth: git HEAD for tracked files; rebuilt dist for
# generated files. No .pristine snapshots to go stale when nemoclaw upgrades.
restore_pristine() {
  [ -d "$NEMOCLAW_SRC/.git" ] || {
    echo "ERROR: $NEMOCLAW_SRC is not a git checkout — cannot restore pristine." >&2
    echo "  This script requires git-tracked nemoclaw source as pristine truth." >&2
    exit 1
  }

  # 1. Restore tracked source files to upstream HEAD (discard any NKA edits)
  git -C "$NEMOCLAW_SRC" checkout HEAD -- \
    Dockerfile \
    scripts/nemoclaw-start.sh \
    src/lib/sandbox-build-context.ts \
    nemoclaw/src/blueprint/ssrf.ts

  # 2. Rebuild generated dist/ files from the now-clean TS source.
  #    The .js files are gitignored build outputs, so git cannot restore
  #    them directly — we rebuild instead. This also tracks upstream TS
  #    changes for free on every nemoclaw upgrade.
  [ -x "$NEMOCLAW_SRC/node_modules/.bin/tsc" ] || {
    echo "ERROR: tsc not found at $NEMOCLAW_SRC/node_modules/.bin/tsc" >&2
    echo "  One-time fix: (cd $NEMOCLAW_SRC && npm install --ignore-scripts --no-audit --no-fund)" >&2
    exit 1
  }
  [ -x "$NEMOCLAW_SRC/nemoclaw/node_modules/.bin/tsc" ] || {
    echo "ERROR: tsc not found at $NEMOCLAW_SRC/nemoclaw/node_modules/.bin/tsc" >&2
    echo "  One-time fix: (cd $NEMOCLAW_SRC/nemoclaw && npm install --ignore-scripts --no-audit --no-fund)" >&2
    exit 1
  }
  ( cd "$NEMOCLAW_SRC" && npm run build:cli >/dev/null 2>&1 ) || {
    echo "ERROR: npm run build:cli failed in $NEMOCLAW_SRC" >&2
    exit 1
  }
  ( cd "$NEMOCLAW_SRC/nemoclaw" && npm run build >/dev/null 2>&1 ) || {
    echo "ERROR: npm run build failed in $NEMOCLAW_SRC/nemoclaw" >&2
    exit 1
  }

  # 3. Drop any copied blueprint assets (untracked, left by previous patches)
  rm -rf "$NEMOCLAW_SRC/nemoclaw-blueprint/certs" \
         "$NEMOCLAW_SRC/nemoclaw-blueprint/project-files" \
         "$NEMOCLAW_SRC/nemoclaw-blueprint/playbooks" \
         "$NEMOCLAW_SRC/nemoclaw-blueprint/rewrite-openclaw-config.py"

  # 4. Sanity check: zero NKA markers in any target file
  local residue
  residue=$(grep -l "# ── ops ──\|NKA-INA\|NKA custom" \
    "$SSRF_JS" "$DOCKERFILE" "$STARTSH" "$BUILD_CTX_TS" "$BUILD_CTX_JS" "$SSRF_TS" 2>/dev/null || true)
  if [ -n "$residue" ]; then
    echo "ERROR: restore_pristine left residue in:" >&2
    echo "$residue" >&2
    exit 1
  fi
  echo "  [pristine] restored from git HEAD + rebuilt dist"
}

unpatch() {
  restore_pristine
  echo "Unpatched — nemoclaw source restored to upstream HEAD + clean dist."
}

verify_clean() {
  restore_pristine
  echo "Clean: pristine restore succeeded and no marker residue found."
}

patch() {
  restore_pristine

  # 1. SSRF bypass
  sed -i '/^export async function validateEndpointUrl/a\    if (process.env.NEMOCLAW_ALLOW_PRIVATE_ENDPOINT === "1") return url; '"$MARKER" "$SSRF_JS"
  echo "1/4 Patched ssrf.js"

  # 2. Copy assets into nemoclaw-blueprint (included in build context).
  # Cert copy is automatic: if any *.crt files exist in network/certs/,
  # stage them and pass --with-certs to patch-dockerfile.py. If not, skip —
  # public providers (OpenAI, Together, local vLLM, etc.) don't need a
  # private root CA.
  WITH_CERTS_FLAG=""
  if compgen -G "$CERTS_DIR/*.crt" > /dev/null; then
    mkdir -p "$NEMOCLAW_SRC/nemoclaw-blueprint/certs"
    cp "$CERTS_DIR"/*.crt "$NEMOCLAW_SRC/nemoclaw-blueprint/certs/"
    WITH_CERTS_FLAG="--with-certs"
  fi

  cp -r "$PROJECT_DIR/nemoclaw-blueprint/project-files" \
        "$NEMOCLAW_SRC/nemoclaw-blueprint/project-files"
  cp -r "$PROJECT_DIR/nemoclaw-blueprint/playbooks" \
        "$NEMOCLAW_SRC/nemoclaw-blueprint/playbooks"

  # Dockerfile patches (insert before ENTRYPOINT via helper script).
  # OPS_CONFIG_URL is passed through the environment and used by
  # patch-dockerfile.py to set the config-rewrite target URL.
  python3 "$SCRIPT_DIR/patch-dockerfile.py" "$DOCKERFILE" $WITH_CERTS_FLAG
  echo "2/4 Patched Dockerfile (project files + config rewrite${WITH_CERTS_FLAG:+ + certs})"

  # 3. Startup: copy playbooks to workspace + start network server + create artifacts
  sed -i '/^verify_config_integrity()/i\'"$MARKER"' ops startup: workspace + network server + combined CA bundle\
ops_startup() {\
  if [ -d /sandbox/playbooks ]; then\
    cp /sandbox/playbooks/*.md /sandbox/.openclaw-data/workspace/ 2>/dev/null || true\
    [ -f /sandbox/playbooks/MEMORY.md.template ] && cp /sandbox/playbooks/MEMORY.md.template /sandbox/.openclaw-data/workspace/MEMORY.md 2>/dev/null || true\
    mkdir -p /sandbox/.openclaw-data/workspace/artifacts\
    touch /sandbox/.openclaw-data/workspace/artifacts/agent-comms.jsonl\
    echo "{\\"growth_target\\":8000,\\"growth_wave_count\\":0}" > /sandbox/.openclaw-data/workspace/artifacts/state.json\
    [ -f /sandbox/.openclaw-data/workspace/artifacts/signals.json ] || echo "[]" > /sandbox/.openclaw-data/workspace/artifacts/signals.json\
  fi\
  echo "{\\"status\\":\\"ok\\",\\"rebuiltAt\\":\\"2026-04-08T07:00:00Z\\",\\"cells\\":266,\\"hash\\":\\"seed\\"}" > /sandbox/.openclaw-data/workspace/artifacts/rebuild-status.json\
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
    echo "[ops] network server started (pid $!)" >&2\
    cd /sandbox\
  fi\
  if [ -f /sandbox/network/ireland/event-engine.js ] && ! pgrep -f "event-engine" >/dev/null 2>&1; then\
    cd /sandbox/network && nohup node ireland/event-engine.js > /tmp/event-engine.log 2>&1 &\
    echo "[ops] event engine started (pid $!)" >&2\
    cd /sandbox\
  fi\
}\
ops_startup' "$STARTSH"
  echo "3/4 Patched nemoclaw-start.sh (workspace + network autostart)"

  # 4. Build context: the optimized builder only stages blueprint.yaml + policies/
  #    from nemoclaw-blueprint/. It does NOT stage certs/, project-files/, or
  #    playbooks/ — so our Dockerfile COPY lines fail with "file not found in
  #    build context". Patch both the .ts source and compiled .js to include them.
  #    Because restore_pristine already produced clean sources, we don't need
  #    to guard with "if marker already present".
  for f in "$BUILD_CTX_TS" "$BUILD_CTX_JS"; do
    python3 -c "
import sys, re
with open(sys.argv[1], 'r') as f:
    content = f.read()
# Detect leading indent from the anchor line itself so the same patch
# works against 2-space TS source and 4-space compiled JS alike.
m = re.search(r'^( *)fs\.mkdirSync\(stagedScriptsDir,', content, re.MULTILINE)
if not m:
    sys.stderr.write('ERROR: anchor fs.mkdirSync(stagedScriptsDir, not found in ' + sys.argv[1] + '\n')
    sys.exit(1)
indent = m.group(1)
patch_lines = [
    '',
    indent + '// ── ops ── stage extra blueprint dirs for autonomous-ops template',
    indent + 'for (const extra of [\"certs\", \"project-files\", \"playbooks\"]) {',
    indent + '    const src = path.join(sourceBlueprintDir, extra);',
    indent + '    if (fs.existsSync(src)) {',
    indent + '        fs.cpSync(src, path.join(stagedBlueprintDir, extra), { recursive: true });',
    indent + '    }',
    indent + '}',
    '',
]
patch = '\n'.join(patch_lines)
content = content.replace(
    indent + 'fs.mkdirSync(stagedScriptsDir,',
    patch + indent + 'fs.mkdirSync(stagedScriptsDir,',
    1,
)
with open(sys.argv[1], 'w') as f:
    f.write(content)
" "$f"
  done
  echo "4/4 Patched sandbox-build-context.ts + .js (stage extra blueprint dirs)"

  echo "Done. Run: ./nemoclaw-blueprint/patch-nemoclaw.sh --unpatch  to revert"
  if [ -n "$WITH_CERTS_FLAG" ]; then
    echo "  (CA certs staged from $CERTS_DIR)"
  else
    echo "  (no CA certs found in $CERTS_DIR — cert COPY skipped)"
  fi
  if [ -n "${OPS_CONFIG_URL:-}" ]; then
    echo "  (baseUrl override: OPS_CONFIG_URL=$OPS_CONFIG_URL)"
  fi
}

case "${1:-}" in
  --unpatch)      unpatch ;;
  --verify-clean) verify_clean ;;
  *)              patch ;;
esac
