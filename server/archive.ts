import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { resolveDefaults, type Preferences } from "../shared/preferences";
import type { ArchivedConversation, ArchivedWorkspace } from "../shared/archive";
import { saveSession } from "./export";
import { fetchHistory } from "./history";
import type { SearchIndex, SearchIndexProvider } from "./search-index";
import { cleanText, conversationText } from "./search-text";
import { cleanTitle, readProjectTitle } from "./title";

type Context = PluginHandlerContext;
type Agent = NonNullable<Awaited<ReturnType<ReturnType<Context["paseo"]["agents"]["ref"]>["refresh"]>>>["agent"];
type ListedAgent = Awaited<ReturnType<Context["paseo"]["agents"]["list"]>>["entries"][number]["agent"];
// Reading a chat's history costs a round trip per page, so one search call indexes archived chats only
// until its time budget runs out, and the screen asks again until none are pending. A few histories
// are read at once because most of the time is spent waiting for the daemon.
const INDEX_BATCH = 40;
const INDEX_BUDGET_MS = 3000;
const INDEX_CONCURRENCY = 4;
const RETRY_FAILED_AFTER_MS = 5 * 60_000;
const HIT_LIMIT = 400;

// Paseo will not serve a chat's history, prompts or commands while its provider is switched off, but it still
// archives that chat. Saving an export reads the history, so that is where an unavailable provider surfaces.
const PROVIDER_UNAVAILABLE = /references unavailable provider/i;
const providerBlocked = (error: unknown) => PROVIDER_UNAVAILABLE.test(error instanceof Error ? error.message : String(error));
const blockedReason = (provider: string) => `This chat uses the ${provider} provider, which is not enabled or not ready on this host, so Paseo cannot read its history and no export can be saved.`;

// Whether the history can be read, which a saved export needs. `skippable` is true only when the provider is the blocker.
async function exportBlocker(handle: ReturnType<Context["paseo"]["agents"]["ref"]>, agent: Agent): Promise<{ skippable: boolean; reason: string } | null> {
  try {
    const page = await handle.timeline.refetch({ direction: "tail", limit: 1, projection: "projected" });
    if (!page.error) return null;
    return providerBlocked(page.error) ? { skippable: true, reason: blockedReason(agent.provider) } : { skippable: false, reason: `Paseo could not read this chat's history: ${page.error}` };
  } catch (error) {
    return providerBlocked(error) ? { skippable: true, reason: blockedReason(agent.provider) }
      : { skippable: false, reason: `Paseo could not read this chat's history: ${error instanceof Error ? error.message : String(error)}` };
  }
}

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

// Every archived chat on the host, including those whose workspace is also archived. Walks all pages
// and fails rather than returning a truncated or looping list.
async function listArchivedAgents({ paseo }: Context) {
  const entries = new Map<string, ListedAgent>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    // No active-workspace scope: include archived chats whose workspace is also archived.
    const page = await paseo.agents.list({
      filter: { includeArchived: true, includeBackground: true },
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of page.entries) if (agent.archivedAt) entries.set(agent.id, agent);
    if (!page.pageInfo.hasMore) return [...entries.values()];
    const next = page.pageInfo.nextCursor;
    if (!next || cursors.has(next)) throw new Error("The archive list changed while loading. Refresh to try again.");
    cursors.add(next);
    cursor = next;
  }
}

async function indexChat(agent: ListedAgent, index: SearchIndex, context: Context) {
  const { agent: current, entries } = await fetchHistory(context.paseo.agents.ref(agent.id).timeline);
  // The project title while its workspace still exists, otherwise the chat's own title.
  const title = (await readProjectTitle(current.workspaceId ?? agent.workspaceId, context)) ?? cleanTitle(current.title) ?? cleanTitle(agent.title) ?? "";
  const archivedAt = agent.archivedAt ?? "";
  index.put({
    kind: "chat", key: agent.id, agentId: agent.id, title: cleanText(title),
    meta: cleanText([agent.provider, agent.model ?? "", agent.cwd, agent.id].join("\n")),
    body: conversationText(entries.map(({ item }) => item)),
    stamp: archivedAt, sortKey: archivedAt, payload: "",
  });
}

export function createArchiveService(
  readPreferences: () => Promise<Preferences>, rememberExport?: (path: string, context: Context) => Promise<void>, searchIndex?: SearchIndexProvider,
  { indexBatch = INDEX_BATCH, indexBudgetMs = INDEX_BUDGET_MS, indexConcurrency = INDEX_CONCURRENCY }: { indexBatch?: number; indexBudgetMs?: number; indexConcurrency?: number } = {},
) {
  // One operation per agent across clients. Release even when export or provider resume fails.
  const pending = new Set<string>();
  // Chats whose history could not be read are retried later, not on every search, so one broken chat cannot starve the rest.
  const failedAt = new Map<string, number>();
  let indexing: Promise<void> | undefined;
  const withIndex = <T>(context: Context, work: (index: SearchIndex | null) => Promise<T>) => searchIndex ? searchIndex.use(context, work) : work(null);
  async function exclusive<T>(agentId: string, operation: () => Promise<T>) {
    if (pending.has(agentId)) throw new Error("An archive or restore is already in progress for this chat.");
    pending.add(agentId);
    try { return await operation(); } finally { pending.delete(agentId); }
  }
  return {
    async check({ agentId }: { agentId: string }, context: Context) {
      const handle = context.paseo.agents.ref(agentId);
      const snapshot = await handle.refresh();
      if (!snapshot?.agent) throw new Error("Chat was not found on this host.");
      const blocker = await exportBlocker(handle, snapshot.agent);
      return { canExport: !blocker, skippable: blocker?.skippable ?? false, reason: blocker?.reason ?? null };
    },
    archive: ({ agentId, skipExport = false }: { agentId: string; skipExport?: boolean }, context: Context) => exclusive(agentId, async () => {
      const handle = context.paseo.agents.ref(agentId);
      const snapshot = await handle.refresh();
      if (!snapshot?.agent) throw new Error("Chat was not found on this host.");
      if (snapshot.agent.archivedAt) throw new Error("This chat is already archived. Open Archived chats in the sidebar to restore it.");
      requireInactive(snapshot.agent);
      let saved: Awaited<ReturnType<typeof saveSession>> | null = null;
      if (skipExport) {
        // Only for a chat whose history cannot be read because of its provider. Anything readable is exported first.
        const blocker = await exportBlocker(handle, snapshot.agent);
        if (!blocker) throw new Error("This chat's history can be read, so it was not archived without an export. Use Save export and archive.");
        if (!blocker.skippable) throw new Error(`${blocker.reason} The chat was not archived.`);
      } else {
        const defaults = resolveDefaults(await readPreferences(), snapshot.agent.workspaceId ?? "");
        if (defaults.destination === "clipboard") {
          throw new Error("Archive needs a saved file. Choose a folder in Export and save it as a workspace or host default first. The chat is still active.");
        }
        try { saved = await saveSession({ agentId, ...defaults, destination: defaults.destination }, context); }
        catch (error) {
          if (providerBlocked(error)) throw new Error(`${blockedReason(snapshot.agent.provider)} The chat is still active. You can archive it without saving an export instead.`);
          throw error;
        }
      }
      const kept = saved ? `Export saved to ${saved.path}` : "No export was saved";
      let archivedAt: string;
      let workspaceId: string | null | undefined;
      try {
        if (saved) await rememberExport?.(saved.path, context);
        const latest = await handle.refresh();
        if (!latest?.agent) throw new Error("Chat is no longer available.");
        requireInactive(latest.agent);
        // Another client may have used Paseo's built-in Archive while the export was saving.
        const archived = latest.agent.archivedAt ? { archivedAt: latest.agent.archivedAt } : await handle.archive();
        archivedAt = archived.archivedAt;
        workspaceId = latest.agent.workspaceId ?? snapshot.agent.workspaceId;
      } catch (error) {
        throw new Error(`${kept}, but archiving did not complete: ${error instanceof Error ? error.message : String(error)} Check the chat's current state before retrying.`);
      }
      // Read while the workspace still exists: archiving it below takes its title away.
      const title = saved?.title ?? (await readProjectTitle(workspaceId, context)) ?? cleanTitle(snapshot.agent.title) ?? "Paseo conversation";
      // The chat is archived from here on, so a workspace failure must not read as "chat still active".
      try {
        return { path: saved?.path ?? null, entryCount: saved?.entryCount ?? null, title, archivedAt, workspace: await archiveOwnWorkspace(agentId, workspaceId, context) };
      } catch (error) {
        throw new Error(`${kept} and the chat is archived, but its workspace was not archived: ${error instanceof Error ? error.message : String(error)} Archive that workspace from the sidebar.`);
      }
    }),
    async list(_input: Record<string, never>, context: Context) {
      const archived = await listArchivedAgents(context);
      // A chat's own title is usually still its first prompt. Its saved export carries the project title.
      const titles = await withIndex(context, async (index) => new Map(archived.flatMap((agent) => {
        try { const title = index?.titleFor(agent.id); return title ? [[agent.id, title] as const] : []; } catch { return []; }
      })));
      const entries = archived.map((agent): ArchivedConversation => ({
        id: agent.id, title: titles.get(agent.id) ?? agent.title ?? null, provider: agent.provider, model: agent.model ?? null,
        cwd: agent.cwd, workspaceId: agent.workspaceId ?? null, archivedAt: agent.archivedAt!,
      }));
      return { entries: entries.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)) };
    },
    search: ({ query }: { query: string }, context: Context) => withIndex(context, async (index) => {
      if (!index) return { available: false, reason: searchIndex?.reason() ?? "Text search is not available on this host.", pending: 0, hits: [] };
      const archived = await listArchivedAgents(context);
      const ids = new Set(archived.map((agent) => agent.id));
      // A chat that was restored or removed no longer belongs in the index.
      for (const key of index.keys("chat")) if (!ids.has(key)) index.remove("chat", key);
      const todo = () => archived.filter((agent) => index.stamp("chat", agent.id) !== agent.archivedAt && Date.now() - (failedAt.get(agent.id) ?? 0) > RETRY_FAILED_AFTER_MS);
      if (todo().length) {
        indexing ??= (async () => {
          const started = Date.now();
          const batch = todo().slice(0, indexBatch);
          let next = 0;
          const worker = async () => {
            while (next < batch.length) {
              const agent = batch[next++];
              // Always make progress, even when a single chat is slower than the whole budget.
              if (next > 1 && Date.now() - started >= indexBudgetMs) return;
              try { await indexChat(agent, index, context); failedAt.delete(agent.id); }
              catch { failedAt.set(agent.id, Date.now()); }
            }
          };
          await Promise.all(Array.from({ length: Math.min(indexConcurrency, batch.length) }, worker));
        })().finally(() => { indexing = undefined; });
        await indexing;
      }
      return {
        available: true, reason: null, pending: todo().length,
        hits: index.search(query, "chat", HIT_LIMIT).filter((hit) => ids.has(hit.key)).map((hit) => ({ agentId: hit.key, snippet: hit.snippet, rank: hit.rank })),
      };
    }),
    restore: ({ agentId }: { agentId: string }, { paseo }: Context) => exclusive(agentId, async () => {
      const handle = paseo.agents.ref(agentId);
      const snapshot = await handle.refresh();
      if (!snapshot?.agent) throw new Error("This native chat no longer exists. Use Saved export files to import its Markdown/JSON into a new context chat.");
      if (snapshot.agent.archivedAt) {
        // reload invokes refresh_agent_request, which unarchives the chat. It restores the owning
        // workspace only for app versions before 0.1.105, which this client is not.
        let restored: Awaited<ReturnType<typeof handle.reload>>;
        try { restored = await handle.reload(); }
        catch (error) {
          if (providerBlocked(error)) throw new Error(`This chat uses the ${snapshot.agent.provider} provider, which is not enabled or not ready on this host, so Paseo cannot restore it. Enable that provider and try again, or open Saved export files to restore its export into a new chat.`);
          throw error;
        }
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
