import fs from "node:fs";
import path from "node:path";
import { requestApproval } from "./ui/approval.js";
import { createLoopGuard } from "./loop-guard.js";
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
export function policyExtension({
  root,
  readOnly = false,
  approveWrites = false,
  approveCommands = false,
  onPolicyBlock = () => {},
  onAgentStart = () => {},
  onLoopStop = () => {},
  readPermissions = () => ({ readOnly, approveWrites, approveCommands }),
}) {
  return (pi) => {
    const loop = createLoopGuard();
    const version = (name, input) => {
      if (["powershell", "bash"].includes(name)) return undefined;
      try {
        const target = workspacePath(root, input.path || ".");
        const stat = fs.statSync(target);
        return [stat.mtimeMs, stat.size];
      } catch (error) {
        return error.code === "ENOENT" ? "missing" : "unavailable";
      }
    };
    pi.on("agent_start", () => {
      loop.reset();
      onAgentStart();
    });
    pi.on("tool_result", (event) => {
      try {
        loop.record(
          event.toolName,
          event.input || {},
          version(event.toolName, event.input || {}),
          event.isError,
          event.content,
        );
      } catch {}
    });
    pi.on("tool_call", async (event, ctx) => {
      const block = (reason) => {
        loop.record(
          event.toolName,
          event.input || {},
          version(event.toolName, event.input || {}),
          true,
          [{ type: "text", text: reason }],
        );
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
        const decision = loop.check(name, input, version(name, input));
        if (decision) {
          if (decision.terminate) onLoopStop(decision.reason);
          try {
            if (ctx.hasUI)
              ctx.ui.notify?.(
                decision.reason,
                decision.terminate ? "error" : "warning",
              );
          } catch {}
          if (!decision.recovery) block(decision.reason);
          return {
            block: true,
            reason: decision.reason,
            ...(decision.terminate ? { terminate: true } : {}),
          };
        }
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
