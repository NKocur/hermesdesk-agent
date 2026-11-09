import fs from "node:fs/promises";
import path from "node:path";
import { workspacePath } from "./policy.js";
// Literal search avoids executing model-provided regular expressions. Every entry is checked
// before it is opened; links and protected files are excluded even during recursive searches.
export async function searchWorkspace(
  root,
  { query, path: relative = ".", limit = 100 },
  signal,
) {
  if (typeof query !== "string" || !query.length || query.length > 1000)
    throw Error("Use a non-empty literal query of at most 1000 characters.");
  limit = Math.max(1, Math.min(100, Number(limit) || 100));
  const queue = [workspacePath(root, relative)],
    matches = [];
  let files = 0,
    bytes = 0,
    entries = 0,
    truncated = false;
  while (queue.length && matches.length < limit) {
    signal?.throwIfAborted();
    const current = queue.pop();
    let stat;
    try {
      workspacePath(root, current);
      stat = await fs.lstat(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      const directory = await fs.opendir(current);
      for await (const entry of directory) {
        if (++entries > 20000) {
          truncated = true;
          break;
        }
        if (entry.isSymbolicLink()) continue;
        try {
          queue.push(workspacePath(root, path.join(current, entry.name)));
        } catch {}
      }
      if (truncated) break;
      continue;
    }
    if (!stat.isFile() || stat.size > 1024 * 1024) continue;
    if (++files > 2000 || bytes + stat.size > 16 * 1024 * 1024) {
      truncated = true;
      break;
    }
    bytes += stat.size;
    let text;
    try {
      text = await fs.readFile(workspacePath(root, current), "utf8");
    } catch {
      continue;
    }
    if (text.slice(0, 8192).includes("\0")) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < limit; i++)
      if (lines[i].includes(query))
        matches.push(
          path.relative(root, current).replace(/\\/g, "/") +
            ":" +
            (i + 1) +
            ": " +
            lines[i].slice(0, 500),
        );
  }
  if (queue.length || matches.length >= limit) truncated = true;
  return { matches, files, truncated };
}
export function searchTool(root) {
  return {
    name: "search",
    label: "Search workspace",
    description:
      "Search workspace text files for a literal, case-sensitive string. Skips protected files, links and binary or oversized files. Returns matching paths and line numbers.",
    promptSnippet: "Search project text safely",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(_id, params, signal) {
      const result = await searchWorkspace(root, params, signal);
      return {
        content: [
          {
            type: "text",
            text:
              (result.matches.join("\n") || "No matches.") +
              (result.truncated
                ? "\n[Search limit reached; narrow the directory or query.]"
                : ""),
          },
        ],
        details: { filesSearched: result.files, truncated: result.truncated },
      };
    },
  };
}
