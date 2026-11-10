import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { RpcOutput } from "@getpaseo/plugin";
import type { inspectArchiveFile } from "../shared/archive-files";

type Receipt = Pick<RpcOutput<typeof inspectArchiveFile>["file"], "path" | "title" | "format" | "entryCount">;
export function ArchiveImportReceipt({ theme, item }: PluginTimelineItemProps<Receipt>) {
  return <View style={{ padding: 14, gap: 6, borderRadius: 8, backgroundColor: theme.colors.surface1 }}>
    <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Conversation imported from file</Text>
    <Text style={{ color: theme.colors.foreground }}>{item.data.title} · {item.data.entryCount} exported entries</Text>
    <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{item.data.path}</Text>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>The saved conversation is loaded as historical context. Send your next message to continue. Import did not run a turn or recreate the old message bubbles.</Text>
  </View>;
}
