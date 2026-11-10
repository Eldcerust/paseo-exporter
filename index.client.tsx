import type { PluginClientContext, PluginButtonRegistration, PluginButtonContentProps } from "@getpaseo/plugin/client";
import { ExportPanel, ExportPopover } from "./client/export-panel";
import { registerComposerPill } from "./client/hub-compat";
import { ArchiveScreen, ArchiveSidebarItem } from "./client/archive-screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "archive", title: "Archived chats", Component: ArchiveScreen });
  client.addSidebarHeaderItem({ id: "archived-chats", title: "Archived chats", Component: ArchiveSidebarItem });
  client.addCommandCenterItem({
    id: "archive-session", title: "Save export and archive conversation", icon: "Archive", context: "agent",
    keywords: ["archive", "backup", "history"], onSelect: ({ openPanel }) => openPanel("export"),
  });
  client.addCommandCenterItem({
    id: "open-archive", title: "Open archived chats", icon: "ArchiveRestore", context: "global",
    keywords: ["archive", "restore", "history"], onSelect: ({ openScreen }) => openScreen({ screenId: "archive" }),
  });
  client.addSlashCommand({ name: "archive", description: "Open Export to save and archive this chat", argumentHint: "", context: "agent", onSubmit: ({ openPanel }) => openPanel("export") });
  client.addWorkspacePanel({ id: "export", title: "Export conversation", icon: "FileDown", context: "agent", Component: ExportPanel });
  client.addCommandCenterItem({
    id: "export-session", title: "Export conversation as Markdown or JSON", icon: "FileDown",
    keywords: ["session", "history", "markdown", "download"], context: "agent",
    onSelect: ({ openPanel }) => openPanel("export"),
  });
  client.addSlashCommand({ name: "export", description: "Export this conversation as Markdown or JSON", argumentHint: "", context: "agent", onSubmit: ({ openPanel }) => openPanel("export") });
  const pills = new Map<string, PluginButtonRegistration>();
  const placements = new Map<string, string>();
  const lifetime = new AbortController();
  const remove = (id: string) => { pills.get(id)?.remove(); pills.delete(id); placements.delete(id); };
  const clear = () => { for (const id of pills.keys()) remove(id); };
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted) return;
    if (placements.get(agent.id) === agent.workspaceId && pills.has(agent.id)) return;
    remove(agent.id);
    if (!agent.workspaceId) return;
    const { id: agentId, workspaceId } = agent;
    placements.set(agentId, workspaceId);
    function Popover(props: PluginButtonContentProps) {
      return <ExportPopover {...props} onOpenPreview={() => {
        props.close();
        client.openPanel("export", { workspaceId, agentId });
      }} />;
    }
    // Follows the Pill hub when one is running; otherwise it is the Export pill it always was.
    pills.set(agentId, registerComposerPill(client, {
      toolId: "export", agentId, workspaceId,
      button: { title: "Export conversation", label: "Export", icon: "FileDown", behavior: {
        kind: "popover", Content: Popover,
      } },
    }));
  };
  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (lifetime.signal.aborted) { void subscription.release(); return; }
    subscription.subscribe({
      snapshot: ({ entries }) => {
        const ids = new Set(entries.map(({ agent }) => agent.id));
        for (const id of pills.keys()) if (!ids.has(id)) remove(id);
        for (const { agent } of entries) register(agent);
      },
      update: (message) => {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert") register(update.agent);
        else remove(update.agentId);
      },
    });
  }).catch((error) => { if (!lifetime.signal.aborted) console.error("Exporter agent observation failed", error); });
  return () => { lifetime.abort(); clear(); };
}
