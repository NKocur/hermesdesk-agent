# Contributing

Use Node.js 22.19 or newer. Run `npm ci --ignore-scripts`, `npm run format:check`, and `npm test`. Tests use mock model endpoints and disposable workspaces; no real inference credentials are required. Windows exercises the full credential and curl transport tests.

Keep the Pi SDK version pinned. Do not weaken approval or path checks to make a test pass. Never add personal server addresses, credentials, machine-specific test scripts, or private transcripts. Explain behavioral changes and include focused tests for protocol, credential, session, or permission changes.

A connection to a running HermesDesk gateway is needed for live inference. This repository does not ship that server. Do not assume other OpenAI-compatible services support the gateway's model options.
