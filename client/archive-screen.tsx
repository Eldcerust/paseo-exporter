import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type PluginScreenProps, type PluginSidebarItemProps, useRpc } from "@getpaseo/plugin/client";
import { SidebarRow, TextInput } from "@getpaseo/plugin/client/ui";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listArchives, restoreArchive, searchArchives } from "../shared/archive";
import { searchMatches } from "../shared/search";
import { Snippet, useDebounced } from "./search-results";
import { ArchiveFilesScreen } from "./archive-files-screen";

export function ArchiveSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="ArchiveRestore" label="Archived chats" active={currentScreen?.screenId === "archive"} onPress={() => openScreen({ screenId: "archive" })} />;
}
export function ArchiveScreen(props: PluginScreenProps) {
  // Reset search and pending feedback when the selected host changes.
  return <ArchiveSources key={props.host.id} {...props} />;
}
function ArchiveSources(props: PluginScreenProps) {
  const [source, setSource] = useState<"files" | "native">("files");
  return <View style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12 }}>
      {([["files", "Saved export files"], ["native", "Paseo native archives"]] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: source === value }} onPress={() => setSource(value)}
        style={{ padding: 10, borderRadius: 8, backgroundColor: source === value ? props.theme.colors.accent : props.theme.colors.surface1 }}>
        <Text style={{ color: source === value ? props.theme.colors.accentForeground : props.theme.colors.foreground }}>{label}</Text>
      </Pressable>)}
    </View>
    {source === "files" ? <ArchiveFilesScreen {...props} /> : <NativeArchiveScreen {...props} />}
  </View>;
}
export function NativeArchiveScreen({ theme, host, layout, navigation }: PluginScreenProps) {
  const list = useRpc(listArchives);
  const searchText = useRpc(searchArchives);
  const restore = useRpc(restoreArchive);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const archives = useQuery({ queryKey: ["conversation-archives", host.id], queryFn: () => list({}), refetchInterval: 15000 });
  const restoring = useMutation({
    mutationFn: ({ agentId }: { agentId: string; open: boolean }) => restore({ agentId }),
    onSuccess: async ({ agentId, workspaceArchived }, input) => {
      setNotice(workspaceArchived
        ? "Chat unarchived, but its workspace is still archived, so it has no row in the sidebar. Paseo offers Restore for the workspace when you open the chat from History or with Unarchive and open. Its export file is unchanged."
        : "Chat restored to Paseo. Its export file is unchanged.");
      await archives.refetch();
      if (input.open) navigation?.openAgent({ agentId });
    },
    onError: () => { void archives.refetch(); },
  });
  const colors = theme.colors;
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted, fontSize: 12 };
  const needle = search.trim().toLowerCase();
  const settled = useDebounced(needle);
  // Reading a chat's history costs a round trip per page, so the host indexes archived chats a few at a
  // time. Even with an empty box this call indexes the next batch, and it repeats while chats are pending,
  // so the text of every archived chat becomes searchable shortly after this view opens.
  const found = useQuery({
    queryKey: ["archive-text-search", host.id, settled], queryFn: () => searchText({ query: settled }), staleTime: 5000,
    refetchInterval: (query) => (query.state.data?.pending ? 700 : false),
  });
  // Hits belong to the words they were searched for, so they are ignored while the box has moved on.
  const textHits = found.data && settled === needle ? found.data : undefined;
  const hitFor = new Map((textHits?.hits ?? []).map((hit) => [hit.agentId, hit]));
  const entries = searchMatches(archives.data?.entries ?? [], needle, (entry, word) => [entry.title, entry.id, entry.cwd, entry.provider, entry.model].some((value) => value?.toLowerCase().includes(word)), (entry) => hitFor.get(entry.id));
  return <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}>
    <Text accessibilityRole="header" style={{ ...text, fontSize: 22, fontWeight: "600" }}>Paseo native archives</Text>
    <Text style={text}>This separate list unhides existing Paseo sessions on {host.label}. To import a saved Markdown or JSON file, choose Saved export files above.</Text>
    <View style={{ flexDirection: layout.compact ? "column" : "row", gap: 8 }}>
      <TextInput accessibilityLabel="Search archived chats" value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false}
        placeholder="Search title, conversation text, provider, folder, or ID" placeholderTextColor={colors.foregroundMuted}
        style={{ ...text, flex: layout.compact ? undefined : 1, padding: 12, borderRadius: 8, backgroundColor: colors.surface1 }} />
      <Pressable accessibilityRole="button" disabled={archives.isFetching} onPress={() => void archives.refetch()} style={{ padding: 12, backgroundColor: colors.surface1, borderRadius: 8 }}>
        <Text style={text}>{archives.isFetching ? "Refreshing…" : "Refresh"}</Text>
      </Pressable>
    </View>
    {archives.error && <Text accessibilityRole="alert" selectable style={text}>{archives.error.message}</Text>}
    {restoring.error && <Text accessibilityRole="alert" selectable style={text}>{restoring.error.message}</Text>}
    {!!notice && <Text accessibilityLiveRegion="polite" style={text}>{notice}</Text>}
    {archives.isPending ? <Text style={muted}>Loading archived chats…</Text> : archives.data && <Text style={muted}>{entries.length} of {archives.data.entries.length} archived chats</Text>}
    {textHits && !textHits.available && <Text style={muted}>Text search is unavailable on this host{textHits.reason ? ` (${textHits.reason})` : ""}. Only titles, providers, folders, and IDs are matched.</Text>}
    {!!textHits?.pending && <Text accessibilityLiveRegion="polite" style={muted}>Indexing {textHits.pending} archived chat{textHits.pending === 1 ? "" : "s"} so their text can be searched. Results may be incomplete until this finishes.</Text>}
    {archives.data && !entries.length && <Text style={muted}>{needle ? "No archived chats match your search." : "No archived chats on this host."}</Text>}
    {entries.map((entry) => <View key={entry.id} style={{ padding: 16, borderRadius: 10, backgroundColor: colors.surface1, gap: 8 }}>
      <Text style={{ ...text, fontWeight: "600", fontSize: 16 }}>{entry.title || "Untitled chat"}</Text>
      <Text style={muted}>{entry.provider}{entry.model ? ` · ${entry.model}` : ""} · Archived {new Date(entry.archivedAt).toLocaleString()}</Text>
      <Text selectable style={muted}>{entry.cwd}</Text>
      <Text selectable style={muted}>{entry.id}</Text>
      {hitFor.has(entry.id) && <Snippet text={hitFor.get(entry.id)!.snippet} color={colors.foregroundMuted} highlight={colors.foreground} />}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(navigation ? [false, true] : [false]).map((open) => <Pressable key={String(open)} accessibilityRole="button"
          accessibilityLabel={`${open ? "Unarchive and open" : "Unarchive"} ${entry.title || entry.id}`} disabled={restoring.isPending}
          accessibilityState={{ disabled: restoring.isPending }} onPress={() => { setNotice(""); restoring.mutate({ agentId: entry.id, open }); }}
          style={{ padding: 10, borderRadius: 8, backgroundColor: open ? colors.surface2 : colors.accent, opacity: restoring.isPending ? 0.5 : 1 }}>
          <Text style={{ color: open ? colors.foreground : colors.accentForeground }}>{restoring.isPending && restoring.variables?.agentId === entry.id ? "Unarchiving…" : open ? "Unarchive and open" : "Unarchive"}</Text>
        </Pressable>)}
      </View>
    </View>)}
    <Text style={muted}>Restoring requires the original session and provider persistence to remain on this host. Removed worktrees, missing providers, or deleted provider history can prevent a session from resuming. Restoring a parent does not automatically restore its child chats.</Text>
  </ScrollView>;
}
