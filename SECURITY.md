# Security

This is an early Windows alpha, not an operating-system sandbox. Built-in file tools restrict paths and prompt before edits. Approved shell commands run with the launching Windows user's permissions. Use a disposable project or an isolated environment for untrusted tasks. These controls do not make arbitrary model-generated commands safe.

Keys are protected using Windows DPAPI and are not included in session files or release artifacts. Do not include keys, statements, personal transcripts, or private source in an issue or bug report. Logs and sessions can contain project content.

For a vulnerability, use this repository's GitHub private vulnerability reporting feature when available. Otherwise open a minimal issue requesting a private contact channel without exploit details or secrets. Do not publish exploit details until a fix is available.

Only the latest alpha is supported.

Headless jobs deny writes and shell commands by default. `--approve-writes` explicitly permits workspace file changes; `--approve-commands` explicitly permits shell commands with the launching account's full OS access. Read-only mode overrides both options. The persistent headless protocol uses local process pipes and does not open a network port. Its launch permissions cannot be escalated by protocol messages. Authentication environment variables are removed before tools run. Cancellation stops pending work and does not roll back completed actions.

Interactive `/permissions` changes apply only when idle, through the user-facing command. They cannot relax a `--read-only` launch and cannot be used to grant access by headless prompts. Auto-approving edits does not auto-approve shell commands or bypass protected file-tool paths.
