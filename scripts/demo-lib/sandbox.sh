# scripts/demo-lib/sandbox.sh — Sandbox exec helpers (sourced, not run).
#
# Exports K_EXEC and K_CP_IN functions for running commands inside the
# openshell sandbox pod from the host VM.

CLUSTER="${CLUSTER:-openshell-cluster-nemoclaw}"
POD="${POD:-my-assistant}"
NS="${NS:-openshell}"

# Exec a command inside the sandbox pod.
# Usage: K_EXEC "sh -c 'tail -5 /sandbox/.openclaw-data/workspace/artifacts/agent-comms.jsonl'"
K_EXEC() {
  sg docker -c "docker exec $CLUSTER kubectl exec -n $NS $POD -c agent -- $*" 2>&1 | grep -v "^Defaulted"
}

# Copy a local file into the sandbox pod.
# Usage: K_CP_IN <local_path> <pod_path>
K_CP_IN() {
  local src="$1" dst="$2" base
  base="$(basename "$src")"
  sg docker -c "docker cp '$src' $CLUSTER:/tmp/$base"
  sg docker -c "docker exec $CLUSTER kubectl cp /tmp/$base $NS/$POD:$dst -c agent"
}
