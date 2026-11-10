import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as contracts from "../shared/export";
import * as archiveContracts from "../shared/archive";
import * as settings from "../shared/preferences";

// Execute the real TSX with small host-boundary mocks, without loading React Native in Node.
type Props = Record<string, any>;
type Element = { type: string | ((props: Props) => unknown); props: Props };
const jsx = (type: Element["type"], props: Props) => ({ type, props });
const runtime = { jsx, jsxs: jsx };
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  const element = node as Element;
  if (typeof element.type === "function") return expand(element.type(element.props));
  return { ...element, props: { ...element.props, children: expand(element.props.children) } };
}
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
async function loadClient(path: string, dependencies: Record<string, unknown>) {
  const source = await readFile(path, "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } });
  const exports: Record<string, any> = {};
  const require = (name: string) => {
    if (name === "react/jsx-runtime") return runtime;
    if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected client dependency: ${name}`);
    return dependencies[name];
  };
  new Function("require", "exports", outputText)(require, exports);
  return exports;
}

test("the exporter contributes one Export tool and a discoverable Archived chats entry in the main sidebar", async () => {
  const contributed: Record<string, Props[]> = { panels: [], screens: [], header: [], footer: [], commands: [], slash: [], pills: [] };
  const add = (kind: string) => (value: Props) => { contributed[kind].push(value); return () => {}; };
  const module = await loadClient("index.client.tsx", {
    "./client/export-panel": { ExportPanel: () => null, ExportPopover: () => null },
    "./client/archive-screen": { ArchiveScreen: () => null, ArchiveSidebarItem: () => null },
    "./client/hub-compat": { registerComposerPill: (_client: unknown, spec: Props) => { contributed.pills.push(spec); return { remove() {} }; } },
  });
  const cleanup = module.default({
    addWorkspacePanel: add("panels"), addScreen: add("screens"), addSidebarHeaderItem: add("header"), addSidebarFooterItem: add("footer"),
    addCommandCenterItem: add("commands"), addSlashCommand: add("slash"),
    paseo: { agents: { list: async () => ({ subscription: {
      subscribe: ({ snapshot }: Props) => snapshot({ entries: [{ agent: { id: "chat", workspaceId: "workspace" } }] }),
      release: async () => {},
    } }) } },
  });
  await Promise.resolve();
  assert.deepEqual(contributed.pills.map((entry) => entry.toolId), ["export"]);
  assert.deepEqual(contributed.panels.map((entry) => entry.id), ["export"]);
  assert.deepEqual(contributed.header.map((entry) => ({ id: entry.id, title: entry.title })), [{ id: "archived-chats", title: "Archived chats" }]);
  assert.deepEqual(contributed.footer, [], "the restore entry must not be hidden below the workspace list");
  assert.deepEqual(contributed.screens.map((entry) => entry.id), ["archive"]);
  const opened: string[] = [];
  contributed.slash.find((entry) => entry.name === "archive")!.onSubmit({ openPanel: (id: string) => opened.push(id) });
  contributed.commands.find((entry) => entry.id === "archive-session")!.onSelect({ openPanel: (id: string) => opened.push(id) });
  assert.deepEqual(opened, ["export", "export"]);
  cleanup();
});

async function exportHarness({ hosted = false, destination = "exports", status = "idle", failure = "" } = {}) {
  const states: unknown[] = [];
  const mutations: Props[] = [];
  const requests: { method: string; input: unknown }[] = [];
  const values = { defaults: { ...settings.factoryDefaults, destination }, workspaces: {} };
  let stateIndex = 0;
  let mutationIndex = 0;
  let closed = false;
  const module = await loadClient("client/export-panel.tsx", {
    react: { useState: (initial: unknown) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value: unknown) => { states[index] = value; }];
    } },
    "react-native": { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View" },
    "@getpaseo/plugin/client": {
      useAgent: (_id: string, select: (record: Props) => unknown) => select({ title: "Example chat", status }),
      useWorkspace: (_id: string, select: (record: Props) => unknown) => select({ name: "Example workspace" }),
      useSettings: () => ({ status: "ready", values, revision: "1" }),
    },
    "@getpaseo/plugin/client/ui": { copyText: async () => {}, Markdown: "Markdown", TextInput: "TextInput", useToast: () => ({ show() {} }) },
    "./hub-compat": {
      useHostedClient: () => hosted ? {} : null,
      useRpc: (contract: Props) => async (input: unknown) => {
        requests.push({ method: contract.name, input });
        if (contract.name === "session.archive") {
          if (failure) throw new Error(failure);
          return { path: "saved-export.md", entryCount: 2, archivedAt: "now" };
        }
        return values;
      },
    },
    "@tanstack/react-query": {
      useQuery: () => ({ data: values }),
      useMutation: (config: Props) => {
        const index = mutationIndex++;
        const mutation = mutations[index] ??= { isPending: false, isSuccess: false, reset() {} };
        mutation.mutate = async (input: unknown) => {
          mutation.isPending = true;
          try {
            mutation.data = await config.mutationFn(input);
            mutation.isSuccess = true;
            config.onSuccess?.(mutation.data);
          } catch (error) { mutation.error = error; }
          finally { mutation.isPending = false; }
        };
        return mutation;
      },
    },
    "../shared/preferences": settings, "../shared/export": contracts, "../shared/archive": archiveContracts,
  });
  function render(compact = false, panel = false) {
    stateIndex = mutationIndex = 0;
    return expand(module[panel ? "ExportPanel" : "ExportPopover"]({
      context: "agent", agentId: "chat", workspaceId: "workspace", host: { id: "host", label: "Test host" },
      layout: { compact }, theme: { colors: { foreground: "text", foregroundMuted: "muted", accent: "accent", accentForeground: "contrast", surface0: "base", surface1: "raised" } },
      close: () => { closed = true; }, onOpenPreview() {},
    }));
  }
  function button(tree: unknown, label: string) {
    const match = elements(tree).find((entry) => entry.type === "Pressable" && entry.props.accessibilityLabel === label);
    assert.ok(match, `Expected ${label} inside Export`);
    return match.props;
  }
  return { render, button, elements, requests, isClosed: () => closed };
}

test("Archive is inside Export on standalone and Pill hub popovers, including compact layouts", async () => {
  for (const hosted of [false, true]) {
    for (const compact of [false, true]) {
      const ui = await exportHarness({ hosted });
      const initial = ui.render(compact);
      ui.button(initial, "Save .md");
      ui.button(initial, "Full panel ↗");
      ui.button(initial, "Archive").onPress();
      assert.equal(ui.requests.length, 0, "opening the archive confirmation must not archive anything");
      const confirmation = ui.render(compact);
      const confirm = ui.button(confirmation, "Save export and archive");
      assert.equal(confirm.disabled, false);
      await confirm.onPress();
      assert.deepEqual(ui.requests, [{ method: "session.archive", input: { agentId: "chat" } }]);
      assert.equal(ui.isClosed(), true);
    }
  }
});
test("inline archive disables confirmation for running chats and saved clipboard defaults", async () => {
  for (const options of [{ status: "running" }, { status: "initializing" }, { destination: "clipboard" }]) {
    const ui = await exportHarness(options);
    ui.button(ui.render(), "Archive").onPress();
    assert.equal(ui.button(ui.render(), "Save export and archive").disabled, true);
    assert.deepEqual(ui.requests, []);
  }
});
test("the full Export panel contains the same inline archive action and confirmation", async () => {
  const ui = await exportHarness();
  const panel = ui.render(false, true);
  ui.button(panel, "Save .md");
  ui.button(panel, "Preview");
  ui.button(panel, "Archive").onPress();
  await ui.button(ui.render(false, true), "Save export and archive").onPress();
  assert.deepEqual(ui.requests, [{ method: "session.archive", input: { agentId: "chat" } }]);
});
test("inline archive retains the export popover and displays failures", async () => {
  const ui = await exportHarness({ failure: "Folder is not writable" });
  ui.button(ui.render(), "Archive").onPress();
  await ui.button(ui.render(), "Save export and archive").onPress();
  assert.equal(ui.isClosed(), false);
  assert.ok(ui.elements(ui.render()).some((entry) => entry.props.accessibilityRole === "alert" && entry.props.children === "Folder is not writable"));
});

test("the Archived chats sidebar link opens the restore screen and its buttons restore the selected original chat", async () => {
  for (const open of [false, true]) {
    const record = { id: "original-chat", title: "Test archived chat", provider: "codex", model: "test", cwd: "project", archivedAt: "2026-11-10T00:00:00Z" };
    const requests: { method: string; input: unknown }[] = [];
    const openedScreens: unknown[] = [];
    const openedAgents: unknown[] = [];
    let mutationDone: Promise<void> | undefined;
    const module = await loadClient("client/archive-screen.tsx", {
      react: { useState: (initial: unknown) => [initial, () => {}] },
      "react-native": { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View" },
      "@getpaseo/plugin/client/ui": { SidebarRow: "SidebarRow", TextInput: "TextInput" },
      "@getpaseo/plugin/client": { useRpc: (contract: Props) => async (input: Props) => {
        requests.push({ method: contract.name, input });
        return contract.name === "archive.restore" ? { agentId: input.agentId } : { entries: [record] };
      } },
      "@tanstack/react-query": {
        useQuery: (config: Props) => ({ data: { entries: [record] }, refetch: config.queryFn }),
        useMutation: (config: Props) => ({ isPending: false, mutate: (input: Props) => {
          mutationDone = (async () => { const result = await config.mutationFn(input); await config.onSuccess(result, input); })();
        } }),
      },
      "../shared/archive": archiveContracts,
    });
    const sidebar = module.ArchiveSidebarItem({ currentScreen: null, openScreen: (input: unknown) => openedScreens.push(input) }) as Element;
    assert.equal(sidebar.props.label, "Archived chats");
    sidebar.props.onPress();
    assert.deepEqual(openedScreens, [{ screenId: "archive" }]);
    const tree = expand(module.ArchiveScreen({
      host: { id: "host", label: "Test host" }, layout: { compact: false }, theme: { colors: {} },
      navigation: { openAgent: (input: unknown) => openedAgents.push(input) },
    }));
    const restore = elements(tree).find((entry) => entry.type === "Pressable" && entry.props.accessibilityLabel === `${open ? "Restore and open" : "Restore"} ${record.title}`);
    assert.ok(restore, "the archive screen must expose a restore button for the selected chat");
    restore.props.onPress();
    await mutationDone;
    assert.deepEqual(requests, [
      { method: "archive.restore", input: { agentId: record.id } },
      { method: "archive.list", input: {} },
    ]);
    assert.deepEqual(openedAgents, open ? [{ agentId: record.id }] : []);
  }
});
