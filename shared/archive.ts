import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const agentInput = z.object({ agentId: z.string().min(1) });
export const archiveSession = defineRpc({
  name: "session.archive",
  input: agentInput,
  output: z.object({ path: z.string(), entryCount: z.number(), archivedAt: z.string() }),
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
export const restoreArchive = defineRpc({
  name: "archive.restore", input: agentInput,
  output: z.object({ agentId: z.string() }),
});
