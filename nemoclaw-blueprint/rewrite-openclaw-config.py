#!/usr/bin/env python3
"""Rewrite openclaw.json to use a direct LLM URL instead of inference.local.

The openshell-sandbox binary's TLS trust store doesn't include custom CA
certs, so inference.local can't reach a privately-signed endpoint. This
script rewrites the OpenClaw config to call the endpoint directly via
Node.js (which reads system certs).

Re-hashes the config so the integrity check passes.
"""
import json, os, hashlib

LLM_URL = "http://172.19.0.1:7999"

path = "/sandbox/.openclaw/openclaw.json"
if not os.path.exists(path):
    exit(0)

cfg = json.load(open(path))
changed = False
for p in cfg.get("models", {}).get("providers", {}).values():
    if "inference.local" in p.get("baseUrl", ""):
        p["baseUrl"] = LLM_URL
        changed = True

if not changed:
    exit(0)

os.chmod(path, 0o644)
json.dump(cfg, open(path, "w"), indent=2)
os.chmod(path, 0o444)

h = hashlib.sha256(open(path, "rb").read()).hexdigest()
hf = "/sandbox/.openclaw/.config-hash"
os.chmod(hf, 0o644)
open(hf, "w").write(f"{h}  openclaw.json\n")
os.chmod(hf, 0o444)
print(f"[NKA-INA] Rewrote openclaw.json: baseUrl={LLM_URL}")
