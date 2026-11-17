import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { exportFormat } from "./export";
import { providerChoice } from "./models";

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
// Text search over the saved files. `available: false` means this host has no search index (the
// runtime lacks node:sqlite), so the screen falls back to matching titles, paths, and providers.
// A hit's snippet marks each matched word with the characters in shared/search.ts.
export const searchArchiveFiles = defineRpc({
  name: "archive.files.search", input: z.object({ query: z.string().max(200) }),
  output: z.object({
    available: z.boolean(), reason: z.string().nullable(),
    hits: z.array(z.object({ path: z.string(), snippet: z.string(), rank: z.number() })),
  }),
});
export const inspectArchiveFile = defineRpc({
  name: "archive.files.inspect", input: fileInput,
  output: z.object({ file: archiveFile, content: z.string() }),
});
// The providers and models the host offers for a folder, for the restore picker. `discovering` means the
// host is still scanning providers for that folder, so the list is not complete yet and the screen asks again.
export const listArchiveModels = defineRpc({
  name: "archive.files.models", input: z.object({ cwd: z.string().trim().min(1).max(4096) }),
  output: z.object({ discovering: z.boolean(), providers: z.array(providerChoice) }),
});
// `model` is the model id from the picker. Without it `provider` may be the combined `provider/model` text
// an export records, which is used as given and not checked.
export const importArchiveFile = defineRpc({
  name: "archive.files.import", input: fileInput.extend({
    provider: z.string().trim().min(1).max(512), model: z.string().trim().min(1).max(512).optional(), thinkingOptionId: z.string().trim().min(1).max(200).optional(),
    cwd: z.string().trim().min(1).max(4096), requestId: z.string().trim().min(1).max(200).optional(),
  }),
  output: z.object({ agentId: z.string(), mode: z.literal("context"), path: z.string(), warning: z.string().optional() }),
});
