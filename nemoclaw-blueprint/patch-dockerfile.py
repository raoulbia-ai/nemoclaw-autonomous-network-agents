#!/usr/bin/env python3
"""Patch the NemoClaw Dockerfile for the autonomous-ops template.

Called by patch-nemoclaw.sh. Inserts ops-patch lines before ENTRYPOINT.

Usage:
    patch-dockerfile.py <dockerfile> [--with-certs]

Options:
    --with-certs   Include custom CA cert COPY + update-ca-certificates + NODE_EXTRA_CA_CERTS
                   lines. Only pass this when certs are actually staged in
                   `nemoclaw-blueprint/certs/` by patch-nemoclaw.sh.

Environment variables:
    OPS_CONFIG_URL   Base URL to write into openclaw.json during the config
                     rewrite step. Defaults to a local OpenAI-compatible proxy.
                     Set this to override the baked-in provider URL without
                     editing this script (e.g. when routing through a local
                     OpenAI-compatible endpoint instead of going direct).
"""
import os
import sys


DEFAULT_CONFIG_URL = "http://172.19.0.1:7999"


def main():
    dockerfile = sys.argv[1]
    with_certs = "--with-certs" in sys.argv
    config_url = os.environ.get("OPS_CONFIG_URL", DEFAULT_CONFIG_URL)

    with open(dockerfile, "r") as f:
        content = f.read()

    lines = []

    # Patch 2: custom CA certs (only when patch-nemoclaw.sh actually staged them).
    if with_certs:
        lines += [
            "# ── ops ── custom CA certs",
            "COPY nemoclaw-blueprint/certs/*.crt /usr/local/share/ca-certificates/",
            "RUN update-ca-certificates",
            "ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
        ]

    # Patch 4: Project files baked into image.
    lines += [
        "# ── ops ── Project files baked into image",
        "COPY nemoclaw-blueprint/project-files/agents /sandbox/agents",
        "COPY nemoclaw-blueprint/project-files/network /sandbox/network",
        "COPY nemoclaw-blueprint/project-files/domain /sandbox/domain",
        "COPY nemoclaw-blueprint/project-files/brief.md /sandbox/brief.md",
        "COPY nemoclaw-blueprint/playbooks /sandbox/playbooks",
        "RUN chown -R sandbox:sandbox /sandbox/agents /sandbox/network /sandbox/domain /sandbox/playbooks /sandbox/brief.md",
    ]

    # Patch 3: Config rewrite — replace any inference.local baseUrl with the
    # real endpoint (env-overridable via OPS_CONFIG_URL).
    #
    # The upstream Dockerfile pins sha256sum(.config-hash) at build time
    # (around line 227) to prevent tampering. Since our patch runs AFTER
    # that step (inserted before ENTRYPOINT), we must recompute the hash
    # after rewriting so gateway startup integrity verification passes.
    lines += [
        "# ── ops ── Rewrite openclaw.json: inference.local → real endpoint",
        (
            'RUN python3 -c "import json,os; '
            "p='/sandbox/.openclaw/openclaw.json'; "
            "cfg=json.load(open(p)); "
            f"[v.__setitem__('baseUrl','{config_url}') "
            "for v in cfg.get('models',{}).get('providers',{}).values() "
            "if 'inference.local' in v.get('baseUrl','')]; "
            "os.chmod(p,0o644); json.dump(cfg,open(p,'w'),indent=2); os.chmod(p,0o444)\" \\"
        ),
        (
            "    && chmod 644 /sandbox/.openclaw/.config-hash \\\n"
            "    && sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash \\\n"
            "    && chmod 444 /sandbox/.openclaw/.config-hash"
        ),
    ]

    # Insert before ENTRYPOINT.
    patch_block = "\n".join(lines) + "\n"
    content = content.replace("ENTRYPOINT [", patch_block + "ENTRYPOINT [")

    with open(dockerfile, "w") as f:
        f.write(content)


if __name__ == "__main__":
    main()
