import type { PluginServerContext } from "@getpaseo/plugin/server";
import { exportSession, saveExport } from "./shared/export";
import { preferences, readPreferences } from "./shared/preferences";
import { createExport, saveSession } from "./server/export";
import { createArchiveService } from "./server/archive";
import { archiveSession, listArchives, restoreArchive } from "./shared/archive";
import { createArchiveFiles } from "./server/archive-files";
import { listArchiveFiles, inspectArchiveFile, importArchiveFile } from "./shared/archive-files";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  server.handle(exportSession, createExport);
  const read = async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(state.error);
    return state.values;
  };
  server.handle(readPreferences, read);
  const files = createArchiveFiles(read);
  server.handle(saveExport, async (input, context) => {
    const saved = await saveSession(input, context);
    try { await files.remember(saved.path, context); }
    catch (error) { throw new Error(`Export saved to ${saved.path}, but catalog registration failed: ${String(error)}. You can still import it by its file path.`); }
    return saved;
  });
  server.handle(listArchiveFiles, files.list);
  server.handle(inspectArchiveFile, files.inspect);
  server.handle(importArchiveFile, files.import);
  const archive = createArchiveService(read, files.remember);
  server.handle(archiveSession, archive.archive);
  server.handle(listArchives, archive.list);
  server.handle(restoreArchive, archive.restore);
  return () => {};
}
