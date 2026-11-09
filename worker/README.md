# Optional private model gateway

This Worker routes an authenticated coding client to an existing inference gateway through a Cloudflare Workers VPC Service. Configure the VPC Service for one host and port, not a whole network. Keep the origin gateway's model-key authentication, revocation, queue and body limits enabled.

## Required configuration

- `MODEL_GATEWAY`: a `vpc_service` binding for that single inference-gateway host/port.
- `GATEWAY_HOST`: the fixed HTTP Host header accepted by the gateway. This does not select the VPC connection target.
- `ACCESS_AUDIENCE`: the exact 64-character audience tag of the Cloudflare Access application.
- `IP_LIMIT`: a Workers Rate Limiting binding, suggested 180 requests per 60 seconds.
- `KEY_LIMIT`: a separate Rate Limiting binding, suggested 60 requests per 60 seconds.

Workers rate limits are distributed and approximate; the origin must enforce authoritative limits too.

Protect both the production workers.dev hostname and the Worker itself with an Access application, including a Service Auth (`non_identity`) policy restricted to explicitly provisioned service tokens. Disable preview URLs. The Worker additionally requires Cloudflare's platform-verified `ctx.access.aud` to match `ACCESS_AUDIENCE`; a forged assertion header cannot supply this runtime context. Do not replace this with trust in a caller-provided header.

Cloudflare service credentials go to Access in `CF-Access-Client-Id` and `CF-Access-Client-Secret`. The independent inference key goes in `Authorization: Bearer ...` and is checked at the origin. The Worker forwards neither Access credentials nor browser cookies nor privilege headers into the origin. Only GET /v1/models and POST /v1/chat/completions are allowed. Query strings, browser origins, remote URLs, upstream redirects and bodies over 2 MiB are rejected. Responses are streamed and not cached. Do not enable request-body or credential logging.

The client supports `hermesdesk connect --code` for a server-issued private connection code or `connect --cloudflare-access` for manual credential entry. The code format is `hdc1_` plus base64url JSON containing version `v: 1`, `baseUrl`, `token`, `access: {clientId, clientSecret}` and an `expires` Unix-millisecond timestamp. Base64 is not encryption. Never include connection codes in URLs, shell commands, logs, repositories or screenshots.

For a household deployment, Access can be an administrator-managed shared gate with an expiry, while each device gets its own independently revocable model key. Revoking a device model key blocks inference but does not rotate the shared Access credential. Rotate/disable the Access service token in Cloudflare if it is exposed, and renew the protected server provisioning record before it expires. Removing an Access policy causes this Worker to deny requests because verified runtime context is absent.

Use a current cloudflared connector with QUIC enabled. This architecture requires no inbound router port forwarding or client VPN. It does not add Responses or Anthropic protocol routes. Workers VPC remains a beta product and its terms, limits and future prices can change. See Cloudflare's current documentation before deploying.
