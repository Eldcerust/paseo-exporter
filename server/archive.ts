import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { resolveDefaults, type Preferences } from "../shared/preferences";
import type { ArchivedConversation, ArchivedWorkspace } from "../shared/archive";
import { saveSession } from "./export";

type Context = PluginHandlerContext;
type Agent = NonNullable<Awaited<ReturnType<ReturnType<Context["paseo"]["agents"]["ref"]>["refresh"]>>>["agent"];

function requireInactive(agent: Agent) {
  if (agent.status === "running" || agent.status === "initializing" || agent.activeTurn) {
    throw new Error("Wait for this chat to finish or stop its turn before archiving. No chat was archived.");
  }
}

// Only plain folders are archived with the chat. Paseo deletes the folder behind a worktree
// workspace and runs its teardown commands, which a chat archive must never cause.
const CLOSABLE_WORKSPACE_KINDS = new Set(["local_checkout", "directory"]);

// Counts unarchived chats other than `agentId` that live in `workspaceId`, including closed and
// background ones, because each of them is a row the user can still see. The daemon cannot filter
// by workspace, so this walks every page.
async function countOtherChats(agentId: string, workspaceId: string, { paseo }: Context) {
  let count = 0;
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await paseo.agents.list({
      filter: { includeBackground: true },
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of page.entries) {
      if (agent.id !== agentId && !agent.archivedAt && agent.workspaceId === workspaceId) count++;
    }
    if (!page.pageInfo.hasMore) return count;
    const next = page.pageInfo.nextCursor;
    if (!next || cursors.has(next)) throw new Error("The chat list changed while checking the workspace. Refresh to try again.");
    cursors.add(next);
    cursor = next;
  }
}

// Closes the archived chat's own workspace so it leaves the sidebar. Paseo's workspace archive
// also archives every chat in it and kills its terminals, so it runs only when this chat was the
// last one there. Returns why the workspace was left alone instead of throwing for those cases.
async function archiveOwnWorkspace(agentId: string, workspaceId: string | null | undefined, context: Context): Promise<ArchivedWorkspace> {
  const left = (id: string | null, name: string | null, note: string): ArchivedWorkspace => ({ id, name, archived: false, note });
  if (!workspaceId) return left(null, null, "This chat has no workspace to archive.");
  const handle = context.paseo.workspaces.ref(workspaceId);
  const workspace = await handle.refresh();
  if (!workspace) return left(workspaceId, null, "Its workspace was already archived or is not on this host.");
  const name = workspace.title || workspace.name || workspaceId;
  if (!CLOSABLE_WORKSPACE_KINDS.has(workspace.workspaceKind)) {
    return left(workspaceId, name, workspace.workspaceKind === "worktree"
      ? "This chat runs in a Git worktree workspace. Archiving that workspace deletes the worktree folder, so it was left in place. Archive it from the sidebar if you want that."
      : `Its workspace is a "${workspace.workspaceKind}" workspace, which this plugin does not archive. Archive it from the sidebar if you want that.`);
  }
  const others = await countOtherChats(agentId, workspaceId, context);
  if (others > 0) {
    return left(workspaceId, name, `${others} other chat${others === 1 ? " is" : "s are"} still active in this workspace, so it was kept. Archive the workspace from the sidebar to close them too.`);
  }
  const result = await handle.archive();
  if (result.error || !result.archivedAt) throw new Error(result.error || "Paseo did not archive the workspace.");
  return { id: workspaceId, name, archived: true, note: null };
}

export function createArchiveService(readPreferences: () => Promise<Preferences>, rememberExport?: (path: string, context: Context) => Promise<void>) {
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
      let archivedAt: string;
      let workspaceId: string | null | undefined;
      try {
        await rememberExport?.(saved.path, context);
        const latest = await handle.refresh();
        if (!latest?.agent) throw new Error("Chat is no longer available.");
        requireInactive(latest.agent);
        // Another client may have used Paseo's built-in Archive while the export was saving.
        const archived = latest.agent.archivedAt ? { archivedAt: latest.agent.archivedAt } : await handle.archive();
        archivedAt = archived.archivedAt;
        workspaceId = latest.agent.workspaceId ?? snapshot.agent.workspaceId;
      } catch (error) {
        throw new Error(`Export saved to ${saved.path}, but archiving did not complete: ${error instanceof Error ? error.message : String(error)} Check the chat's current state before retrying.`);
      }
      // The chat is archived from here on, so a workspace failure must not read as "chat still active".
      try {
        return { ...saved, archivedAt, workspace: await archiveOwnWorkspace(agentId, workspaceId, context) };
      } catch (error) {
        throw new Error(`Export saved to ${saved.path} and the chat is archived, but its workspace was not archived: ${error instanceof Error ? error.message : String(error)} Archive that workspace from the sidebar.`);
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
      if (!snapshot?.agent) throw new Error("This native chat no longer exists. Use Saved export files to import its Markdown/JSON into a new context chat.");
      if (snapshot.agent.archivedAt) {
        // reload invokes refresh_agent_request, which unarchives the chat. It restores the owning
        // workspace only for app versions before 0.1.105, which this client is not.
        const restored = await handle.reload();
        if (!restored?.agent || restored.agent.archivedAt) throw new Error("Paseo did not restore this chat. Refresh the archive list and try again.");
      }
      // Do not reload an already-restored chat: that would interrupt a newly running turn.
      // The reload above does not restore an archived workspace, so report it instead of hiding it.
      const workspaceId = snapshot.agent.workspaceId;
      const workspaceArchived = workspaceId ? (await paseo.workspaces.ref(workspaceId).refresh()) === null : false;
      return { agentId, workspaceArchived };
    }),
  };
}
