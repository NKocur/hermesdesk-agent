// Live permissions are process-local; launch restrictions and protected paths stay enforced.
import { approvalMode } from "./ui/format.js";
import { chooseItem } from "./ui/menu.js";

export const PERMISSION_MODES = {
  ask: { readOnly: false, approveWrites: false, approveCommands: false },
  edits: { readOnly: false, approveWrites: true, approveCommands: false },
  "fuck-it": { readOnly: false, approveWrites: true, approveCommands: true },
  "read-only": { readOnly: true, approveWrites: false, approveCommands: false },
};
const NOTES = {
  ask: "Edits and shell commands ask first.",
  edits: "File edits apply automatically; shell commands ask first.",
  "fuck-it":
    "Auto-approve edits and shell commands; commands run with your account access.",
  "read-only":
    "Read and search only; file edits and shell commands are blocked.",
};
export function createPermissions({
  readOnly = false,
  approveWrites = false,
  approveCommands = false,
} = {}) {
  const lockedReadOnly = readOnly;
  const current = {
    readOnly,
    approveWrites: !readOnly && approveWrites,
    approveCommands: !readOnly && approveCommands,
  };
  const display = approvalMode(current);
  return {
    display,
    lockedReadOnly,
    read: () => ({ ...current }),
    mode: () =>
      current.readOnly
        ? "read-only"
        : current.approveWrites && current.approveCommands
          ? "fuck-it"
          : current.approveWrites
            ? "edits"
            : "ask",
    change(mode, beforeChange = () => {}) {
      const next = Object.hasOwn(PERMISSION_MODES, mode)
        ? PERMISSION_MODES[mode]
        : undefined;
      if (!next)
        throw Error("Usage: /permissions ask|edits|fuck-it|read-only|show");
      if (lockedReadOnly && mode !== "read-only")
        throw Error(
          "This CLI was launched with --read-only. Restart without that flag to permit edits or commands.",
        );
      beforeChange({ ...next });
      Object.assign(current, next);
      Object.assign(display, approvalMode(current));
      return { ...current };
    },
  };
}
export function permissionsCommands({ permissions, apply }) {
  return (pi) => {
    const show = (ctx) =>
      ctx.ui.notify(
        "Permissions: " +
          permissions.display.long +
          ".\nChanges apply to this CLI process; launch defaults are unchanged.",
        "info",
      );
    const idle = (ctx) => {
      if (!ctx.isIdle())
        throw Error(
          "Wait for the current run to finish, or press Ctrl+C before changing permissions.",
        );
    };
    pi.registerCommand("permissions", {
      description:
        "Approval mode: ask, auto-approve edits, Fuck it Mode, or read-only",
      getArgumentCompletions: (prefix) =>
        [...Object.keys(PERMISSION_MODES), "show"]
          .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
          .map((value) => ({
            value,
            label: value === "fuck-it" ? "Fuck it Mode" : value,
          })),
      handler: async (args, ctx) => {
        try {
          let mode = args.trim().toLowerCase();
          if (/^fuck[ -]+it(?:[ -]+mode)?$/.test(mode)) mode = "fuck-it";
          if (mode === "show") return show(ctx);
          if (!ctx.hasUI || ctx.mode !== "tui")
            throw Error(
              "Change permissions in interactive chat using /permissions. Headless permissions are fixed by launch options.",
            );
          idle(ctx);
          if (!mode)
            mode = await chooseItem(ctx, {
              title: "Permissions",
              subtitle: permissions.lockedReadOnly
                ? "This launch is restricted by --read-only."
                : "Applies immediately to this CLI process. Fuck it Mode also auto-approves shell commands.",
              items: Object.keys(PERMISSION_MODES)
                .filter(
                  (value) =>
                    !permissions.lockedReadOnly || value === "read-only",
                )
                .map((value) => ({
                  value,
                  label:
                    value === "ask"
                      ? "Ask first"
                      : value === "edits"
                        ? "Auto-approve edits"
                        : value === "fuck-it"
                          ? "Fuck it Mode"
                          : "Read-only",
                  description: NOTES[value],
                  current: permissions.mode() === value,
                })),
            });
          if (mode === undefined) return;
          idle(ctx);
          await apply(mode);
          show(ctx);
        } catch (error) {
          ctx.ui.notify(error.message, "error");
        }
      },
    });
  };
}
