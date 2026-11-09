# Changelog

## 0.1.0-alpha.2

- Add private connection-code setup for Cloudflare Access-protected Worker gateways, with endpoint-bound encrypted storage for both credentials.
- Forward Access credentials only to the configured model origin; clear credential environment variables before coding tools start.
- Add a restricted private Worker gateway with verified Access identity, rate limits, fixed upstream routing and streaming.
- Add a `hermesdesk-agent` command alias alongside `hermesdesk`.

- Disable curl output buffering so short streaming replies appear before the response finishes.

- Fix a crash when cancelling an HTTP error response while curl is still streaming the body.
- Reject unsupported Node versions before prompting for connection details. Node.js 22.19.0 or newer is required; Node 24 is recommended.
- Identify Cloudflare browser challenges clearly and include a Ray ID when available.
- Add regression coverage for the reported cancellation error, including verification with Node 22.17.1.

This client patch does not change Cloudflare configuration or remove challenges imposed by the server owner.

## 0.1.0-alpha.1

Initial Windows alpha: Pi-based interactive coding, streaming, resumable per-project sessions, connection setup, DPAPI credentials, configurable model/context/sampling settings, workspace file checks, edit and command approvals, safe literal search, and headless read-only or explicitly approved write operation. Windows uses native curl for API transport.

Known limits: no OS sandbox, no Hermes workspace-memory or skill-learning synchronization, no automatic MCP or project-extension loading, and some inherited UI/help text still names Pi. Windows is the validated platform. A running HermesDesk inference gateway and its API key are required.
