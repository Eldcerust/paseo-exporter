import type { HistoryPage } from "./history";

/**
 * Export only relevant settings, preferring effective/runtime values over configuration.
 * `title` is the project title when there is one, because the chat's own title is usually still its
 * first prompt. The chat title is kept next to it so nothing is lost.
 */
export function sessionMetadata(agent: NonNullable<HistoryPage["agent"]>, projectTitle: string | null = null) {
  const renamed = !!projectTitle && projectTitle !== agent.title;
  return {
    id: agent.id,
    title: projectTitle ?? agent.title,
    ...(renamed ? { projectTitle, chatTitle: agent.title ?? null } : {}),
    provider: agent.runtimeInfo?.provider ?? agent.provider,
    model: agent.runtimeInfo?.model ?? agent.model,
    reasoningEffort: agent.effectiveThinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? agent.thinkingOptionId ?? null,
    configuredProvider: agent.provider,
    configuredModel: agent.model,
    thinkingOptionId: agent.thinkingOptionId ?? null,
    effectiveThinkingOptionId: agent.effectiveThinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    cwd: agent.cwd,
    createdAt: agent.createdAt,
    status: agent.status,
  };
}
