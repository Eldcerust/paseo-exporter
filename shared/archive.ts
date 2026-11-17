import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const agentInput = z.object({ agentId: z.string().min(1) });
// Paseo gives each chat its own workspace row in the sidebar. Archiving the chat alone leaves
// that row behind, so archive also closes the workspace unless something else still lives in it.
// `archived: false` is a deliberate outcome, and `note` says why the workspace was left in place.
export const archivedWorkspace = z.object({
  id: z.string().nullable(), name: z.string().nullable(), archived: z.boolean(), note: z.string().nullable(),
});
export type ArchivedWorkspace = z.infer<typeof archivedWorkspace>;
// One sentence for the toast and the receipt. A kept workspace explains itself through `note`.
export function workspaceSummary(workspace: ArchivedWorkspace) {
  return workspace.archived ? `Workspace “${workspace.name ?? workspace.id}” archived.` : workspace.note ?? "Workspace left in place.";
}
export const archiveSession = defineRpc({
  name: "session.archive",
  input: agentInput,
  // `title` is the name the export was saved under: the project's current title when it has one.
  output: z.object({ path: z.string(), entryCount: z.number(), title: z.string(), archivedAt: z.string(), workspace: archivedWorkspace }),
});
export const archivedConversation = z.object({
  id: z.string(), title: z.string().nullable(), provider: z.string(), model: z.string().nullable(),
  cwd: z.string(), workspaceId: z.string().nullable(), archivedAt: z.string(),
});
export type ArchivedConversation = z.infer<typeof archivedConversation>;
export const listArchives = defineRpc({
  name: "archive.list", input: z.object({}),
  output: z.object({ entries: z.array(archivedConversation) }),
});
// Text search over the archived chats themselves. The index fills in batches, because reading a
// chat's history costs a round trip per page: `pending` is how many archived chats are not searchable
// yet, and the screen asks again until it reaches 0. An empty query only advances the indexing.
export const searchArchives = defineRpc({
  name: "archive.search", input: z.object({ query: z.string().max(200) }),
  output: z.object({
    available: z.boolean(), reason: z.string().nullable(), pending: z.number(),
    hits: z.array(z.object({ agentId: z.string(), snippet: z.string(), rank: z.number() })),
  }),
});
// Paseo's plugin API can archive a workspace but has no call to bring one back, and unarchiving
// a chat does not restore its workspace. `workspaceArchived` tells the screen to say so, because
// a chat inside an archived workspace has no row in the sidebar until the workspace is restored.
export const restoreArchive = defineRpc({
  name: "archive.restore", input: agentInput,
  output: z.object({ agentId: z.string(), workspaceArchived: z.boolean() }),
});
