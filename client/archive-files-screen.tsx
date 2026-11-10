import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { Markdown, TextInput } from "@getpaseo/plugin/client/ui";
import { Pressable, ScrollView, Text, View } from "react-native";
import { importArchiveFile, inspectArchiveFile, listArchiveFiles } from "../shared/archive-files";

export function ArchiveFilesScreen({ theme, host, layout, navigation }: PluginScreenProps) {
  const list = useRpc(listArchiveFiles);
  const inspect = useRpc(inspectArchiveFile);
  const restore = useRpc(importArchiveFile);
  const [search, setSearch] = useState("");
  const [directory, setDirectory] = useState("");
  const [scanDirectory, setScanDirectory] = useState("");
  const [path, setPath] = useState("");
  const [provider, setProvider] = useState("");
  const [cwd, setCwd] = useState("");
  const [preview, setPreview] = useState(false);
  const [requestId, setRequestId] = useState("");
  const files = useQuery({ queryKey: ["archive-files", host.id, scanDirectory], queryFn: () => list(scanDirectory ? { directory: scanDirectory } : {}), staleTime: 0 });
  const importing = useMutation({
    mutationFn: () => {
      if (!selected.data) throw new Error("Select an export file first.");
      return restore({ path: selected.data.file.path, provider, cwd, requestId });
    },
    onSuccess: ({ agentId }) => navigation?.openAgent({ agentId }),
  });
  const selected = useMutation({
    mutationFn: (filePath: string) => inspect({ path: filePath }),
    onSuccess: ({ file }) => { setPath(file.path); setProvider(file.provider); setCwd(file.cwd); setPreview(false); setRequestId(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`); importing.reset(); },
  });
  const busy = selected.isPending || importing.isPending;
  const colors = theme.colors;
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted, fontSize: 12 };
  function button(label: string, onPress: () => void, disabled = busy, primary = false) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={{ padding: 12, borderRadius: 8, backgroundColor: primary ? colors.accent : colors.surface1, opacity: disabled ? 0.5 : 1 }}>
      <Text style={{ color: primary ? colors.accentForeground : colors.foreground }}>{label}</Text>
    </Pressable>;
  }
  function input(label: string, value: string, onChangeText: (value: string) => void, placeholder: string) {
    return <TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} editable={!busy} autoCapitalize="none" autoCorrect={false}
      placeholder={placeholder} placeholderTextColor={colors.foregroundMuted} style={{ ...text, padding: 12, backgroundColor: colors.surface1, borderRadius: 8 }} />;
  }
  const needle = search.trim().toLowerCase();
  const entries = (files.data?.entries ?? []).filter((file) => [file.title, file.path, file.provider].some((value) => value.toLowerCase().includes(needle)));
  return <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}>
    <Text accessibilityRole="header" style={{ ...text, fontSize: 22, fontWeight: "600" }}>Archived chats · Export files</Text>
    <Text style={text}>Restore a saved Markdown or JSON conversation into a new Paseo chat, even when the original chat no longer exists.</Text>
    <Text style={muted}>Context import: the exported conversation is loaded as historical context for your next message. It does not recreate separate old message bubbles or provider state. No prompt is submitted and old commands are not replayed during import. The context may be sent to your selected agent provider when you use the new chat.</Text>
    <View style={{ gap: 8 }}>
      {input("Search saved exports", search, setSearch, "Search saved exports")}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{button(files.isFetching ? "Refreshing…" : "Refresh files", () => void files.refetch(), files.isFetching || busy)}</View>
      {input("Additional host folder to scan", directory, setDirectory, "Optional: absolute export folder on this host")}
      {button("Scan folder", () => { if (directory.trim() === scanDirectory) void files.refetch(); else setScanDirectory(directory.trim()); })}
    </View>
    <View style={{ gap: 8 }}>
      <Text style={{ ...text, fontWeight: "600" }}>Import a saved file</Text>
      {input("Export file path on host", path, setPath, "Absolute path to a saved .md or .json file")}
      {button(selected.isPending ? "Reading export…" : "Inspect file", () => selected.mutate(path.trim()), busy || !path.trim())}
      {selected.error && <Text accessibilityRole="alert" selectable style={text}>{selected.error.message}</Text>}
    </View>
    {selected.data && <View style={{ gap: 10, padding: 16, borderWidth: 1, borderColor: colors.accent, borderRadius: 10 }}>
      <Text style={{ ...text, fontSize: 16, fontWeight: "600" }}>{selected.data.file.title}</Text>
      <Text selectable style={muted}>{selected.data.file.path}</Text>
      <Text style={muted}>{selected.data.file.entryCount} entries · {selected.data.file.format} · {selected.data.file.bytes} bytes</Text>
      <Text style={text}>Choose the provider/model and working folder for the restored chat.</Text>
      {input("Provider/model for restored chat", provider, setProvider, "provider/model")}
      {input("Working directory for restored chat", cwd, setCwd, "Existing absolute folder on this host")}
      <Text style={muted}>The file remains unchanged. Only content included in the export can be restored. Imports over 1 MiB are rejected rather than truncated; the provider’s context limits also apply.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button(importing.isPending ? "Creating restored chat…" : "Restore from file", () => importing.mutate(), busy || !provider.trim() || !cwd.trim() || importing.isSuccess, true)}
        {button(preview ? "Hide file preview" : "Preview file", () => setPreview(!preview))}
        {button("Cancel selection", () => { selected.reset(); importing.reset(); })}
      </View>
      {importing.error && <Text accessibilityRole="alert" selectable style={text}>{importing.error.message}</Text>}
      {importing.data && <>
        <Text accessibilityLiveRegion="polite" style={text}>Restored from the file as a new context chat: {importing.data.agentId}</Text>
        {importing.data.warning && <Text style={muted}>{importing.data.warning}</Text>}
        {!!navigation && button("Open restored chat", () => navigation.openAgent({ agentId: importing.data!.agentId }), false)}
      </>}
      {preview && (selected.data.file.format === "markdown" ? <Markdown>{selected.data.content}</Markdown> : <Text selectable style={{ ...text, fontFamily: "monospace", fontSize: 12 }}>{selected.data.content}</Text>)}
    </View>}
    {files.error && <Text accessibilityRole="alert" selectable style={text}>{files.error.message}</Text>}
    {files.isPending && <Text style={muted}>Finding saved conversation exports…</Text>}
    {files.data && <Text style={muted}>{entries.length} of {files.data.entries.length} saved export files on {host.label}</Text>}
    {files.data && !entries.length && <Text style={muted}>No matching saved exports found. Scan the folder containing your exports or enter the export file’s absolute path above. Session-folder exports made before file indexing may need a folder scan.</Text>}
    {entries.map((file) => <View key={file.path} style={{ padding: 16, borderRadius: 10, backgroundColor: colors.surface1, gap: 8 }}>
      <Text style={{ ...text, fontWeight: "600" }}>{file.title}</Text>
      <Text style={muted}>{file.provider} · {file.format} · {file.entryCount} entries · {file.exportedAt}</Text>
      <Text selectable style={muted}>{file.path}</Text>
      {button(`Select export: ${file.title}`, () => selected.mutate(file.path))}
    </View>)}
    {files.data?.warnings.map((warning, index) => <Text key={index} selectable style={muted}>{warning}</Text>)}
  </ScrollView>;
}
