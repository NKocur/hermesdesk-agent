import { loadConfig, saveConfig, validateConfig } from "./config.js";
import { PROFILES, profile } from "./generation.js";
import { limitText } from "./ui/format.js";
import { chooseItem } from "./ui/menu.js";

const GENERATION_KEYS = [
  "maxTokens",
  "thinking",
  "reasoningEffort",
  "thinkingBudget",
  "temperature",
  "topP",
  "topK",
];
const pick = (config) =>
  Object.fromEntries(GENERATION_KEYS.map((key) => [key, config[key]]));
const number = (value) => value.toLocaleString("en-US");
export function tokenValue(value, automatic = false) {
  const text = String(value).trim().toLowerCase();
  if (automatic && ["auto", "automatic", "0"].includes(text)) return 0;
  if (!/^\d+(?:k)?$/.test(text))
    throw Error(
      "Use a whole token count, or 32k, 64k, 128k." +
        (automatic ? " Use auto for the thinking budget." : ""),
    );
  return Number(text.replace(/k$/, "")) * (text.endsWith("k") ? 1024 : 1);
}
export function generationSummary(config) {
  return [
    "Generation settings",
    `Output    ${number(config.maxTokens)} tokens, thinking + answer`,
    `Thinking  ${config.thinking ? config.reasoningEffort : "off"} · budget ${config.thinkingBudget ? number(config.thinkingBudget) : "automatic"}${config.thinking ? "" : " (unused while off)"}`,
    `Sampling  temperature ${config.temperature} · top-p ${config.topP} · top-k ${config.topK}`,
    "Applies to this session now. /limits save keeps it for future launches.",
  ].join("\n");
}
const PROFILE_NOTES = {
  fast: "quick answers",
  balanced: "everyday work",
  extended: "long tasks",
};
const THINK_NOTES = {
  off: "answer directly",
  low: "brief reasoning",
  medium: "moderate reasoning",
  xhigh: "deepest reasoning",
};
/** The profile whose settings exactly match the configuration, if any. */
export function currentProfile(config) {
  return Object.keys(PROFILES).find((name) =>
    Object.entries(PROFILES[name]).every(
      ([key, value]) => config[key] === value,
    ),
  );
}
export function generationCommands({ home, read, apply }) {
  return (pi) => {
    // Interactive chat shows these settings in the HermesDesk footer; other UI hosts get a status.
    const status = (ctx) => {
      const c = read();
      if (ctx.hasUI && ctx.mode !== "tui")
        ctx.ui.setStatus(
          "hermesdesk-generation",
          `${number(c.maxTokens)} tokens | thinking ${c.thinking ? c.reasoningEffort : "off"} | /limits`,
        );
    };
    const inform = (ctx, text, type = "info") => ctx.ui.notify(text, type);
    const idle = (ctx) => {
      if (!ctx.isIdle())
        throw Error(
          "Wait for the current reply to finish, or press Escape before changing generation settings.",
        );
    };
    const update = async (changes, ctx) => {
      idle(ctx);
      const next = validateConfig({ ...read(), ...changes });
      await apply(next);
      status(ctx);
      inform(ctx, generationSummary(read()));
    };
    const register = (name, description, values, handler) => {
      pi.registerCommand(name, {
        description,
        getArgumentCompletions: (prefix) =>
          values
            .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
            .map((value) => ({ value, label: value })),
        handler: async (args, ctx) => {
          try {
            await handler(args.trim(), ctx);
          } catch (error) {
            inform(ctx, error.message, "error");
          }
        },
      });
    };
    const choose = async (ctx, title, items, subtitle) => {
      if (!ctx.hasUI)
        throw Error(
          "Provide a value, or open interactive chat to use the settings menu.",
        );
      return chooseItem(ctx, { title, subtitle, items });
    };
    const selectProfile = async (args, ctx) => {
      idle(ctx);
      const value =
        args ||
        (await choose(
          ctx,
          "Generation profile",
          Object.entries(PROFILES).map(([name, p]) => ({
            value: name,
            label: name,
            description: `${limitText(p.maxTokens)} output · thinking ${p.thinking ? p.reasoningEffort : "off"} · ${PROFILE_NOTES[name]}`,
            current: currentProfile(read()) === name,
          })),
          "Sets output size, thinking and sampling together.",
        ));
      if (value === undefined) return;
      await update(profile(value.toLowerCase()), ctx);
    };
    const selectTokens = async (args, ctx) => {
      idle(ctx);
      const value =
        args ||
        (ctx.hasUI
          ? await ctx.ui.input(
              "Total output tokens (thinking + answer)",
              String(read().maxTokens),
            )
          : undefined);
      if (value === undefined) {
        if (!ctx.hasUI) throw Error("Usage: /tokens 65536");
        return;
      }
      await update({ maxTokens: tokenValue(value) }, ctx);
    };
    const selectThinking = async (args, ctx) => {
      idle(ctx);
      const value =
        args ||
        (await choose(
          ctx,
          "Thinking effort",
          ["off", "low", "medium", "xhigh"].map((value) => ({
            value,
            label: value,
            description: THINK_NOTES[value],
            current:
              value === (read().thinking ? read().reasoningEffort : "off"),
          })),
          "Thinking shares the total output limit with the answer.",
        ));
      if (value === undefined) return;
      const setting = value.toLowerCase();
      if (!["on", "off", "low", "medium", "high", "xhigh"].includes(setting))
        throw Error("Usage: /think off|on|low|medium|xhigh");
      await update(
        setting === "off"
          ? { thinking: false }
          : {
              thinking: true,
              reasoningEffort:
                setting === "on"
                  ? read().reasoningEffort
                  : setting === "high"
                    ? "xhigh"
                    : setting,
            },
        ctx,
      );
    };
    const selectBudget = async (args, ctx) => {
      idle(ctx);
      const value =
        args ||
        (ctx.hasUI
          ? await ctx.ui.input(
              "Thinking token budget (auto, or a count below the total limit)",
              read().thinkingBudget ? String(read().thinkingBudget) : "auto",
            )
          : undefined);
      if (value === undefined) {
        if (!ctx.hasUI) throw Error("Usage: /thinking-budget auto|8192");
        return;
      }
      await update({ thinkingBudget: tokenValue(value, true) }, ctx);
    };
    const save = (ctx) => {
      idle(ctx);
      // Merge only generation controls into fresh defaults; preserve another terminal's connection and model settings.
      saveConfig({ ...loadConfig(home), ...pick(read()) }, home);
      inform(
        ctx,
        "Generation defaults saved for future launches.\n" +
          generationSummary(read()),
      );
    };
    register(
      "profile",
      "Generation profile: fast (32K), balanced (64K), extended (131K)",
      ["fast", "balanced", "extended"],
      selectProfile,
    );
    register(
      "tokens",
      "Set the total output limit, including thinking",
      ["32768", "65536", "131072"],
      selectTokens,
    );
    // Pi already owns /thinking. Keep it available, with /think as the Strata xhigh/on/off control.
    register(
      "think",
      "Set Strata thinking: off, low, medium or xhigh",
      ["off", "on", "low", "medium", "xhigh"],
      selectThinking,
    );
    register(
      "thinking-budget",
      "Set a thinking-token ceiling, or auto",
      ["auto", "4096", "8192", "16384"],
      selectBudget,
    );
    register(
      "limits",
      "Generation settings menu; show, save or reset defaults",
      ["show", "save", "reset"],
      async (args, ctx) => {
        if (args === "show") return inform(ctx, generationSummary(read()));
        if (args === "save") return save(ctx);
        if (args === "reset") return update(pick(loadConfig(home)), ctx);
        if (args) throw Error("Usage: /limits [show|save|reset]");
        idle(ctx);
        const c = read();
        const budget = c.thinkingBudget
          ? number(c.thinkingBudget)
          : "automatic";
        // Values stay as the plain labels used by non-interactive hosts; the menu shows label + detail.
        const items = [
          ["Choose profile", "Profile", currentProfile(c) ?? "custom"],
          [
            `Total output: ${number(c.maxTokens)}`,
            "Total output",
            `${number(c.maxTokens)} tokens · thinking + answer`,
          ],
          [
            `Thinking: ${c.thinking ? c.reasoningEffort : "off"}`,
            "Thinking",
            c.thinking ? c.reasoningEffort : "off",
          ],
          [
            `Thinking budget: ${budget}`,
            "Thinking budget",
            budget + (c.thinking ? "" : " · unused while off"),
          ],
          ["Show current settings", "Show summary", "print every setting"],
          ["Save as defaults", "Save as defaults", "keep for future launches"],
          [
            "Restore saved defaults",
            "Restore defaults",
            "undo session changes",
          ],
        ].map(([value, label, description]) => ({ value, label, description }));
        const actions = items.map((item) => item.value);
        const selected = await choose(
          ctx,
          "Generation settings",
          items,
          "Changes apply now; save to keep them for future launches.",
        );
        if (selected === undefined) return;
        switch (actions.indexOf(selected)) {
          case 0:
            return selectProfile("", ctx);
          case 1:
            return selectTokens("", ctx);
          case 2:
            return selectThinking("", ctx);
          case 3:
            return selectBudget("", ctx);
          case 4:
            return inform(ctx, generationSummary(read()));
          case 5:
            return save(ctx);
          case 6:
            return update(pick(loadConfig(home)), ctx);
        }
      },
    );
    pi.on("session_start", (_event, ctx) => status(ctx));
    pi.on("thinking_level_select", (_event, ctx) => status(ctx));
  };
}
