import fs from "node:fs";
import { VERSION } from "./config.js";
import path from "node:path";
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
  maxRequests = 16,
  onAgentStart = () => {},
}) {
  return (pi) => {
    let requests = 0;
    pi.on("agent_start", () => {
      requests = 0;
      onAgentStart();
    });
    pi.on("before_provider_request", () => {
      if (++requests > maxRequests)
        throw Error(
          "Request budget reached. Continue with a new message if needed.",
        );
    });
    pi.on("tool_call", async (event, ctx) => {
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
          return { block: true, reason: "Tool is not enabled in this client." };
        const shell = ["powershell", "bash"].includes(name),
          mutation = shell || ["edit", "write"].includes(name);
        if (readOnly && mutation)
          return { block: true, reason: "Read-only mode is enabled." };
        if (!shell) workspacePath(root, input.path || ".");
        if (mutation) {
          if (!shell && approveWrites) return;
          if (!ctx.hasUI)
            return {
              block: true,
              reason: shell
                ? "Shell commands require interactive approval."
                : "File changes require interactive approval, or explicit --approve-writes.",
            };
          const detail = shell
            ? "This command runs with your Windows account permissions, without an OS sandbox.\n\n" +
              String(input.command || "")
            : String(input.path) +
              "\n\n" +
              (name === "write"
                ? String(input.content || "")
                : JSON.stringify(input.edits || input));
          const yes = await ctx.ui.confirm(
            shell ? "Approve shell command?" : "Approve " + name + "?",
            detail,
          );
          if (!yes)
            return { block: true, reason: "The user declined this action." };
        }
      } catch (e) {
        return { block: true, reason: e.message };
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
    pi.on("session_start", (_e, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "hermesdesk",
          readOnly
            ? "HermesDesk | read only"
            : "HermesDesk | ask before edits and commands",
        );
        ctx.ui.setHeader(() => ({
          render: () => [
            `HermesDesk Agent ${VERSION} | powered by Pi`,
            "Strata models run remotely. File tools act in this workspace.",
            "Use /limits for output and thinking settings; /profile extended selects 131K.",
          ],
          invalidate() {},
        }));
      }
    });
  };
}
