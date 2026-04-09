FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates iproute2 curl && rm -rf /var/lib/apt/lists/*

# If your LLM endpoint requires a private CA, drop *.crt files into
# network/certs/ and uncomment the lines below.
# COPY network/certs/*.crt /usr/local/share/ca-certificates/
# RUN update-ca-certificates

RUN groupadd -r sandbox && useradd -r -g sandbox -m sandbox
