import type { PluginHandlerContext } from "@getpaseo/plugin/server";

export function cleanTitle(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() || null;
}

/**
 * The name a chat's project row currently has in the sidebar. Paseo gives each chat its own workspace
 * row, and a title plugin keeps that row's name current, while the chat's own `title` stays the first
 * prompt. The workspace is archived together with the chat, after which the daemon no longer returns
 * its title, so this has to be read while the workspace is still live, before the export is saved.
 * It returns null for a chat without a workspace, an archived workspace, or one without a title.
 */
export async function readProjectTitle(workspaceId: string | null | undefined, { paseo }: Pick<PluginHandlerContext, "paseo">) {
  if (!workspaceId) return null;
  try { return cleanTitle((await paseo.workspaces.ref(workspaceId).refresh())?.title); }
  catch { return null; }
}
