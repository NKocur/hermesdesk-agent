# HermesDesk Agent

[![CI](https://github.com/NKocur/hermesdesk-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/NKocur/hermesdesk-agent/actions/workflows/ci.yml)

**Windows alpha: 0.1.0-alpha.13.** Community client built on Pi; not affiliated with or endorsed by Earendil Works or Nous Research.

A running HermesDesk inference gateway is required. This client does not include a hosted model service, server access, or API keys.

An initial Windows-first coding CLI built on the pinned Pi 1.5.0 SDK. The model runs on your HermesDesk/Strata server; coding tools run on the computer where you start this client.

## Install on a Windows computer

Install Node.js 22.19 or newer (Node 24 recommended), then install the alpha from npm:

```powershell
npm.cmd install -g --ignore-scripts hermesdesk-agent@alpha
hermesdesk.cmd connect
hermesdesk.cmd doctor
```

Alternatively, download and extract a Windows alpha bundle from [Releases](https://github.com/NKocur/hermesdesk-agent/releases) and run `Install Agent.cmd`. A tarball can also be installed directly with `npm.cmd install -g --ignore-scripts ./hermesdesk-agent-0.1.0-alpha.13.tgz`.

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

The interactive terminal uses Pi's UI, streaming, diffs, tool displays, session history and compaction, with a HermesDesk presentation layer (`src/ui/`). A compact header shows the connected model and server, the safety mode and key commands; a two-line footer shows the workspace and git branch, model, thinking effort, output limit, approval mode, token totals, the last reply's speed and a context-fill bar. Tool calls appear as one line with a status mark (`●` running, `✓` done, `✗` failed or declined) and their output sits behind a quiet gutter; `ctrl+o` expands long output. Edits, writes and commands open an approval panel with a diff, file preview or highlighted command: `y` allows once, `n` or Escape denies.

Because the model runs on your own hardware, the working line says what it is waiting for: `Waiting for model · 24s · processing the prompt` before the first token (a wait of a minute or more adds that the model may still be loading), then `Thinking`, `Writing` or `Preparing edit` with an estimated tokens-per-second rate, and a note when output stalls. `/status` checks that the server answers and the model is listed (without loading it), and reports context fill, the last reply's speed and time to first token, and the session average. When a reply stops at the output limit, a notice says whether thinking used the whole allowance and which setting to change. The terminal title shows `●` while the agent works; set `HERMESDESK_BELL=on` to also ring the terminal bell when a run of 30 seconds or more finishes.

If the model issues the same tool call three times in a row, the third and later calls are refused without an approval prompt and the model is told to take a different step. The count resets with each message you send.

Colors follow the terminal background automatically, using the HermesDesk light or dark palette. Body text keeps the terminal's own foreground color, and fonts and sizes always come from the terminal. Set `HERMESDESK_THEME` to `light` or `dark` to force a palette (for terminals that do not report their background), or `terminal` to use Pi's palette derived from your terminal colors.

Escape interrupts work. `/quit` exits; `/new` starts a new conversation and `/resume` opens Pi's session selector. The first interactive startup may download Pi's `fd` helper to this client's own Pi cache. Windows Terminal is recommended. Pi's inherited help and exit hints may still mention `pi`; resume this client with `hermesdesk chat --continue` or `--session ID`.

File tools are restricted to the chosen project and reject outside links and protected paths such as `.env`, `.git`, credential files and agent configurations. Edits and shell commands ask for approval by default. Shell commands execute as your user and are **not OS-sandboxed**; after approval they can access anything your account can access. Direct `!` shell shortcuts are disabled so commands use the managed approval path. Project JavaScript extensions, MCP servers and packages are not automatically loaded.

The root project's `AGENTS.md` is included as instructions when it is an ordinary allowed file under 64 KiB. Existing global Pi/Claude settings are not imported. This first version does not synchronize HermesDesk chats, workspace memory or Hermes's skill-learning loop.

HermesDesk pins Pi as an SDK dependency. Automatic Pi update banners and startup changelog notices are suppressed; update this client with `npm.cmd install -g --ignore-scripts hermesdesk-agent@alpha`. The dependency is updated through a tested HermesDesk release.

## Headless jobs and automation

No terminal window is required. Sign in once with `hermesdesk connect` under the account that runs the job, or provide the existing session-only authentication environment variables. Authentication setup is never prompted during a job. Models still run on your configured HermesDesk/Strata server; tools work on the computer running the CLI.

```powershell
hermesdesk.cmd run "Explain this repository" --read-only
hermesdesk.cmd run "Review the code" --output-format json --timeout 300
hermesdesk.cmd run --prompt-file request.txt --output-format json
Get-Content -Raw request.txt | hermesdesk.cmd run --stdin --json
hermesdesk.cmd run "Continue the review" --continue --output-format json
hermesdesk.cmd sessions --output-format json
```

Request sources are positional text, `--prompt-file PATH`, or piped UTF-8 text using `--stdin` / `run -`. Choose one source. Requests are limited to 1 MiB. Prompt file paths resolve from the launching directory; `--cwd PATH` selects the agent's workspace. Headless prompts are task text: slash commands are not dispatched, and bang commands are rejected.

`--output-format text` streams reply text to stdout and tool notices to stderr. `--output-format json` writes one final JSON object. `--output-format jsonl` streams `start`, `text`, `tool`, `tool_result`, `error` and `done` records; `--json` remains an alias for JSONL. There are no TUI escape sequences or progress spinners. The final result includes `ok`, `status`, `exitCode`, `session`, final/partial `text`, `stopReason`, per-job token `usage` and `durationMs`. Policy refusals appear in `blocked`. Model reasoning is not included in the output stream. Save results using normal shell redirection.

Jobs save their conversations automatically. Use `--continue` for the newest conversation in the selected workspace, or `--session ID` for a specific conversation. History stays on the client computer. Profiles and generation overrides work as in interactive chat. Jobs have no fixed model-request count. `--timeout SECONDS` applies to an entire job after runtime startup, including tools; without it, the provider's own timeout still applies. Ctrl+C/SIGINT cancels work; SIGTERM cancels and exits. Cancellation does not undo completed actions.

File changes are denied unless launched with `--approve-writes`. Shell commands are denied unless launched with `--approve-commands`; this explicitly authorizes model-generated commands with the launching account's permissions, including access outside the workspace. Shell execution has no OS sandbox. `--read-only` takes precedence over both options; protected file-tool paths remain blocked even when writes are pre-approved. Any policy refusal makes the final job status `blocked`, even if the model subsequently writes a response. Ordinary tool failures can be recovered from by the model.

| Exit code | Meaning |
|---|---|
| 0 | Completed |
| 1 | Model, connection or runtime failure |
| 2 | Invalid request/options or oversized protocol input |
| 3 | One or more actions blocked by policy |
| 4 | Reply stopped at the output limit |
| 124 | Job time limit reached |
| 130 | Cancelled / SIGINT |
| 143 | SIGTERM |

## Persistent headless protocol

Applications can spawn this command with stdin, stdout and stderr pipes:

```powershell
hermesdesk.cmd headless --cwd C:\Projects\MyProject --read-only
```

This is HermesDesk's version 1 JSONL protocol, separate from Pi's native RPC protocol. It opens no HTTP/TCP listener. A process uses one workspace and one conversation, with one active job at a time. Launch options set its permissions; protocol messages cannot grant more access. Use the existing authenticated model endpoint when the model server is on another computer.

The first stdout record has `type: "ready"`, protocol/version, workspace, session, permissions and supported commands. Send one JSON object per line:

```jsonl
{"id":"review-1","type":"prompt","message":"Review this project","timeout":300}
{"id":"state-1","type":"get_state"}
{"id":"cancel-1","type":"abort"}
{"id":"exit-1","type":"shutdown"}
```

Each command receives a `response` with its optional correlation `id`, `command` and `success`; failures include `error`. A prompt's acknowledgement means accepted. Its streamed events and final `done` retain the prompt ID. `done.ok` and `done.status` report the outcome. Concurrent prompts are rejected; send another after `done`, or abort the active prompt and wait for its `done` first. `get_state` reports the session and whether a job is active. `abort` cancels work and leaves the process available. `shutdown` cancels active work, flushes results and exits; closing stdin instead lets the current job finish and then exits. A job's failure is reported in `done`; the persistent process stays available until shutdown. Malformed command lines receive an error response. Lines larger than 1 MiB close the process with exit 2. A disconnected output pipe cancels active work.

Use `--continue` or `--session ID` when starting the process to restore an earlier conversation. For scheduled jobs under another Windows account, sign in under that account or provide session-only credentials; the saved DPAPI credentials belong to the account that created them.

## In-chat controls

`/permissions` opens an approval-mode menu and takes effect immediately without restarting:

```text
/permissions ask
/permissions edits
/permissions fuck-it
/permissions read-only
/permissions show
```

`ask` requests approval for edits and shell commands. `edits` auto-approves workspace file edits while shell commands still ask. **Fuck it Mode** (`/permissions fuck-it`) auto-approves both file edits and shell commands. Commands run with your account access, including access outside the workspace. The header/footer name the active mode; switch back with `/permissions ask`. `read-only` enables reading and searching and blocks file changes/commands; switch back with `/permissions ask` or `edits`. The header, footer and `/status` follow the current mode. Changes are local to the running CLI process, consume no model calls and add no messages to model history. They are blocked during an active run; finish it or press Ctrl+C first. Menu cancellation leaves the mode unchanged. Launching with `--read-only` locks that restriction until you restart without the flag. Headless permissions stay fixed by launch options, and protected file paths remain blocked.


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
/status
```

`/limits` opens a settings menu for the same controls, showing each current value; `/profile` and `/think` without a value open menus that mark the active choice. Profiles are `fast` (32K, thinking off), `balanced` (64K, xhigh), and `extended` (131K, xhigh). Output counts include thinking and answer. The model can stop before the allowance is used, and Strata can reduce the thinking cap to preserve answer room. Individual controls keep your other sampler settings; profiles apply the recommended sampler values.

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
```

Profiles: `fast` uses 32K with thinking off; `balanced` uses 64K with xhigh thinking; `extended` uses 131K with xhigh thinking. Thinking profiles use Qwen's recommended sampling (temperature 1, top-p .95, top-k 20). `thinkingBudget 0` is automatic. A positive budget is a ceiling, must be below `maxTokens`, and Strata may reduce it to preserve answer space. `maxTokens` includes **thinking plus the final answer**; the model can stop earlier.

For a single launch, without changing saved settings:

```powershell
hermesdesk.cmd chat --profile extended
hermesdesk.cmd run "Review this repository" --read-only --max-tokens 65536 --thinking on --reasoning-effort medium --thinking-budget 8192
```

Fresh installations default to a 131K total cap with thinking off. Existing saved values are retained: use `config preset extended` to switch to the tested thinking profile. The server must support these limits; older gateways capped output at 8K. Pi's compaction reserves space for the configured output budget.

Changes apply to the next launch. Context is client metadata, not a request to allocate more server context: keep it at or below the server's configured capacity. The updated gateway allows up to 131072 combined output tokens. Input, thinking and answer share the server context; the full 262K-thinking plus 131K-answer allowance in Qwen documentation assumes an extended 1M context. There is no per-message model-request cap. Legacy `maxRequests` values in saved configurations are ignored; remove the retired `--max-requests` option from scripts. Pi's in-chat settings are session-only in this version. Change the server using `hermesdesk connect --url https://your-server/v1`. HTTP is accepted only on loopback addresses.

Windows uses its built-in `curl.exe` for model HTTP requests because the retained Cloudflare bot filter challenged Node fetch and a native Node follow-up request during testing. TLS verification stays enabled, redirects are not followed, credentials are sent through stdin rather than command-line arguments, and disconnects cancel the request. `doctor` checks the connection without loading the model. A browser challenge from zone-wide Bot Fight Mode cannot be solved by an API client; the server owner must configure API-compatible protection. Transport compatibility alone does not guarantee that every computer will be accepted. Cold Strata startup can still take minutes; the client cannot remove server warm-up costs. A Cloudflare 403 is a connection failure, not a model error.

Press **Ctrl+C** during a run to cancel generation or a running tool and return to the prompt. Pending file/command approvals are dismissed without granting permission. Cancellation does not undo completed actions. Escape also interrupts from the chat editor. When idle, Ctrl+C clears the input; pressing it twice quickly exits. Ctrl+D exits with an empty input.

Brief connection failures and transient HTTP errors get up to two retries before the response stream opens. Authentication, validation and request-size errors fail immediately. Once a response is streaming, an interrupted response stops the run; the client does not automatically replay it. Previously completed tool results stay in the conversation, so recovery before a later model response does not repeat those actions. Ctrl+C and job timeouts also cancel retry backoff. Retries can add HTTP attempts within a model-call round. Windows limits connection setup to 20 seconds and reports bounded curl diagnostics with credentials redacted if retries are exhausted. Whole-agent retries remain disabled.

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

### Repeated-tool recovery

Jobs have no fixed request-count cap. Repeated unchanged calls or identical tool failures receive one recovery instruction, including the last error. An edit recovery asks the model to reread the current file and use exact current text. If it repeats the same call again, the run ends with a specific loop diagnostic; history and completed changes are preserved. Reading a file between identical failed edits does not reset that failure history. Changed inputs or file contents permit a fresh attempt. A new user message starts fresh. Headless runs report an unrecovered loop as failed rather than completed.
