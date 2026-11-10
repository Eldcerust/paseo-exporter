import type { PluginServerContext } from "@getpaseo/plugin/server";
import { exportSession, saveExport } from "./shared/export";
import { preferences, readPreferences } from "./shared/preferences";
import { createExport, saveSession } from "./server/export";
import { createArchiveService } from "./server/archive";
import { archiveSession, listArchives, restoreArchive } from "./shared/archive";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  server.handle(exportSession, createExport);
  server.handle(saveExport, saveSession);
  const read = async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(state.error);
    return state.values;
  };
  server.handle(readPreferences, read);
  const archive = createArchiveService(read);
  server.handle(archiveSession, archive.archive);
  server.handle(listArchives, archive.list);
  server.handle(restoreArchive, archive.restore);
  return () => {};
}
