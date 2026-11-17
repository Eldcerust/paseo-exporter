import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as contracts from "../shared/export";
import * as archiveContracts from "../shared/archive";
import * as settings from "../shared/preferences";
import * as fileContracts from "../shared/archive-files";
import * as searchContracts from "../shared/search";

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
    "./client/archive-import-receipt": { ArchiveImportReceipt: () => null },
    "./shared/archive-files": fileContracts,
    "./client/hub-compat": { registerComposerPill: (_client: unknown, spec: Props) => { contributed.pills.push(spec); return { remove() {} }; } },
  });
  const cleanup = module.default({
    addWorkspacePanel: add("panels"), addScreen: add("screens"), addSidebarHeaderItem: add("header"), addSidebarFooterItem: add("footer"), addTimelineRenderer: () => () => {},
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

// The debounce hook settles immediately and the snippet renders as a plain element the tests can read.
const searchResults = { useDebounced: (value: unknown) => value, Snippet: (props: Props) => jsx("Snippet", props) };
const archivedWorkspace = { id: "workspace", name: "Example workspace", archived: true, note: null as string | null };
async function exportHarness({ hosted = false, destination = "exports", status = "idle", failure = "", workspace = archivedWorkspace } = {}) {
  const toasts: string[] = [];
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
      useWorkspace: (_id: string, select: (record: Props) => unknown) => select({ name: "example-folder", title: "Example workspace" }),
      useSettings: () => ({ status: "ready", values, revision: "1" }),
    },
    "@getpaseo/plugin/client/ui": { copyText: async () => {}, Markdown: "Markdown", TextInput: "TextInput", useToast: () => ({ show: (message: string) => { toasts.push(message); } }) },
    "./hub-compat": {
      useHostedClient: () => hosted ? {} : null,
      useRpc: (contract: Props) => async (input: unknown) => {
        requests.push({ method: contract.name, input });
        if (contract.name === "session.archive") {
          if (failure) throw new Error(failure);
          return { path: "saved-export.md", entryCount: 2, title: "Example workspace", archivedAt: "now", workspace };
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
  return { render, button, elements, requests, toasts, isClosed: () => closed };
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

test("the secondary native-archive screen explicitly unarchives existing chats", async () => {
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
      "../shared/archive": archiveContracts, "../shared/search": searchContracts, "./search-results": searchResults,
      "./archive-files-screen": { ArchiveFilesScreen: () => null },
    });
    const sidebar = module.ArchiveSidebarItem({ currentScreen: null, openScreen: (input: unknown) => openedScreens.push(input) }) as Element;
    assert.equal(sidebar.props.label, "Archived chats");
    sidebar.props.onPress();
    assert.deepEqual(openedScreens, [{ screenId: "archive" }]);
    const tree = expand(module.NativeArchiveScreen({
      host: { id: "host", label: "Test host" }, layout: { compact: false }, theme: { colors: {} },
      navigation: { openAgent: (input: unknown) => openedAgents.push(input) },
    }));
    const restore = elements(tree).find((entry) => entry.type === "Pressable" && entry.props.accessibilityLabel === `${open ? "Unarchive and open" : "Unarchive"} ${record.title}`);
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

test("Archived chats opens saved export files by default, not native unarchive", async () => {
  const module = await loadClient("client/archive-screen.tsx", {
    react: { useState: (initial: unknown) => [initial, () => {}] },
    "react-native": { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View" },
    "@getpaseo/plugin/client/ui": { SidebarRow: "SidebarRow", TextInput: "TextInput" },
    "@getpaseo/plugin/client": {}, "@tanstack/react-query": {}, "../shared/archive": archiveContracts, "../shared/search": searchContracts, "./search-results": searchResults,
    "./archive-files-screen": { ArchiveFilesScreen: () => jsx("SavedExportFiles", {}) },
  });
  const tree = expand(module.ArchiveScreen({ host: { id: "host" }, theme: { colors: {} } }));
  assert.ok(elements(tree).some((entry) => entry.type === "SavedExportFiles"));
});

test("a saved export can be inspected and restored through the file-import RPC in the sidebar", async () => {
  const states: unknown[] = [];
  const mutations: Props[] = [];
  const requests: { method: string; input: unknown }[] = [];
  const opened: unknown[] = [];
  let stateIndex = 0;
  let mutationIndex = 0;
  const file = { path: "C:\\exports\\saved.json", title: "File-only chat", format: "json", provider: "opencode/test", cwd: "C:\\project", entryCount: 2, bytes: 200, sourceAgentId: "deleted-original", exportedAt: "now" };
  const module = await loadClient("client/archive-files-screen.tsx", {
    react: { useState: (initial: unknown) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value: unknown) => { states[index] = value; }];
    } },
    "react-native": { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View" },
    "@getpaseo/plugin/client/ui": { Markdown: "Markdown", TextInput: "TextInput" },
    "@getpaseo/plugin/client": { useRpc: (contract: Props) => async (input: unknown) => {
      requests.push({ method: contract.name, input });
      if (contract.name === "archive.files.inspect") return { file, content: "saved conversation" };
      if (contract.name === "archive.files.import") return { agentId: "new-context-chat", mode: "context", path: file.path };
      throw new Error("File restoration must not call native unarchive");
    } },
    "@tanstack/react-query": {
      useQuery: () => ({ data: { entries: [file], warnings: [] } }),
      useMutation: (config: Props) => {
        const index = mutationIndex++;
        const mutation = mutations[index] ??= { isPending: false, isSuccess: false };
        mutation.reset = () => { delete mutation.data; delete mutation.error; mutation.isSuccess = false; };
        mutation.mutate = async (input: unknown) => {
          mutation.data = await config.mutationFn(input);
          mutation.isSuccess = true;
          await config.onSuccess?.(mutation.data);
        };
        return mutation;
      },
    },
    "../shared/archive-files": fileContracts, "../shared/search": searchContracts, "./search-results": searchResults,
  });
  function render() {
    stateIndex = mutationIndex = 0;
    return expand(module.ArchiveFilesScreen({ theme: { colors: {} }, host: { id: "host", label: "Test" }, layout: { compact: true }, navigation: { openAgent: (input: unknown) => opened.push(input) } }));
  }
  function button(tree: unknown, label: string) {
    const result = elements(tree).find((entry) => entry.type === "Pressable" && entry.props.accessibilityLabel === label);
    assert.ok(result, `Missing file import button: ${label}`);
    return result.props;
  }
  await button(render(), "Select export: File-only chat").onPress();
  const confirm = button(render(), "Restore from file");
  assert.equal(confirm.disabled, false);
  await confirm.onPress();
  const requestId = (requests[1].input as Props).requestId;
  assert.ok(requestId);
  assert.deepEqual(requests, [
    { method: "archive.files.inspect", input: { path: file.path } },
    { method: "archive.files.import", input: { path: file.path, provider: file.provider, cwd: file.cwd, requestId } },
  ]);
  assert.deepEqual(opened, [{ agentId: "new-context-chat" }]);
});

const words = (tree: unknown) => elements(tree).filter((entry) => entry.type === "Text").map((entry) => [entry.props.children].flat().join("")).join("\n");
test("full session ui: confirmation and receipt name the workspace", async () => {
  const ui = await exportHarness();
  ui.button(ui.render(false, true), "Archive").onPress();
  const confirmation = words(ui.render(false, true));
  assert.match(confirmation, /archive the chat and its workspace “Example workspace” so it leaves the sidebar/);
  assert.match(confirmation, /terminals close with it/);
  assert.match(confirmation, /another chat is still active in the workspace, or it is a Git worktree, the workspace stays/);
  await ui.button(ui.render(false, true), "Save export and archive").onPress();
  assert.match(words(ui.render(false, true)), /Saved to saved-export\.md as “Example workspace”\. Workspace “Example workspace” archived\. Open Archived chats/);
  assert.deepEqual(ui.toasts, ["Chat archived as “Example workspace”. Saved 2 entries to saved-export.md. Workspace “Example workspace” archived."]);

  const note = "1 other chat is still active in this workspace, so it was kept. Archive the workspace from the sidebar to close them too.";
  const kept = await exportHarness({ workspace: { id: "workspace", name: "Example workspace", archived: false, note } });
  kept.button(kept.render(), "Archive").onPress();
  await kept.button(kept.render(), "Save export and archive").onPress();
  assert.deepEqual(kept.toasts, [`Chat archived as “Example workspace”. Saved 2 entries to saved-export.md. ${note}`]);
  assert.match(words(kept.render()), /Saved to saved-export\.md as “Example workspace”\. 1 other chat is still active in this workspace/);
  assert.doesNotMatch(words(kept.render()), /Workspace “Example workspace” archived/);
  assert.equal(archiveContracts.workspaceSummary({ id: null, name: null, archived: false, note: null }), "Workspace left in place.");
});
test("full session ui: native restore says when the workspace is still archived", async () => {
  for (const workspaceArchived of [true, false]) {
    const states: unknown[] = [];
    const record = { id: "original-chat", title: "Test archived chat", provider: "codex", model: "test", cwd: "project", archivedAt: "2026-11-10T00:00:00Z" };
    let stateIndex = 0;
    let mutationDone: Promise<void> | undefined;
    const module = await loadClient("client/archive-screen.tsx", {
      react: { useState: (initial: unknown) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (value: unknown) => { states[index] = value; }];
      } },
      "react-native": { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View" },
      "@getpaseo/plugin/client/ui": { SidebarRow: "SidebarRow", TextInput: "TextInput" },
      "@getpaseo/plugin/client": { useRpc: (contract: Props) => async (input: Props) => contract.name === "archive.restore" ? { agentId: input.agentId, workspaceArchived } : { entries: [record] } },
      "@tanstack/react-query": {
        useQuery: (config: Props) => ({ data: { entries: [record] }, refetch: config.queryFn }),
        useMutation: (config: Props) => ({ isPending: false, mutate: (input: Props) => {
          mutationDone = (async () => { const result = await config.mutationFn(input); await config.onSuccess(result, input); })();
        } }),
      },
      "../shared/archive": archiveContracts, "../shared/search": searchContracts, "./search-results": searchResults,
      "./archive-files-screen": { ArchiveFilesScreen: () => null },
    });
    const render = () => {
      stateIndex = 0;
      return expand(module.NativeArchiveScreen({ host: { id: "host", label: "Test host" }, layout: { compact: false }, theme: { colors: {} }, navigation: undefined }));
    };
    const restore = elements(render()).find((entry) => entry.type === "Pressable" && entry.props.accessibilityLabel === "Unarchive Test archived chat");
    assert.ok(restore, "the archive screen must expose an Unarchive button");
    restore.props.onPress();
    await mutationDone;
    const shown = words(render());
    if (workspaceArchived) {
      assert.match(shown, /Chat unarchived, but its workspace is still archived, so it has no row in the sidebar/);
      assert.doesNotMatch(shown, /Chat restored to Paseo/);
    } else {
      assert.match(shown, /Chat restored to Paseo\. Its export file is unchanged\./);
      assert.doesNotMatch(shown, /still archived/);
    }
  }
});

// ---- Text search in the Archived chats screens ----
const marker = (word: string) => `${searchContracts.MARK_OPEN}${word}${searchContracts.MARK_CLOSE}`;
async function searchScreen(kind: "files" | "native", { list, search, debounce = (value: unknown) => value }: { list: Props; search: Props | ((query: string) => Props); debounce?: (value: unknown) => unknown }) {
  const states: unknown[] = [];
  const configs: Props[] = [];
  let stateIndex = 0;
  const module = await loadClient(kind === "files" ? "client/archive-files-screen.tsx" : "client/archive-screen.tsx", {
    react: { useState: (initial: unknown) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value: unknown) => { states[index] = value; }];
    } },
    "react-native": { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View" },
    "@getpaseo/plugin/client/ui": { Markdown: "Markdown", SidebarRow: "SidebarRow", TextInput: "TextInput" },
    "@getpaseo/plugin/client": { useRpc: () => async () => ({}) },
    "@tanstack/react-query": {
      useQuery: (config: Props) => { configs.push(config); return { data: /search/.test(String(config.queryKey[0])) ? (typeof search === "function" ? search(config.queryKey[2]) : search) : list, isFetching: false, refetch: async () => {} }; },
      useMutation: () => ({ isPending: false, isSuccess: false, mutate() {}, reset() {} }),
    },
    "../shared/archive": archiveContracts, "../shared/archive-files": fileContracts, "../shared/search": searchContracts,
    "./search-results": { useDebounced: debounce, Snippet: (props: Props) => jsx("Snippet", props) },
    "./archive-files-screen": { ArchiveFilesScreen: () => null },
  });
  const label = kind === "files" ? "Search saved exports" : "Search archived chats";
  const component = kind === "files" ? module.ArchiveFilesScreen : module.NativeArchiveScreen;
  function render() {
    stateIndex = 0;
    configs.length = 0;
    return expand(component({ theme: { colors: {} }, host: { id: "host", label: "Test" }, layout: { compact: true }, navigation: undefined }));
  }
  const type = (value: string) => {
    const box = elements(render()).find((entry) => entry.type === "TextInput" && entry.props.accessibilityLabel === label);
    assert.ok(box, `Missing ${label}`);
    box.props.onChangeText(value);
  };
  const shown = (tree: unknown) => elements(tree).filter((entry) => entry.type === "Pressable").map((entry) => String(entry.props.accessibilityLabel ?? ""))
    .flatMap((name) => name.startsWith("Select export: ") ? [name.slice("Select export: ".length)] : name.startsWith("Unarchive ") && !name.startsWith("Unarchive and open") ? [name.slice("Unarchive ".length)] : []);
  return { render, type, shown, configs, snippets: (tree: unknown) => elements(tree).filter((entry) => entry.type === "Snippet").map((entry) => entry.props.text) };
}
const savedFile = (title: string, path: string) => ({ path, title, format: "markdown", provider: "codex", cwd: "C:\\p", entryCount: 2, bytes: 10, sourceAgentId: path, exportedAt: "2026-11-10" });

test("search ui: saved exports show conversation-text matches first, with the matching passage", async () => {
  const files = [savedFile("Alpha notes", "a.md"), savedFile("Pasta recipe", "b.md"), savedFile("Gamma", "c.md")];
  const snippet = `…the ${marker("pasta")} was overcooked…`;
  const screen = await searchScreen("files", {
    list: { entries: files, warnings: [] },
    // Like the host, it finds text only for the words it was asked about.
    search: (query) => ({ available: true, reason: null, hits: query === "pasta" ? [{ path: "c.md", snippet, rank: -2 }] : [] }),
  });
  let tree = screen.render();
  assert.deepEqual(screen.shown(tree), ["Alpha notes", "Pasta recipe", "Gamma"], "an empty box lists everything in order");
  assert.deepEqual(screen.snippets(tree), []);
  assert.equal(screen.configs.find((config) => config.queryKey[0] === "archive-file-search")?.enabled, false, "nothing is searched for an empty box");

  screen.type("Pasta");
  tree = screen.render();
  assert.deepEqual(screen.shown(tree), ["Gamma", "Pasta recipe"], "the text match comes first, the title-only match follows, the rest is hidden");
  assert.deepEqual(screen.snippets(tree), [snippet]);
  assert.match(words(tree), /2 of 3 saved export files on Test/);
  const searched = screen.configs.find((config) => config.queryKey[0] === "archive-file-search")!;
  assert.deepEqual(searched.queryKey, ["archive-file-search", "host", "pasta"]);
  assert.equal(searched.enabled, true);
  screen.type("zzz");
  assert.deepEqual(screen.shown(screen.render()), []);
});

test("search ui: hits found for earlier words are ignored while the box has moved on", async () => {
  const files = [savedFile("Alpha notes", "a.md"), savedFile("Pasta recipe", "b.md")];
  const screen = await searchScreen("files", {
    list: { entries: files, warnings: [] },
    search: { available: true, reason: null, hits: [{ path: "a.md", snippet: marker("old"), rank: -1 }] },
    debounce: () => "old",
  });
  screen.type("pasta");
  const tree = screen.render();
  assert.deepEqual(screen.shown(tree), ["Pasta recipe"]);
  assert.deepEqual(screen.snippets(tree), []);
});

test("search ui: a host without a search index says so and keeps matching titles", async () => {
  const screen = await searchScreen("files", {
    list: { entries: [savedFile("Pasta recipe", "b.md")], warnings: [] },
    search: { available: false, reason: "no sqlite here", hits: [] },
  });
  screen.type("pasta");
  const tree = screen.render();
  assert.deepEqual(screen.shown(tree), ["Pasta recipe"]);
  assert.match(words(tree), /Text search is unavailable on this host \(no sqlite here\)\. Only titles, paths, and providers are matched\./);
});

test("search ui: native archives are searched by text, report indexing progress, and keep asking until done", async () => {
  const entries = [
    { id: "c1", title: "Router notes", provider: "codex", model: "m", cwd: "C:\\p", archivedAt: "2026-11-10T00:00:00Z" },
    { id: "c2", title: "Dinner ideas", provider: "codex", model: "m", cwd: "C:\\p", archivedAt: "2026-11-10T00:00:00Z" },
  ];
  const snippet = `${marker("pineapple")} pizza`;
  const screen = await searchScreen("native", {
    list: { entries },
    search: { available: true, reason: null, pending: 3, hits: [{ agentId: "c2", snippet, rank: -3 }] },
  });
  let tree = screen.render();
  assert.deepEqual(screen.shown(tree), ["Router notes", "Dinner ideas"]);
  const empty = screen.configs.find((config) => config.queryKey[0] === "archive-text-search")!;
  assert.notEqual(empty.enabled, false, "even with an empty box the host indexes the next batch");
  assert.equal(empty.refetchInterval({ state: { data: { pending: 3 } } }), 700);
  assert.equal(empty.refetchInterval({ state: { data: { pending: 0 } } }), false);
  assert.equal(empty.refetchInterval({ state: {} }), false);

  screen.type("pineapple");
  tree = screen.render();
  assert.deepEqual(screen.shown(tree), ["Dinner ideas"]);
  assert.deepEqual(screen.snippets(tree), [snippet]);
  assert.match(words(tree), /Indexing 3 archived chats so their text can be searched\. Results may be incomplete until this finishes\./);
  assert.match(words(tree), /1 of 2 archived chats/);
  assert.deepEqual(screen.configs.find((config) => config.queryKey[0] === "archive-text-search")!.queryKey, ["archive-text-search", "host", "pineapple"]);
});

test("search ui: the snippet highlights matches and the debounce settles after a pause", async () => {
  const states: unknown[] = [];
  const cleanups: Array<() => void> = [];
  let stateIndex = 0;
  const module = await loadClient("client/search-results.tsx", {
    react: {
      useState: (initial: unknown) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (value: unknown) => { states[index] = value; }];
      },
      useEffect: (effect: () => () => void) => { cleanups.push(effect()); },
    },
    "react-native": { Text: "Text" },
    "../shared/search": searchContracts,
  });
  const parts = elements(expand(module.Snippet({ text: `a ${marker("b")}\nc`, color: "muted", highlight: "strong" }))).filter((entry) => entry.type === "Text");
  assert.deepEqual(parts.slice(1).map((entry) => [entry.props.children, entry.props.style]), [
    ["a ", undefined], ["b", { color: "strong", fontWeight: "700" }], [" c", undefined],
  ]);

  const hook = (value: string) => { stateIndex = 0; return module.useDebounced(value, 20); };
  assert.equal(hook("a"), "a");
  assert.equal(hook("ab"), "a", "a new value is not used straight away");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(hook("ab"), "ab", "it is used once the box stops changing");
  hook("abc");
  cleanups.at(-1)!();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(hook("abc"), "ab", "typing on cancels the earlier pending update");
});
