import { loadConfig, saveConfig, validateConfig } from "./config.js";
import { profile } from "./generation.js";

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
    `Total output: ${number(config.maxTokens)} tokens (thinking + answer)`,
    `Thinking: ${config.thinking ? config.reasoningEffort : "off"}`,
    `Thinking budget: ${config.thinkingBudget ? number(config.thinkingBudget) : "automatic"}${config.thinking ? "" : " (unused while thinking is off)"}`,
    `Sampling: temperature ${config.temperature}, top-p ${config.topP}, top-k ${config.topK}`,
    "Changes apply now to this CLI session. /limits save keeps them for future launches.",
  ].join("\n");
}
export function generationCommands({ home, read, apply }) {
  return (pi) => {
    const status = (ctx) => {
      const c = read();
      if (ctx.hasUI)
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
    const choose = async (ctx, title, values) => {
      if (!ctx.hasUI)
        throw Error(
          "Provide a value, or open interactive chat to use the settings menu.",
        );
      return ctx.ui.select(title, values);
    };
    const selectProfile = async (args, ctx) => {
      idle(ctx);
      const value =
        args ||
        (await choose(ctx, "Generation profile", [
          "fast",
          "balanced",
          "extended",
        ]));
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
        (await choose(ctx, "Thinking effort", [
          "off",
          "low",
          "medium",
          "xhigh",
        ]));
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
        const actions = [
          "Choose profile",
          `Total output: ${number(c.maxTokens)}`,
          `Thinking: ${c.thinking ? c.reasoningEffort : "off"}`,
          `Thinking budget: ${c.thinkingBudget ? number(c.thinkingBudget) : "automatic"}`,
          "Show current settings",
          "Save as defaults",
          "Restore saved defaults",
        ];
        const selected = await choose(
          ctx,
          "HermesDesk generation settings",
          actions,
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
