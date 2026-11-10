import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { resolveDefaults, type Preferences } from "../shared/preferences";
import type { ArchivedConversation } from "../shared/archive";
import { saveSession } from "./export";

type Context = PluginHandlerContext;
type Agent = NonNullable<Awaited<ReturnType<ReturnType<Context["paseo"]["agents"]["ref"]>["refresh"]>>>["agent"];

function requireInactive(agent: Agent) {
  if (agent.status === "running" || agent.status === "initializing" || agent.activeTurn) {
    throw new Error("Wait for this chat to finish or stop its turn before archiving. No chat was archived.");
  }
}

export function createArchiveService(readPreferences: () => Promise<Preferences>) {
  // One operation per agent across clients. Release even when export or provider resume fails.
  const pending = new Set<string>();
  async function exclusive<T>(agentId: string, operation: () => Promise<T>) {
    if (pending.has(agentId)) throw new Error("An archive or restore is already in progress for this chat.");
    pending.add(agentId);
    try { return await operation(); } finally { pending.delete(agentId); }
  }
  return {
    archive: ({ agentId }: { agentId: string }, context: Context) => exclusive(agentId, async () => {
      const handle = context.paseo.agents.ref(agentId);
      const snapshot = await handle.refresh();
      if (!snapshot?.agent) throw new Error("Chat was not found on this host.");
      if (snapshot.agent.archivedAt) throw new Error("This chat is already archived. Open Archived chats in the sidebar to restore it.");
      requireInactive(snapshot.agent);
      const defaults = resolveDefaults(await readPreferences(), snapshot.agent.workspaceId ?? "");
      if (defaults.destination === "clipboard") {
        throw new Error("Archive needs a saved file. Choose a folder in Export and save it as a workspace or host default first. The chat is still active.");
      }
      const saved = await saveSession({ agentId, ...defaults, destination: defaults.destination }, context);
      try {
        const latest = await handle.refresh();
        if (!latest?.agent) throw new Error("Chat is no longer available.");
        requireInactive(latest.agent);
        // Another client may have used Paseo's built-in Archive while the export was saving.
        const archived = latest.agent.archivedAt ? { archivedAt: latest.agent.archivedAt } : await handle.archive();
        return { ...saved, archivedAt: archived.archivedAt };
      } catch (error) {
        throw new Error(`Export saved to ${saved.path}, but archiving did not complete: ${error instanceof Error ? error.message : String(error)} Check the chat's current state before retrying.`);
      }
    }),
    async list(_input: Record<string, never>, { paseo }: Context) {
      const entries = new Map<string, ArchivedConversation>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        // No active-workspace scope: include archived chats whose workspace is also archived.
        const page = await paseo.agents.list({
          filter: { includeArchived: true, includeBackground: true },
          sort: [{ key: "created_at", direction: "desc" }],
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        for (const { agent } of page.entries) {
          if (!agent.archivedAt) continue;
          entries.set(agent.id, {
            id: agent.id, title: agent.title ?? null, provider: agent.provider, model: agent.model ?? null,
            cwd: agent.cwd, workspaceId: agent.workspaceId ?? null, archivedAt: agent.archivedAt,
          });
        }
        if (!page.pageInfo.hasMore) break;
        const next = page.pageInfo.nextCursor;
        if (!next || cursors.has(next)) throw new Error("The archive list changed while loading. Refresh to try again.");
        cursors.add(next);
        cursor = next;
      }
      return { entries: [...entries.values()].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)) };
    },
    restore: ({ agentId }: { agentId: string }, { paseo }: Context) => exclusive(agentId, async () => {
      const handle = paseo.agents.ref(agentId);
      const snapshot = await handle.refresh();
      if (!snapshot?.agent) throw new Error("This chat no longer exists on this host. Export files cannot be imported as live Paseo sessions.");
      if (snapshot.agent.archivedAt) {
        // reload invokes refresh_agent_request, which restores the owning workspace and unarchives.
        const restored = await handle.reload();
        if (!restored?.agent || restored.agent.archivedAt) throw new Error("Paseo did not restore this chat. Refresh the archive list and try again.");
      }
      // Do not reload an already-restored chat: that would interrupt a newly running turn.
      return { agentId };
    }),
  };
}
