# Changelog

## Unreleased

## 0.1.0-alpha.12

- Suppress automatic Pi update banners and their changelog link with the SDK's supported version-check flag.
- Mark the bundled SDK changelog version as seen in HermesDesk's in-memory settings, preventing unrelated startup release notes.
- Keep normal model networking enabled and direct users to update the HermesDesk package rather than its pinned SDK dependency.

## 0.1.0-alpha.11

- Add Fuck it Mode to `/permissions`: `fuck-it` auto-approves edits and shell commands; `ask` restores approval prompts.
- Show the named mode in the menu, header, footer and status, with descriptions matching actual command approval behavior.
- Preserve read-only launch restrictions, idle-only changes and fixed headless launch permissions. The mode is local to the running CLI process.
- Avoid rebuilding tool availability when switching between approval modes with the same tool set.

## 0.1.0-alpha.10

- Add `/permissions` with a menu and direct `ask`, `edits`, `read-only` and `show` commands; changes update the running tool policy and status displays immediately.
- Keep changes local to the current CLI process, block changes during active work, preserve read-only launch restrictions, and prevent headless prompts from changing permissions.
- Use stable approval-policy instructions across permission modes; auto-approving edits continues to ask for shell commands and preserve protected file paths.

## 0.1.0-alpha.9

- Add a persistent `headless` JSONL mode with correlated prompts, job events/results, state queries, cancellation and graceful shutdown; it keeps one conversation and workspace per process and opens no network port.
- Extend `run` with UTF-8 stdin/prompt files, final JSON or streamed JSONL, per-job timeouts, request budgets and distinct exit codes for failures, policy refusals, output limits and cancellation.
- Keep session resumption available in both modes and add machine-readable session listings.
- Deny headless writes and shell commands by default; support explicit `--approve-writes` and `--approve-commands`, with read-only mode taking precedence and protected file paths preserved.
- Keep machine output separate from interactive presentation and redact authentication credentials from reported results/errors.

## 0.1.0-alpha.8

- Show what a local model is doing while you wait: time waiting for the first token, then thinking, writing or tool-call preparation with an estimated token rate, and a note when output stalls.
- Keep estimated reply/session speeds marked with `~` when token usage is unavailable.
- Add `/status`: server reachability and response time, model availability, context fill, last-reply speed and time to first token, and the session average.
- Show the connected model and server in the header, and the last reply's speed and a context-fill bar in the footer.
- Explain output-limit stops, including when thinking used the whole allowance, and name the setting to change.
- Refuse a third identical tool call in a row before any approval prompt, so a looping model moves on.
- Give the model short, concrete working rules, including that the Windows shell is PowerShell.
- Replace gateway HTML error pages in the transcript with a one-line explanation.
- Show working state in the terminal title; `HERMESDESK_BELL=on` rings the bell when a run of 30 seconds or more finishes.

## 0.1.0-alpha.7

- Ctrl+C cancels an active run and returns to the prompt, including streaming replies, running tools and pending approvals. Idle clear-input and double-press-to-exit behavior is preserved.
- Dismiss pending file/command approvals on run cancellation without allowing the action.
- Show Ctrl+C stop in the terminal header.

## 0.1.0-alpha.6

- Add a HermesDesk terminal presentation: light and dark palettes chosen from the terminal background (`HERMESDESK_THEME` overrides), a compact header, and a two-line footer with workspace, branch, model, thinking, output limit, approval mode, token totals and context fill.
- Show tool calls as single status lines with gutter-framed output instead of padded panels; long output still collapses and expands with `ctrl+o`.
- Replace raw JSON in approval prompts with a diff, file preview or highlighted command, a scrollable preview, and `y`/`n` shortcuts. Escape and cancel still deny.
- Give `/limits`, `/profile` and `/think` titled menus with descriptions and the current choice marked.
- Hide Pi's startup resource listing.
- Preserve the actual error message when a search fails instead of showing an empty-result label.

## 0.1.0-alpha.3

- Open browser sign-in automatically from connect on supported servers, with explicit computer approval.
- Add a loopback callback, state binding, short-lived one-use codes and S256 PKCE exchange over HTTPS.
- Add --no-browser and --manual fallbacks, cancellation and timeout handling.
- Distinguish a Cloudflare sign-in response from an invalid model key.

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
