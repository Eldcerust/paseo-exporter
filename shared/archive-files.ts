import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { exportFormat } from "./export";

export const archiveFile = z.object({
  path: z.string(), title: z.string(), format: exportFormat, provider: z.string(), cwd: z.string(),
  sourceAgentId: z.string(), exportedAt: z.string(), entryCount: z.number(), bytes: z.number(),
});
export type ArchiveFile = z.infer<typeof archiveFile>;
export const archiveImportReceipt = archiveFile.pick({ path: true, title: true, format: true, entryCount: true });
const fileInput = z.object({ path: z.string().trim().min(1).max(4096) });
export const listArchiveFiles = defineRpc({
  name: "archive.files.list", input: z.object({ directory: z.string().trim().max(4096).optional() }),
  output: z.object({ entries: z.array(archiveFile), warnings: z.array(z.string()) }),
});
export const inspectArchiveFile = defineRpc({
  name: "archive.files.inspect", input: fileInput,
  output: z.object({ file: archiveFile, content: z.string() }),
});
export const importArchiveFile = defineRpc({
  name: "archive.files.import", input: fileInput.extend({ provider: z.string().trim().min(1).max(512), cwd: z.string().trim().min(1).max(4096), requestId: z.string().trim().min(1).max(200).optional() }),
  output: z.object({ agentId: z.string(), mode: z.literal("context"), path: z.string(), warning: z.string().optional() }),
});
