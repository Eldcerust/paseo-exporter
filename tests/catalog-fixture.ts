// A provider snapshot in the compact wire form the daemon really sends: `entries` is empty and the catalog is
// in `compactSnapshot`, with each model pointing into a shared table of effort sets. Shaped like a host where
// Claude and Pi are enabled and OpenCode is switched off.
export function compactSnapshot(overrides: { claudeStatus?: string; piStatus?: string } = {}) {
  return {
    requestId: "r", entries: [],
    compactSnapshot: {
      entries: [
        { provider: "claude", label: "Claude", enabled: true, status: overrides.claudeStatus ?? "ready", models: [
          { id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true, defaultThinkingOptionId: "medium", thinkingSet: 0 },
          { id: "claude-sonnet-5-5", label: "Sonnet 5.5", defaultThinkingOptionId: "medium", thinkingSet: 0 },
          { id: "claude-hidden", label: "Hidden model", isSelectable: false },
        ] },
        { provider: "pi", label: "Pi", enabled: true, status: overrides.piStatus ?? "ready", models: [
          { id: "deepseek/deepseek-flash", label: "DeepSeek V4.1 Flash", defaultThinkingOptionId: "high" },
          { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", isDefault: true },
        ] },
        { provider: "opencode", label: "OpenCode", enabled: false, status: "unavailable", models: [] },
        { provider: "codex", label: "Codex", enabled: true, status: "unavailable", models: [] },
      ],
      thinkingSets: [{ options: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }], defaultOptionId: "medium" }],
    },
  };
}
