// Approval dialog for edits, writes and shell commands.
// The decision is the only output: true allows this one action; anything else declines it.
import fs from "node:fs";
import { matchesKey } from "@earendil-works/pi-tui";
import { approvalText, editList, editStats } from "./format.js";
import {
  rule,
  spread,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "./layout.js";
import { loadPi } from "./pi.js";

const SHELLS = new Set(["powershell", "bash"]);
const BOM = String.fromCharCode(0xfeff);

function diffLines(theme, input) {
  return approvalText("edit", input)
    .split("\n")
    .slice(2)
    .map((line) =>
      line.startsWith("+ ")
        ? theme.fg("toolDiffAdded", line)
        : line.startsWith("- ")
          ? theme.fg("toolDiffRemoved", line)
          : theme.fg("dim", line),
    );
}

/** Describe one request for the dialog. Reads only the target path the policy already validated. */
export function describeRequest(pi, name, input = {}, target) {
  if (SHELLS.has(name))
    return {
      tone: "warning",
      title: "Run command",
      subject: name === "powershell" ? "PowerShell" : "bash",
      note: "Runs with your account permissions, without an OS sandbox.",
      body: () => pi.highlightCode(String(input.command ?? ""), name),
    };
  const exists = !!target && fs.existsSync(target);
  if (name === "write") {
    const content = String(input.content ?? "").replace(/\r?\n$/, "");
    const count = content.split("\n").length;
    return {
      tone: exists ? "warning" : "accent",
      title: exists ? "Overwrite file" : "Create file",
      subject: String(input.path),
      stats: `${count} line${count === 1 ? "" : "s"}`,
      note: exists ? "Replaces the existing contents." : undefined,
      body: (theme) =>
        pi
          .highlightCode(content, pi.getLanguageFromPath(String(input.path)))
          .map(
            (line, i) =>
              theme.fg("dim", String(i + 1).padStart(String(count).length)) +
              " " +
              line,
          ),
    };
  }
  const edits = editList(input);
  return {
    tone: "accent",
    title: "Edit file",
    subject: String(input.path),
    stats: editStats(edits),
    body: (theme) => {
      try {
        const before = fs.readFileSync(target, "utf8").replace(BOM, "");
        let after = before;
        for (const edit of edits) {
          const at = edit.oldText ? after.indexOf(edit.oldText) : -1;
          if (at < 0) throw Error("no exact match");
          after =
            after.slice(0, at) +
            edit.newText +
            after.slice(at + edit.oldText.length);
        }
        return pi
          .renderDiff(pi.generateDiffString(before, after, 2).diff)
          .split("\n");
      } catch {
        // Show the requested replacements when an exact file preview is not possible.
        return diffLines(theme, input);
      }
    },
  };
}

const CHOICES = [
  { value: true, label: "Allow once", key: "y" },
  { value: false, label: "Deny", key: "n · esc" },
];

export class ApprovalDialog {
  constructor(tui, theme, keybindings, request, done, signal) {
    Object.assign(this, { tui, theme, keybindings, request, done });
    this.index = 0;
    this.scroll = 0;
    this.signal = signal;
    this.onAbort = () => done(false);
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }
  dispose() {
    this.signal?.removeEventListener("abort", this.onAbort);
  }
  body() {
    this.bodyLines ??= this.request.body(this.theme);
    return this.bodyLines;
  }
  /** The preview takes at most about half the screen so the transcript stays visible. */
  previewHeight() {
    const rows = this.tui?.terminal?.rows ?? 24;
    return Math.max(3, Math.min(18, Math.floor(rows / 2) - 6));
  }
  render(width) {
    const t = this.theme,
      r = this.request;
    const risky = r.tone === "warning";
    const stats =
      typeof r.stats === "object"
        ? t.fg("success", `+${r.stats.added}`) +
          " " +
          t.fg("error", `−${r.stats.removed}`)
        : r.stats
          ? t.fg("dim", r.stats)
          : "";
    const lines = [
      rule(
        t,
        width,
        t.fg(r.tone, t.bold(r.title)),
        risky ? "warning" : "borderAccent",
      ),
      spread(" " + t.bold(r.subject), stats + " ", width),
    ];
    if (r.note) lines.push(" " + t.fg(risky ? "warning" : "muted", r.note));

    const wrapped = [];
    for (const line of this.body())
      wrapped.push(...wrapTextWithAnsi(line, Math.max(4, width - 4)));
    const height = this.previewHeight();
    this.maxScroll = Math.max(0, wrapped.length - height);
    this.scroll = Math.min(this.scroll, this.maxScroll);
    const view = wrapped.slice(this.scroll, this.scroll + height);
    lines.push("");
    for (const line of view) lines.push(" " + t.fg("borderMuted", "│ ") + line);
    if (this.maxScroll)
      lines.push(
        "   " +
          t.fg(
            "dim",
            `lines ${this.scroll + 1}–${this.scroll + view.length} of ${wrapped.length} · pgup/pgdn to scroll`,
          ),
      );
    lines.push("");
    CHOICES.forEach((choice, i) => {
      const active = i === this.index;
      lines.push(
        (active ? " " + t.fg("accent", "›") + " " : "   ") +
          (active
            ? t.fg(choice.value ? "success" : "error", t.bold(choice.label))
            : t.fg("muted", choice.label)) +
          " ".repeat(Math.max(2, 13 - visibleWidth(choice.label))) +
          t.fg("dim", choice.key),
      );
    });
    lines.push(" " + t.fg("dim", "↑↓ choose · enter confirm"));
    return lines.map((line) => truncateToWidth(line, width, "…"));
  }
  handleInput(data) {
    const is = (id, key) =>
      this.keybindings?.matches
        ? this.keybindings.matches(data, id)
        : matchesKey(data, key);
    if (data === "y" || data === "Y") return this.done(true);
    if (data === "n" || data === "N" || is("tui.select.cancel", "escape"))
      return this.done(false);
    if (is("tui.select.confirm", "enter"))
      return this.done(CHOICES[this.index].value);
    if (is("tui.select.up", "up") || is("tui.select.down", "down"))
      this.index = 1 - this.index;
    else if (is("tui.select.pageDown", "pageDown"))
      this.scroll = Math.min(
        this.maxScroll ?? 0,
        this.scroll + this.previewHeight(),
      );
    else if (is("tui.select.pageUp", "pageUp"))
      this.scroll = Math.max(0, this.scroll - this.previewHeight());
    else return;
    this.tui?.requestRender?.();
  }
  invalidate() {
    this.bodyLines = undefined;
  }
}

/** Ask for approval: interactive chat gets the dialog above; other UI hosts get a plain confirm. */
export async function requestApproval(ctx, name, input, target) {
  if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    const request = describeRequest(await loadPi(), name, input, target);
    const answer = await ctx.ui.custom(
      (tui, theme, keybindings, done) =>
        new ApprovalDialog(tui, theme, keybindings, request, done, ctx.signal),
      {
        blocked: {
          kind: "permission",
          message: `${request.title}: ${request.subject}`,
        },
      },
    );
    return answer === true;
  }
  return (
    (await ctx.ui.confirm(
      SHELLS.has(name) ? "Approve shell command?" : `Approve ${name}?`,
      approvalText(name, input),
    )) === true
  );
}
