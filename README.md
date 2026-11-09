# HermesDesk Agent

[![CI](https://github.com/NKocur/hermesdesk-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/NKocur/hermesdesk-agent/actions/workflows/ci.yml)

**Windows alpha: 0.1.0-alpha.5.** Community client built on Pi; not affiliated with or endorsed by Earendil Works or Nous Research.

A running HermesDesk inference gateway is required. This client does not include a hosted model service, server access, or API keys.

An initial Windows-first coding CLI built on the pinned Pi 1.5.0 SDK. The model runs on your HermesDesk/Strata server; coding tools run on the computer where you start this client.

## Install on a Windows computer

Install Node.js 22.19 or newer (Node 24 recommended), then install the alpha from npm:

```powershell
npm.cmd install -g --ignore-scripts hermesdesk-agent@alpha
hermesdesk.cmd connect
hermesdesk.cmd doctor
```

Alternatively, download and extract a Windows alpha bundle from [Releases](https://github.com/NKocur/hermesdesk-agent/releases) and run `Install Agent.cmd`. A tarball can also be installed directly with `npm.cmd install -g --ignore-scripts ./hermesdesk-agent-0.1.0-alpha.5.tgz`.

There is no default server address. `connect` asks for your HTTPS model endpoint ending in `/v1`. When the server supports browser sign-in, it opens your browser: sign in to HermesDesk and approve the computer. The CLI receives a short-lived, single-use authorization code on a loopback listener and redeems it with PKCE over HTTPS, then discovers the model and saves the credentials encrypted. You do not copy passwords, API keys, or connection codes. The browser and CLI must be on the same computer. Use `--no-browser` to open the printed browser link yourself. On legacy servers without browser sign-in, the API-key setup remains available; `--manual` explicitly selects it. No server credentials are included in this package.

For optional manual connection-code setup, select **HermesDesk Agent** in the server's **Connect coding tools** settings and create a connection. Run `hermesdesk.cmd connect --code`, then paste its private connection code at the hidden prompt. The code contains both model and Cloudflare Access credentials: treat it like a password. It is never passed as a command-line argument or saved in plain text. The server's normal key expiry and revocation still apply. The package also provides `hermesdesk-agent` as an alias for `hermesdesk`.

Manual Access setup is available with `hermesdesk connect --url https://your-worker.example/v1 --cloudflare-access`; all credentials are prompted privately. For session-only authentication, set `HERMESDESK_API_KEY`, `HERMESDESK_ACCESS_CLIENT_ID` and `HERMESDESK_ACCESS_CLIENT_SECRET`. Non-interactive setup on Windows can use `HERMESDESK_CONNECTION_CODE` with `connect --code`. The agent clears these variables before launching coding tools. Saved Access credentials are bound to the endpoint and removed by logout along with the model key.

On Windows, saved keys are encrypted using DPAPI for the signed-in Windows user and bound to the configured endpoint. Configuration and sessions are stored under `%LOCALAPPDATA%\HermesDeskAgent`. The key is not written to Pi's auth JSON or passed on a command line. `HERMESDESK_API_KEY` supports session-only authentication; the client removes it from its environment before coding tools run. `hermesdesk logout` deletes the saved credential, but does not revoke it on the server.

## Work on a project

```powershell
cd C:\Projects\MyProject
hermesdesk.cmd chat
hermesdesk.cmd chat --continue
hermesdesk.cmd sessions
hermesdesk.cmd chat --session SESSION_ID
hermesdesk.cmd chat --read-only
```

The interactive terminal uses Pi's UI, streaming, diffs, tool displays, session history and compaction. Escape interrupts work. `/quit` exits; `/new` starts a new conversation and `/resume` opens Pi's session selector. The first interactive startup may download Pi's `fd` helper to this client's own Pi cache. Windows Terminal is recommended. Pi's inherited help and exit hints may still mention `pi`; resume this client with `hermesdesk chat --continue` or `--session ID`.

File tools are restricted to the chosen project and reject outside links and protected paths such as `.env`, `.git`, credential files and agent configurations. Each edit and shell command asks for approval. Shell commands execute as your user and are **not OS-sandboxed**; after approval they can access anything your account can access. Direct `!` shell shortcuts are disabled so commands use the managed approval path. Project JavaScript extensions, MCP servers and packages are not automatically loaded.

The root project's `AGENTS.md` is included as instructions when it is an ordinary allowed file under 64 KiB. Existing global Pi/Claude settings are not imported. This first version does not synchronize HermesDesk chats, workspace memory or Hermes's skill-learning loop.

## One-shot requests

```powershell
hermesdesk.cmd run "Explain this repository" --read-only
hermesdesk.cmd run "Create a small example file" --approve-writes
hermesdesk.cmd run "Summarize README.md" --json
```

One-shot operation denies writes unless `--approve-writes` is explicitly provided. It never approves shell commands without interactive confirmation. JSON mode streams `text`, `tool` and `done` records to stdout; diagnostics go to stderr.

## In-chat controls

Use these inside interactive chat. Commands run locally, consume no model tokens, and change the next request without restarting the conversation:

```text
/limits
/profile extended
/tokens 65536
/think xhigh
/thinking-budget 8192
/thinking-budget auto
/limits show
/limits save
```

`/limits` opens a selector for the same controls. Profiles are `fast` (32K, thinking off), `balanced` (64K, xhigh), and `extended` (131K, xhigh). Output counts include thinking and answer. The model can stop before the allowance is used, and Strata can reduce the thinking cap to preserve answer room. Individual controls keep your other sampler settings; profiles apply the recommended sampler values.

Changes last for the current CLI session. `/limits save` keeps generation defaults for future launches; `/limits reset` restores saved defaults. Escape cancels a menu without applying changes. Changes are blocked while the agent is working. Pi's existing `/thinking off|low|medium|high` and keyboard thinking controls now also reach Strata (`high` maps to `xhigh`). Credentials, file permissions and command approvals are unaffected.

## Settings

```powershell
hermesdesk.cmd config
hermesdesk.cmd config preset extended
hermesdesk.cmd config set thinking true
hermesdesk.cmd config set reasoningEffort xhigh
hermesdesk.cmd config set thinkingBudget 16384
hermesdesk.cmd config set context 262144
hermesdesk.cmd config set maxTokens 131072
hermesdesk.cmd config set temperature 0.7
hermesdesk.cmd config set topP 0.95
hermesdesk.cmd config set topK 20
hermesdesk.cmd config set maxRequests 64
```

Profiles: `fast` uses 32K with thinking off; `balanced` uses 64K with xhigh thinking; `extended` uses 131K with xhigh thinking. Thinking profiles use Qwen's recommended sampling (temperature 1, top-p .95, top-k 20). `thinkingBudget 0` is automatic. A positive budget is a ceiling, must be below `maxTokens`, and Strata may reduce it to preserve answer space. `maxTokens` includes **thinking plus the final answer**; the model can stop earlier.

For a single launch, without changing saved settings:

```powershell
hermesdesk.cmd chat --profile extended
hermesdesk.cmd run "Review this repository" --read-only --max-tokens 65536 --thinking on --reasoning-effort medium --thinking-budget 8192
```

Fresh installations default to a 131K total cap with thinking off. Existing saved values are retained: use `config preset extended` to switch to the tested thinking profile. The server must support these limits; older gateways capped output at 8K. Pi's compaction reserves space for the configured output budget.

Changes apply to the next launch. Context is client metadata, not a request to allocate more server context: keep it at or below the server's configured capacity. The updated gateway allows up to 131072 combined output tokens. Input, thinking and answer share the server context; the full 262K-thinking plus 131K-answer allowance in Qwen documentation assumes an extended 1M context. The default request budget is 64 per message and can be set from 1 to 512. Pi's in-chat settings are session-only in this version. Change the server using `hermesdesk connect --url https://your-server/v1`. HTTP is accepted only on loopback addresses.

Windows uses its built-in `curl.exe` for model HTTP requests because the retained Cloudflare bot filter challenged Node fetch and a native Node follow-up request during testing. TLS verification stays enabled, redirects are not followed, credentials are sent through stdin rather than command-line arguments, and disconnects cancel the request. `doctor` checks the connection without loading the model. A browser challenge from zone-wide Bot Fight Mode cannot be solved by an API client; the server owner must configure API-compatible protection. Transport compatibility alone does not guarantee that every computer will be accepted. Cold Strata startup can still take minutes; the client cannot remove server warm-up costs. A Cloudflare 403 is a connection failure, not a model error.

## Optional private Worker gateway

The generic Worker source and deployment notes are in [worker/](worker/README.md). It requires Cloudflare Access authentication for its configured application and proxies only model discovery and chat completions to a single private VPC Service. It exposes no desktop tools, file APIs, application sessions, or arbitrary destinations. Website Bot Fight Mode can remain enabled when the agent uses a separate `workers.dev` endpoint. Workers VPC is beta; check Cloudflare's current availability, pricing and limits before adopting it.

## Develop

```powershell
npm.cmd ci --ignore-scripts
npm.cmd test
node bin/hermesdesk.js --help
npm.cmd pack --ignore-scripts
```

The client is a standalone project. Use the GitHub alpha release assets for the Windows installer or tarball. The `.tgz` contains no local credentials, test transcripts or model files. Pi's MIT license is retained in `THIRD_PARTY_NOTICES.md`; dependency licenses remain in the installed packages.

## License and contributing

MIT. Pi is also MIT-licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for development and [SECURITY.md](SECURITY.md) for reporting security issues.
