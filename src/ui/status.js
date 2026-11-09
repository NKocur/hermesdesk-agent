// /status: is the model server reachable, how full is the context, and how fast is it running.
import { durationText, rateText } from "./activity.js";
import { serverHost } from "./chrome.js";
import { countText, limitText, percentText } from "./format.js";

/** Time one model-catalog request. This checks the route and credentials without loading the model. */
export async function probeServer(discover, model, now = Date.now) {
  const started = now();
  try {
    const models = await discover();
    return { ok: true, ms: now() - started, available: models.includes(model) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function statusText({ config, mode, probe, context, tokens, activity }) {
  const rows = [
    [
      "Server",
      serverHost(config.baseUrl) +
        " · " +
        (probe.ok
          ? `reachable, answered in ${Math.round(probe.ms)} ms`
          : `not reachable: ${probe.error}`),
    ],
    [
      "Model",
      config.model +
        (probe.ok
          ? probe.available
            ? " · available"
            : " · not in the server's model list"
          : ""),
    ],
    [
      "Context",
      context?.tokens === null || context?.tokens === undefined
        ? "not measured yet"
        : `${countText(context.tokens)} of ${limitText(context.contextWindow)} tokens (${percentText(context.percent)}%)`,
    ],
  ];
  const last = activity?.last;
  if (last)
    rows.push([
      "Last reply",
      [
        last.rate ? (last.estimated ? "~" : "") + rateText(last.rate) : "",
        `first token after ${durationText(last.waitMs)}`,
        `${last.estimated ? "about " : ""}${last.tokens.toLocaleString("en-US")} tokens in ${durationText(last.ms)}`,
      ]
        .filter(Boolean)
        .join(" · "),
    ]);
  const average = activity?.average;
  if (average || tokens?.input || tokens?.output)
    rows.push([
      "Session",
      [
        average
          ? `${average.estimated ? "~" : ""}${rateText(average.rate)} average over ${average.replies} ${average.replies === 1 ? "reply" : "replies"}`
          : "",
        tokens?.input || tokens?.output
          ? `↑${countText(tokens.input)} ↓${countText(tokens.output)} tokens`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ]);
  rows.push(["Safety", mode.long]);
  return [
    "Status",
    ...rows.map(([name, value]) => name.padEnd(11) + value),
  ].join("\n");
}
