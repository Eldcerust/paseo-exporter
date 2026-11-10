import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type PluginScreenProps, type PluginSidebarItemProps, useRpc } from "@getpaseo/plugin/client";
import { SidebarRow, TextInput } from "@getpaseo/plugin/client/ui";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listArchives, restoreArchive } from "../shared/archive";

export function ArchiveSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Archive" active={currentScreen?.screenId === "archive"} onPress={() => openScreen({ screenId: "archive" })} />;
}
export function ArchiveScreen(props: PluginScreenProps) {
  // Reset search and pending feedback when the selected host changes.
  return <HostArchiveScreen key={props.host.id} {...props} />;
}
function HostArchiveScreen({ theme, host, layout, navigation }: PluginScreenProps) {
  const list = useRpc(listArchives);
  const restore = useRpc(restoreArchive);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const archives = useQuery({ queryKey: ["conversation-archives", host.id], queryFn: () => list({}), refetchInterval: 15000 });
  const restoring = useMutation({
    mutationFn: ({ agentId }: { agentId: string; open: boolean }) => restore({ agentId }),
    onSuccess: async ({ agentId }, input) => {
      setNotice("Chat restored to Paseo. Its export file is unchanged.");
      await archives.refetch();
      if (input.open) navigation?.openAgent({ agentId });
    },
    onError: () => { void archives.refetch(); },
  });
  const colors = theme.colors;
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted, fontSize: 12 };
  const needle = search.trim().toLowerCase();
  const entries = (archives.data?.entries ?? []).filter((entry) => [entry.title, entry.id, entry.cwd, entry.provider, entry.model].some((value) => value?.toLowerCase().includes(needle)));
  return <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}>
    <Text accessibilityRole="header" style={{ ...text, fontSize: 22, fontWeight: "600" }}>Archive</Text>
    <Text style={text}>Archived chats on {host.label}, including chats archived directly in Paseo. Restore reopens the original session; it does not import Markdown or JSON.</Text>
    <Text style={muted}>Open Export and choose Archive to save an export before archiving. /archive and the Command Center also open Export. Archive uses saved workspace defaults first, then host defaults. Change them in Export → Defaults. Files remain where they were saved after restoring.</Text>
    <View style={{ flexDirection: layout.compact ? "column" : "row", gap: 8 }}>
      <TextInput accessibilityLabel="Search archived chats" value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false}
        placeholder="Search title, provider, folder, or ID" placeholderTextColor={colors.foregroundMuted}
        style={{ ...text, flex: layout.compact ? undefined : 1, padding: 12, borderRadius: 8, backgroundColor: colors.surface1 }} />
      <Pressable accessibilityRole="button" disabled={archives.isFetching} onPress={() => void archives.refetch()} style={{ padding: 12, backgroundColor: colors.surface1, borderRadius: 8 }}>
        <Text style={text}>{archives.isFetching ? "Refreshing…" : "Refresh"}</Text>
      </Pressable>
    </View>
    {archives.error && <Text accessibilityRole="alert" selectable style={text}>{archives.error.message}</Text>}
    {restoring.error && <Text accessibilityRole="alert" selectable style={text}>{restoring.error.message}</Text>}
    {!!notice && <Text accessibilityLiveRegion="polite" style={text}>{notice}</Text>}
    {archives.isPending ? <Text style={muted}>Loading archived chats…</Text> : archives.data && <Text style={muted}>{entries.length} of {archives.data.entries.length} archived chats</Text>}
    {archives.data && !entries.length && <Text style={muted}>{needle ? "No archived chats match your search." : "No archived chats on this host."}</Text>}
    {entries.map((entry) => <View key={entry.id} style={{ padding: 16, borderRadius: 10, backgroundColor: colors.surface1, gap: 8 }}>
      <Text style={{ ...text, fontWeight: "600", fontSize: 16 }}>{entry.title || "Untitled chat"}</Text>
      <Text style={muted}>{entry.provider}{entry.model ? ` · ${entry.model}` : ""} · Archived {new Date(entry.archivedAt).toLocaleString()}</Text>
      <Text selectable style={muted}>{entry.cwd}</Text>
      <Text selectable style={muted}>{entry.id}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(navigation ? [false, true] : [false]).map((open) => <Pressable key={String(open)} accessibilityRole="button"
          accessibilityLabel={`${open ? "Restore and open" : "Restore"} ${entry.title || entry.id}`} disabled={restoring.isPending}
          accessibilityState={{ disabled: restoring.isPending }} onPress={() => { setNotice(""); restoring.mutate({ agentId: entry.id, open }); }}
          style={{ padding: 10, borderRadius: 8, backgroundColor: open ? colors.surface2 : colors.accent, opacity: restoring.isPending ? 0.5 : 1 }}>
          <Text style={{ color: open ? colors.foreground : colors.accentForeground }}>{restoring.isPending && restoring.variables?.agentId === entry.id ? "Restoring…" : open ? "Restore and open" : "Restore"}</Text>
        </Pressable>)}
      </View>
    </View>)}
    <Text style={muted}>Restoring requires the original session and provider persistence to remain on this host. Removed worktrees, missing providers, or deleted provider history can prevent a session from resuming. Restoring a parent does not automatically restore its child chats.</Text>
  </ScrollView>;
}
