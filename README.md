# HermesDesk Agent

[![CI](https://github.com/NKocur/hermesdesk-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/NKocur/hermesdesk-agent/actions/workflows/ci.yml)

**Windows alpha: 0.1.0-alpha.1.** Community client built on Pi; not affiliated with or endorsed by Earendil Works or Nous Research.

A running HermesDesk inference gateway is required. This client does not include a hosted model service, server access, or API keys.

An initial Windows-first coding CLI built on the pinned Pi 1.5.0 SDK. The model runs on your HermesDesk/Strata server; coding tools run on the computer where you start this client.

## Install on a Windows computer

Install Node.js 22.19 or newer (Node 24 recommended), then install the alpha from npm:

```powershell
npm.cmd install -g --ignore-scripts hermesdesk-agent@alpha
hermesdesk.cmd connect
hermesdesk.cmd doctor
```

Alternatively, download and extract a Windows alpha bundle from [Releases](https://github.com/NKocur/hermesdesk-agent/releases) and run `Install Agent.cmd`. A tarball can also be installed directly with `npm.cmd install -g --ignore-scripts ./hermesdesk-agent-0.1.0-alpha.1.tgz`.

There is no default server address. `connect` asks for your HTTPS inference endpoint ending in `/v1`; for a server on this computer, loopback HTTP is also accepted. Enter a per-computer inference API key created in HermesDesk Settings > Connect coding tools. Use the Hermes/OpenAI-compatible key option; all current inference keys work with this client. The model is discovered automatically if the configured ID is unavailable. No keys are included in the package.

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

## Settings

```powershell
hermesdesk.cmd config
hermesdesk.cmd config set thinking true
hermesdesk.cmd config set context 131072
hermesdesk.cmd config set maxTokens 4096
hermesdesk.cmd config set temperature 0.7
hermesdesk.cmd config set topP 0.95
hermesdesk.cmd config set topK 20
hermesdesk.cmd config set maxRequests 64
```

Changes apply to the next launch. Context is client metadata, not a request to allocate more server context: keep it at or below the server's configured capacity. Output is capped at 8192 by the gateway. The default request budget is 64 per message and can be set from 1 to 512. Pi's in-chat settings are session-only in this version. Change the server using `hermesdesk connect --url https://your-server/v1`. HTTP is accepted only on loopback addresses.

Windows uses its built-in `curl.exe` for model HTTP requests because the retained Cloudflare bot filter challenged Node fetch and a native Node follow-up request during testing. TLS verification stays enabled, redirects are not followed, credentials are sent through stdin rather than command-line arguments, and disconnects cancel the request. `doctor` checks the connection without loading the model. Cold Strata startup can still take minutes; the client cannot remove server warm-up costs. A Cloudflare 403 is a connection failure, not a model error.

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
