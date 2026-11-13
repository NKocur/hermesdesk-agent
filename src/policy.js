import fs from "node:fs";
import path from "node:path";
import { requestApproval } from "./ui/approval.js";
const protectedPart = (p) =>
  /^\.env(?:\.|$)/i.test(p) ||
  [".git", ".ssh", ".aws", ".codex", ".claude", ".pi", "node_modules"].includes(
    p.toLowerCase(),
  ) ||
  /^(?:credentials?|secrets?)(?:\.|$)/i.test(p);
function contained(root, target) {
  const rel = path.relative(root, target);
  return (
    rel === "" ||
    (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep))
  );
}
export function workspacePath(root, value = ".") {
  if (typeof value !== "string" || /[\x00-\x1f]/.test(value))
    throw Error("Invalid file path.");
  root = fs.realpathSync.native(root);
  if (
    process.platform === "win32" &&
    (/^[a-z]:[^\\/]/i.test(value) || /^(?:\\\\|\/\/)/.test(value))
  )
    throw Error("Use a workspace-relative file path.");
  const target = path.resolve(root, value);
  if (!contained(root, target))
    throw Error("File tools are limited to the selected workspace.");
  const rel = path.relative(root, target);
  if (
    rel
      .split(path.sep)
      .some(
        (p) =>
          p.includes(":") ||
          /[ .]$/.test(p) ||
          /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p) ||
          protectedPart(p),
      )
  )
    throw Error(
      "Protected path: use an explicitly approved shell command if access is required.",
    );
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw Error("Unable to resolve file path.");
    ancestor = parent;
  }
  const real = fs.realpathSync.native(ancestor);
  if (
    !contained(root, real) ||
    path.relative(root, real).split(path.sep).some(protectedPart)
  )
    throw Error("A link leaves the workspace or targets a protected path.");
  return target;
}
const REPEAT_LIMIT = 2;
export function policyExtension({
  root,
  readOnly = false,
  approveWrites = false,
  approveCommands = false,
  onPolicyBlock = () => {},
  readPermissions = () => ({ readOnly, approveWrites, approveCommands }),
}) {
  return (pi) => {
    let lastCall,
      repeats = 0;
    pi.on("agent_start", () => {
      lastCall = undefined;
      repeats = 0;
    });
    pi.on("tool_call", async (event, ctx) => {
      const block = (reason) => {
        try {
          onPolicyBlock({ name: event.toolName, reason });
        } catch {}
        return { block: true, reason };
      };
      try {
        const name = event.toolName,
          input = event.input || {};
        if (
          ![
            "read",
            "ls",
            "search",
            "edit",
            "write",
            "powershell",
            "bash",
          ].includes(name)
        )
          return block("Tool is not enabled in this client.");
        // Smaller models can get stuck repeating one call. Two identical calls in a row are
        // allowed (a retry); further ones are refused before any approval prompt.
        const call = name + "\n" + JSON.stringify(input);
        repeats = call === lastCall ? repeats + 1 : 0;
        lastCall = call;
        if (repeats >= REPEAT_LIMIT)
          return block(
            "This exact call was already made " +
              repeats +
              " times in a row and its result will not change. Use the earlier result, or take a different step.",
          );
        const shell = ["powershell", "bash"].includes(name),
          mutation = shell || ["edit", "write"].includes(name);
        const permission = readPermissions();
        if (permission.readOnly && mutation)
          return block("Read-only mode is enabled.");
        const target = shell
          ? undefined
          : workspacePath(root, input.path || ".");
        if (mutation) {
          if (
            (!shell && permission.approveWrites) ||
            (shell && permission.approveCommands)
          )
            return;
          if (!ctx.hasUI)
            return block(
              shell
                ? "Shell commands require interactive approval, or explicit --approve-commands."
                : "File changes require interactive approval, or explicit --approve-writes.",
            );
          const yes = await requestApproval(ctx, name, input, target);
          if (!yes) return block("The user declined this action.");
        }
      } catch (e) {
        return block(e.message);
      }
    });
    pi.on("user_bash", () => {
      return {
        result: {
          output:
            "Ask the agent to run the command so the approval dialog is used.",
          exitCode: 1,
          cancelled: true,
          truncated: false,
        },
      };
    });
  };
}
