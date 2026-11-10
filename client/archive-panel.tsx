import { useMutation, useQuery } from "@tanstack/react-query";
import { type PluginAgentPanelProps, type PluginButtonContentProps, useAgent } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRpc } from "./hub-compat";
import { archiveSession } from "../shared/archive";
import { readPreferences, resolveDefaults } from "../shared/preferences";

type TargetProps = Pick<PluginAgentPanelProps, "agentId" | "workspaceId" | "theme" | "layout" | "host"> & {
  onOpenExport(): void;
  onArchived?(): void;
  popover?: boolean;
};
export function ArchivePopover(props: PluginButtonContentProps & { onOpenExport(): void }) {
  if (props.context !== "agent") return null;
  return <View style={{ width: props.layout.compact ? "100%" : 360 }}>
    <ArchiveControls {...props} popover onArchived={props.close} />
  </View>;
}
export function ArchivePanel(props: PluginAgentPanelProps & { onOpenExport(): void }) {
  return <ScrollView style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}>
    <ArchiveControls {...props} />
  </ScrollView>;
}
function ArchiveControls({ agentId, workspaceId, theme, layout, host, popover, onOpenExport, onArchived }: TargetProps) {
  const agent = useAgent(agentId, ({ title, status }) => ({ title, status }));
  const read = useRpc(readPreferences);
  const archive = useRpc(archiveSession);
  const toast = useToast();
  const saved = useQuery({ queryKey: ["export-preferences", host.id], queryFn: () => read({}), staleTime: 0 });
  const archiving = useMutation({
    mutationFn: () => archive({ agentId }),
    onSuccess: (result) => {
      toast.show(`Chat archived. Saved ${result.entryCount} entries to ${result.path}`, { variant: "success" });
      onArchived?.();
    },
  });
  const colors = theme.colors;
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted, fontSize: 12 };
  const defaults = saved.data && resolveDefaults(saved.data, workspaceId);
  const running = agent?.status === "running" || agent?.status === "initializing";
  const disabled = !defaults || saved.isFetching || running || defaults.destination === "clipboard" || archiving.isPending || archiving.isSuccess;
  return <View style={{ padding: popover ? 0 : layout.compact ? 16 : 24, gap: 12 }}>
    <Text accessibilityRole="header" style={{ ...text, fontSize: 18, fontWeight: "600" }}>Archive conversation</Text>
    <Text numberOfLines={2} style={muted}>{agent?.title || agentId}</Text>
    <Text style={text}>Save an export using this workspace’s saved defaults, then archive the original chat in Paseo. Restore it later from Archive in the sidebar.</Text>
    {defaults && <View style={{ gap: 6, padding: 12, borderRadius: 8, backgroundColor: colors.surface1 }}>
      <Text style={text}>{defaults.format === "markdown" ? "Markdown (.md)" : "JSON (.json)"} · {Object.hasOwn(saved.data!.workspaces, workspaceId) ? "Workspace defaults" : "Host defaults"}</Text>
      <Text selectable style={muted}>{defaults.destination === "exports" ? `~/Paseo Exports on ${host.label}` : defaults.destination === "session" ? `Paseo Exports inside this chat’s working directory on ${host.label}` : defaults.destination === "custom" ? `${defaults.directory} on ${host.label}` : "Clipboard: choose a folder before archiving"}</Text>
      <Text style={muted}>Reasoning: {defaults.options.includeReasoning ? "on" : "off"} · Tools: {defaults.options.includeTools ? "on" : "off"} · Timestamps: {defaults.options.includeTimestamps ? "on" : "off"}</Text>
    </View>}
    {saved.isPending && <Text style={muted}>Loading saved export defaults…</Text>}
    {saved.error && <>
      <Text accessibilityRole="alert" style={text}>{saved.error.message}</Text>
      <Pressable accessibilityRole="button" onPress={() => void saved.refetch()}><Text style={text}>Retry loading defaults</Text></Pressable>
    </>}
    {running && <Text style={muted}>Wait for the current turn to finish or stop it before archiving.</Text>}
    {defaults?.destination === "clipboard" && <Text style={muted}>Archive requires a file. Open Export, select a folder, and save it as a workspace or host default.</Text>}
    <Text style={muted}>If saving fails, this chat stays active. Paseo also archives managed child agents; their separate histories are not exported. Restore needs the original Paseo/provider data, not this export file.</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={() => archiving.mutate()}
        style={{ padding: 12, borderRadius: 8, backgroundColor: colors.accent, opacity: disabled ? 0.5 : 1 }}>
        <Text style={{ color: colors.accentForeground, fontWeight: "600" }}>{archiving.isPending ? "Saving and archiving…" : archiving.isSuccess ? "Archived" : "Save export and archive"}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={archiving.isPending} onPress={onOpenExport} style={{ padding: 12, borderRadius: 8, backgroundColor: colors.surface1 }}>
        <Text style={text}>Export settings</Text>
      </Pressable>
    </View>
    {archiving.error && <Text accessibilityRole="alert" selectable style={text}>{archiving.error.message}</Text>}
    {archiving.data && <Text accessibilityLiveRegion="polite" selectable style={text}>Saved to {archiving.data.path}. Find this chat in Archive to restore it.</Text>}
  </View>;
}
