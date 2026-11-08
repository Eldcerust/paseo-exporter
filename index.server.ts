import type { PluginServerContext } from "@getpaseo/plugin/server";
import { exportSession, saveExport } from "./shared/export";
import { preferences, readPreferences } from "./shared/preferences";
import { createExport, saveSession } from "./server/export";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  server.handle(exportSession, createExport);
  server.handle(saveExport, saveSession);
  server.handle(readPreferences, async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(state.error);
    return state.values;
  });
  return () => {};
}
