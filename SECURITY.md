# Security

This is an early Windows alpha, not an operating-system sandbox. Built-in file tools restrict paths and prompt before edits. Approved shell commands run with the launching Windows user's permissions. Use a disposable project or an isolated environment for untrusted tasks. These controls do not make arbitrary model-generated commands safe.

Keys are protected using Windows DPAPI and are not included in session files or release artifacts. Do not include keys, statements, personal transcripts, or private source in an issue or bug report. Logs and sessions can contain project content.

For a vulnerability, use this repository's GitHub private vulnerability reporting feature when available. Otherwise open a minimal issue requesting a private contact channel without exploit details or secrets. Do not publish exploit details until a fix is available.

Only the latest alpha is supported.
