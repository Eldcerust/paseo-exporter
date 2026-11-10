import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type PluginAgentPanelProps, type PluginButtonContentProps, useAgent, useSettings, useWorkspace } from "@getpaseo/plugin/client";
import { copyText, Markdown, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useHostedClient, useRpc } from "./hub-compat";
import { defaultsSchema, preferences, readPreferences, resolveDefaults, type ExportDefaults } from "../shared/preferences";
import { exportSession, saveExport, type ExportOptions, type ExportFormat } from "../shared/export";
import { archiveSession } from "../shared/archive";

type Destination = "clipboard" | "exports" | "session" | "custom";
export function ExportPopover(props: PluginButtonContentProps & { onOpenPreview(): void }) {
  if (props.context !== "agent") return null;
  return <View style={{ width: props.layout.compact ? "100%" : 360 }}>
    <ExportForm {...props} context="agent" popover onOpenPreview={props.onOpenPreview} onArchived={props.close} />
  </View>;
}
export function ExportPanel(props: PluginAgentPanelProps) {
  return <ExportForm {...props} />;
}
type FormProps = Pick<PluginAgentPanelProps, "theme" | "host" | "layout" | "workspaceId" | "agentId" | "context"> & { popover?: boolean; onOpenPreview?: () => void; onArchived?: () => void };
function ExportForm(props: FormProps) {
  return useHostedClient() ? <HostedDefaults {...props} /> : <LiveDefaults {...props} />;
}
// Settings belong to the plugin that owns them, so inside the Pill hub this form cannot use
// them. It reads the saved defaults through a backend call and sends changes to the full panel.
function HostedDefaults(props: FormProps) {
  const read = useRpc(readPreferences);
  const saved = useQuery({ queryKey: ["export-preferences", props.host.id], queryFn: () => read({}), staleTime: 0 });
  if (!saved.data) return <View style={{ padding: 12, gap: 8 }}>
    <Text style={{ color: props.theme.colors.foreground }}>{saved.isError ? saved.error.message : "Loading export defaults…"}</Text>
    {saved.isError && <Pressable accessibilityRole="button" onPress={() => void saved.refetch()}><Text style={{ color: props.theme.colors.foreground }}>Retry</Text></Pressable>}
  </View>;
  return <SessionExport key={`${props.host.id}:${props.workspaceId}:${props.agentId}`} {...props}
    initialDefaults={resolveDefaults(saved.data, props.workspaceId)}
    hasWorkspaceDefaults={Object.hasOwn(saved.data.workspaces, props.workspaceId)}
    saveDefaults={async () => { throw new Error("Open the full panel to change saved defaults."); }} />;
}
function LiveDefaults(props: FormProps) {
  const settings = useSettings(preferences);
  if (settings.status !== "ready") return <View style={{ padding: 12, gap: 8 }}>
    <Text style={{ color: props.theme.colors.foreground }}>{settings.status === "loading" ? "Loading export defaults…" : settings.error}</Text>
    {settings.status !== "loading" && <Pressable accessibilityRole="button" onPress={() => void settings.reload()}><Text style={{ color: props.theme.colors.foreground }}>Retry</Text></Pressable>}
  </View>;
  return <SessionExport key={`${props.host.id}:${props.workspaceId}:${props.agentId}`} {...props}
    initialDefaults={resolveDefaults(settings.values, props.workspaceId)}
    hasWorkspaceDefaults={Object.hasOwn(settings.values.workspaces, props.workspaceId)}
    saveDefaults={async (scope, draft) => {
      const values = { ...settings.values, workspaces: { ...settings.values.workspaces } };
      if (scope === "inherit") delete values.workspaces[props.workspaceId];
      else {
        const parsed = defaultsSchema.parse(draft);
        if (scope === "host") values.defaults = parsed;
        else values.workspaces[props.workspaceId] = parsed;
      }
      if (!await settings.save(values, settings.revision)) throw new Error("Defaults could not be saved. Reopen Export to load the latest settings and try again.");
      return scope === "workspace" ? "Workspace defaults saved." : scope === "host" ? "Host defaults saved. Existing workspace defaults take precedence." : "Workspace now uses host defaults. Reopen Export to apply them.";
    }} />;
}
function SessionExport({ agentId, workspaceId, theme, layout, host, initialDefaults, hasWorkspaceDefaults, saveDefaults, popover = false, onOpenPreview, onArchived }: FormProps & {
  initialDefaults: ExportDefaults;
  hasWorkspaceDefaults: boolean;
  saveDefaults(scope: "workspace" | "host" | "inherit", draft: ExportDefaults): Promise<string>;
}) {
  const agent = useAgent(agentId, (record) => ({ title: record.title, status: record.status }));
  const workspace = useWorkspace(workspaceId, (record) => ({ name: record.name }));
  const [showDefaults, setShowDefaults] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const savingDefaults = useMutation({ mutationFn: (scope: "workspace" | "host" | "inherit") => saveDefaults(scope, { options, format, destination, directory }) });
  const generate = useRpc(exportSession);
  const save = useRpc(saveExport);
  const archive = useRpc(archiveSession);
  const toast = useToast();
  const archiving = useMutation({
    mutationFn: () => archive({ agentId }),
    onSuccess: (result) => {
      toast.show(`Chat archived. Saved ${result.entryCount} entries to ${result.path}`, { variant: "success" });
      onArchived?.();
    },
  });
  const [options, setOptions] = useState<ExportOptions>(initialDefaults.options);
  const [format, setFormat] = useState<ExportFormat>(initialDefaults.format);
  const [destination, setDestination] = useState<Destination>(initialDefaults.destination);
  const [directory, setDirectory] = useState(initialDefaults.directory);
  const [raw, setRaw] = useState(false);
  const preview = useMutation({ mutationFn: () => generate({ agentId, options, format }) });
  const exporting = useMutation({ mutationFn: async () => {
    if (destination === "clipboard") {
      const result = await generate({ agentId, options, format });
      await copyText(result.content);
      return `Copied ${format === "markdown" ? "Markdown" : "JSON"} to this device’s clipboard (${result.entryCount} history entries).`;
    }
    const result = await save({ agentId, options, format, destination, ...(destination === "custom" ? { directory } : {}) });
    return `Saved ${result.entryCount} history entries to ${result.path}`;
  } });
  const busy = preview.isPending || exporting.isPending || savingDefaults.isPending || archiving.isPending;
  const running = agent?.status === "running" || agent?.status === "initializing";
  const colors = theme.colors;
  const text = { color: colors.foreground };
  const reset = () => { preview.reset(); exporting.reset(); savingDefaults.reset(); };
  function action(label: string, onPress: () => void, disabled = busy, primary = false) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: primary ? colors.accent : colors.surface1, opacity: disabled ? 0.5 : 1 }}>
      <Text style={{ color: primary ? colors.accentForeground : colors.foreground, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>;
  }
  const content = <View style={{ padding: popover ? 0 : layout.compact ? 16 : 24, gap: 12 }}>
    <Text accessibilityRole="header" style={{ ...text, fontSize: 18, fontWeight: "600" }}>Export conversation</Text>
    <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12 }}>{agent?.title || agentId}</Text>
    <Text style={{ ...text, fontSize: 12, fontWeight: "600" }}>Format</Text>
    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: 8 }}>
      {(["markdown", "json"] as const).map((value) => <Pressable key={value} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: format === value, disabled: busy }} onPress={() => { setFormat(value); reset(); }} style={{ flex: 1, padding: 9, borderRadius: 8, backgroundColor: format === value ? colors.accent : colors.surface1 }}>
        <Text style={{ color: format === value ? colors.accentForeground : colors.foreground, fontSize: 13, textAlign: "center", fontWeight: "600" }}>{value === "markdown" ? "Markdown" : "JSON"}</Text>
      </Pressable>)}
    </View>
    <Text style={{ ...text, fontSize: 12, fontWeight: "600" }}>Save to</Text>
    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {([
        ["exports", "Host folder"], ["session", "Session folder"],
        ["custom", "Custom folder"], ["clipboard", "Clipboard"],
      ] as const).map(([value, label]) => <Pressable key={value} disabled={busy} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: destination === value, disabled: busy }} onPress={() => { setDestination(value); exporting.reset(); }}
        style={{ width: "48%", paddingHorizontal: 10, paddingVertical: 9, borderRadius: 8, backgroundColor: colors.surface1, borderWidth: 1, borderColor: destination === value ? colors.accent : colors.surface1 }}>
        <Text style={{ ...text, fontSize: 13 }}>{destination === value ? "◉" : "○"} {label}</Text>
      </Pressable>)}
    </View>
    <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: 12 }}>
      {destination === "exports" ? `~/Paseo Exports on ${host.label}` : destination === "session" ? `Paseo Exports in the session folder on ${host.label}` : destination === "custom" ? `Folder on ${host.label}` : "Copies to this device’s clipboard"}
    </Text>
    {destination === "custom" && <TextInput accessibilityLabel="Custom host folder path" value={directory} editable={!busy} onChangeText={(value) => { setDirectory(value); exporting.reset(); }} autoCapitalize="none" autoCorrect={false} placeholder="~/Documents/Conversation exports" placeholderTextColor={colors.foregroundMuted} style={{ ...text, backgroundColor: colors.surface1, borderRadius: 8, padding: 12 }} />}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      {([
        ["includeReasoning", "Reasoning"], ["includeTools", "Tools"], ["includeTimestamps", "Timestamps"],
      ] as const).map(([key, label]) => <Pressable key={key} accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked: options[key], disabled: busy }} disabled={busy}
        onPress={() => { setOptions({ ...options, [key]: !options[key] }); reset(); }} style={{ paddingVertical: 6 }}>
        <Text style={{ ...text, fontSize: 12 }}>{options[key] ? "☑" : "☐"} {label}</Text>
      </Pressable>)}
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {action(exporting.isPending ? "Exporting…" : destination === "clipboard" ? "Copy export" : `Save .${format === "markdown" ? "md" : "json"}`, () => exporting.mutate(), busy || (destination === "custom" && !directory.trim()), true)}
      {action("Archive", () => setShowArchive(!showArchive))}
      {popover ? action("Full panel ↗", () => onOpenPreview?.()) : action(preview.isPending ? "Loading…" : "Preview", () => preview.mutate())}
    </View>
    {showArchive && <View style={{ gap: 8, padding: 12, borderRadius: 8, backgroundColor: colors.surface1 }}>
      <Text accessibilityRole="header" style={{ ...text, fontSize: 14, fontWeight: "600" }}>Archive this conversation?</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Save an export using your saved {hasWorkspaceDefaults ? "workspace" : "host"} defaults, then archive the chat. Unsaved changes above do not change archive defaults.</Text>
      <Text selectable style={{ ...text, fontSize: 12 }}>{initialDefaults.format === "markdown" ? "Markdown (.md)" : "JSON (.json)"} · {initialDefaults.destination === "exports" ? `~/Paseo Exports on ${host.label}` : initialDefaults.destination === "session" ? `Paseo Exports in the session folder on ${host.label}` : initialDefaults.destination === "custom" ? `${initialDefaults.directory} on ${host.label}` : "Clipboard: save a folder default first"}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Reasoning: {initialDefaults.options.includeReasoning ? "on" : "off"} · Tools: {initialDefaults.options.includeTools ? "on" : "off"} · Timestamps: {initialDefaults.options.includeTimestamps ? "on" : "off"}</Text>
      {running && <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Wait for the current turn to finish or stop it before archiving.</Text>}
      {initialDefaults.destination === "clipboard" && <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Archive requires a file. Choose a folder above and save it under Defaults first.</Text>}
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>If saving fails, this chat stays active. Restore it later from Archived chats in the main sidebar. Paseo may also archive managed child chats; their histories are not included in this export.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {action(archiving.isPending ? "Saving and archiving…" : archiving.isSuccess ? "Archived" : "Save export and archive", () => archiving.mutate(), busy || running || initialDefaults.destination === "clipboard" || archiving.isSuccess, true)}
        {action("Cancel", () => setShowArchive(false))}
      </View>
      {archiving.error && <Text accessibilityRole="alert" selectable style={text}>{archiving.error.message}</Text>}
      {archiving.data && <Text accessibilityLiveRegion="polite" selectable style={text}>Saved to {archiving.data.path}. Open Archived chats in the sidebar to restore this chat.</Text>}
    </View>}
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: showDefaults }} onPress={() => setShowDefaults(!showDefaults)} style={{ paddingVertical: 4 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{showDefaults ? "▾" : "▸"} Defaults · {hasWorkspaceDefaults ? "workspace" : "host"}</Text>
    </Pressable>
    {showDefaults && <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Remember the current format, folder, and content options. Workspace defaults apply to all sessions in {workspace?.name || "this workspace"}.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {action("Save for workspace", () => savingDefaults.mutate("workspace"))}
        {action("Save for host", () => savingDefaults.mutate("host"))}
        {hasWorkspaceDefaults && action("Use host defaults", () => savingDefaults.mutate("inherit"))}
      </View>
    </View>}
    {savingDefaults.error && <Text accessibilityRole="alert" style={text}>{savingDefaults.error.message}</Text>}
    {savingDefaults.data && <Text accessibilityLiveRegion="polite" style={{ ...text, fontSize: 12 }}>{savingDefaults.data}</Text>}
    {(preview.error || exporting.error) && <Text accessibilityRole="alert" selectable style={text}>{(preview.error || exporting.error)?.message}</Text>}
    {exporting.data && <Text accessibilityLiveRegion="polite" selectable style={text}>{exporting.data}</Text>}
    {!popover && preview.data && <>
      <Text style={{ color: colors.foregroundMuted }}>{preview.data.entryCount} history entries · {preview.data.filename}</Text>
      {format === "markdown" && action(raw ? "Show formatted preview" : "Show Markdown source", () => setRaw(!raw), false)}
      {raw || format === "json" ? <Text selectable style={{ ...text, fontFamily: "monospace", fontSize: 13 }}>{preview.data.content}</Text> : <Markdown>{preview.data.content}</Markdown>}
    </>}
  </View>;
  // Paseo already owns scrolling for popovers and mobile sheets.
  // Only the standalone panel needs its own scroll container.
  return popover ? content : <ScrollView showsVerticalScrollIndicator persistentScrollbar style={{ flex: 1, backgroundColor: colors.surface0 }}>{content}</ScrollView>;
}
