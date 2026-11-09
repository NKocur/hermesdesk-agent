export const PROFILES = Object.freeze({
  fast: {
    maxTokens: 32768,
    thinking: false,
    reasoningEffort: "xhigh",
    thinkingBudget: 0,
    temperature: 0.7,
    topP: 0.8,
    topK: 20,
  },
  balanced: {
    maxTokens: 65536,
    thinking: true,
    reasoningEffort: "xhigh",
    thinkingBudget: 0,
    temperature: 1,
    topP: 0.95,
    topK: 20,
  },
  extended: {
    maxTokens: 131072,
    thinking: true,
    reasoningEffort: "xhigh",
    thinkingBudget: 0,
    temperature: 1,
    topP: 0.95,
    topK: 20,
  },
});
export function profile(name) {
  if (!Object.hasOwn(PROFILES, name))
    throw Error("Choose profile fast, balanced or extended.");
  return PROFILES[name];
}
export function generationPayload(config) {
  return {
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    top_p: config.topP,
    top_k: config.topK,
    reasoning_effort: config.thinking ? config.reasoningEffort : "none",
    reasoning_budget_tokens: config.thinking ? config.thinkingBudget : 0,
    min_p: 0,
    presence_penalty: config.thinking ? 0 : 1.5,
    repetition_penalty: 1,
    chat_template_kwargs: { enable_thinking: config.thinking },
  };
}
