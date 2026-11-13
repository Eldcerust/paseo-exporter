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
  output: z.object({ path: z.string(), entryCount: z.number(), archivedAt: z.string(), workspace: archivedWorkspace }),
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
// Paseo's plugin API can archive a workspace but has no call to bring one back, and unarchiving
// a chat does not restore its workspace. `workspaceArchived` tells the screen to say so, because
// a chat inside an archived workspace has no row in the sidebar until the workspace is restored.
export const restoreArchive = defineRpc({
  name: "archive.restore", input: agentInput,
  output: z.object({ agentId: z.string(), workspaceArchived: z.boolean() }),
});
