import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createArchiveFiles, parseArchive } from "../server/archive-files";
import { createArchiveService } from "../server/archive";
import { saveSession } from "../server/export";
import { renderMarkdown } from "../server/markdown";
import { createSearchIndexProvider, hostCatalogDirectory, INDEX_FILENAME, toMatchQuery, type IndexDoc } from "../server/search-index";
import { conversationText, MAX_INDEXED_CHARS, searchableBody, TOOL_CHARS } from "../server/search-text";
import { readProjectTitle } from "../server/title";
import { factoryDefaults, type Preferences } from "../shared/preferences";
import { MARK_CLOSE, MARK_OPEN, searchMatches, snippetParts } from "../shared/search";
import { archiveSession, searchArchives } from "../shared/archive";
import { searchArchiveFiles } from "../shared/archive-files";

const ARCHIVED_AT = "2026-11-10T07:00:00.000Z";
const options = { includeReasoning: true, includeTools: true, includeTimestamps: false };

// A small stand-in for the daemon: chats with a history, and one workspace row per chat.
interface Chat { id: string; title: string; workspaceId: string; archivedAt: string | null; texts: string[]; broken?: boolean; items?: object[] }
async function daemon(t: TestContext, serviceOptions: { indexBatch?: number; indexBudgetMs?: number } = {}) {
  const home = await mkdtemp(join(tmpdir(), "paseo-search-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const chats = new Map<string, Chat>();
  const workspaces = new Map<string, { title: string | null; archived: boolean }>();
  const timelineReads: string[] = [];
  const snapshot = (chat: Chat) => ({
    id: chat.id, title: chat.title, provider: "codex", model: "test-model", cwd: home, workspaceId: chat.workspaceId,
    createdAt: "2026-11-01T00:00:00Z", status: "idle", activeTurn: null as unknown, archivedAt: chat.archivedAt,
  });
  const chat = (id: string, title: string, texts: string[], workspaceTitle: string | null = null, extra: Partial<Chat> = {}) => {
    const value: Chat = { id, title, workspaceId: `ws-${id}`, archivedAt: null, texts, ...extra };
    chats.set(id, value);
    workspaces.set(value.workspaceId, { title: workspaceTitle, archived: false });
    return value;
  };
  const context = { paseo: {
    hosts: { list: async () => ({ self: { serverId: "test-host" } }) },
    workspaces: { ref: (id: string) => ({
      refresh: async () => { const w = workspaces.get(id); return w && !w.archived ? { id, title: w.title, name: "folder", workspaceKind: "local_checkout" } : null; },
      archive: async () => { workspaces.get(id)!.archived = true; return { requestId: "r", workspaceId: id, archivedAt: ARCHIVED_AT as string | null, error: null as string | null }; },
    }) },
    agents: {
      list: async ({ filter, page }: { filter?: { includeArchived?: boolean }; page?: { limit?: number; cursor?: string } }) => {
        const all = [...chats.values()].filter((c) => filter?.includeArchived || !c.archivedAt);
        const start = Number(page?.cursor ?? 0);
        const limit = page?.limit ?? 200;
        return { entries: all.slice(start, start + limit).map((c) => ({ agent: snapshot(c) })), pageInfo: { hasMore: start + limit < all.length, nextCursor: start + limit < all.length ? String(start + limit) : null } };
      },
      ref: (id: string) => ({
        refresh: async () => chats.has(id) ? { agent: snapshot(chats.get(id)!) } : null,
        archive: async () => { chats.get(id)!.archivedAt = ARCHIVED_AT; return { archivedAt: ARCHIVED_AT }; },
        timeline: { refetch: async () => {
          timelineReads.push(id);
          const c = chats.get(id)!;
          if (c.broken) throw new Error("The provider history is gone.");
          const items = c.items ?? c.texts.map((text, index) => ({ type: index % 2 ? "assistant_message" : "user_message", text }));
          return { agent: snapshot(c), epoch: "epoch", entries: items.map((item, index) => ({
            seqStart: index + 1, seqEnd: index + 1, provider: "codex", timestamp: ARCHIVED_AT, sourceSeqRanges: [], collapsed: [], item,
          })), hasOlder: false, error: null, gap: false, staleCursor: false, reset: false };
        } },
      }),
    },
  } } as unknown as PluginHandlerContext;
  const exports = join(home, "exports");
  const preferences: Preferences = { defaults: { ...factoryDefaults, destination: "custom", directory: exports }, workspaces: {} };
  const catalogRoot = join(home, "catalog");
  const index = createSearchIndexProvider({ catalogRoot });
  const files = createArchiveFiles(async () => preferences, { home, catalogRoot, index, refreshIntervalMs: 0 });
  const service = createArchiveService(async () => preferences, files.remember, index, serviceOptions);
  return { home, exports, chats, chat, workspaces, timelineReads, context, preferences, catalogRoot, index, files, service };
}
const doc = (over: Partial<IndexDoc>): IndexDoc => ({ kind: "file", key: "k", agentId: null, title: "", meta: "", body: "", stamp: "1", sortKey: "1", payload: "{}", ...over });
const hostContext = { paseo: { hosts: { list: async () => ({ self: { serverId: "test-host" } }) } } } as unknown as PluginHandlerContext;
const marked = (word: string) => `${MARK_OPEN}${word}${MARK_CLOSE}`;

test("title: an export is saved under the project title, and the chat title is kept beside it", async (t) => {
  const d = await daemon(t);
  d.chat("chat-1", "adjust the code in exporter fork for the paseo plugin so tha", ["How do I rename?", "Use the title."], "Exporter: save latest title, search archive text");
  const input = { agentId: "chat-1", options, destination: "custom" as const, directory: d.exports };
  const md = await saveSession({ ...input, format: "markdown" }, d.context);
  assert.equal(md.title, "Exporter: save latest title, search archive text");
  assert.match(basename(md.path), /^Exporter-save-latest-title-search-archive-text-chat-1-/);
  const text = await readFile(md.path, "utf8");
  assert.match(text, /^# Exporter: save latest title, search archive text$/m);
  assert.match(text, /\| Project title \| Exporter: save latest title, search archive text \|/);
  assert.match(text, /\| Chat title \| adjust the code in exporter fork for the paseo plugin so tha \|/);
  assert.equal(parseArchive(text, md.path).title, "Exporter: save latest title, search archive text");

  const json = await saveSession({ ...input, format: "json" }, d.context);
  const saved = JSON.parse(await readFile(json.path, "utf8"));
  assert.equal(saved.session.title, "Exporter: save latest title, search archive text");
  assert.equal(saved.session.projectTitle, "Exporter: save latest title, search archive text");
  assert.equal(saved.session.chatTitle, "adjust the code in exporter fork for the paseo plugin so tha");
  assert.equal(parseArchive(await readFile(json.path, "utf8"), json.path).title, "Exporter: save latest title, search archive text");
});

test("title: the chat title is used when the project has none, is archived, or cannot be read", async (t) => {
  const d = await daemon(t);
  const input = { options, format: "markdown" as const, destination: "custom" as const, directory: d.exports };
  d.chat("untitled", "first prompt", ["hi"], null);
  d.chat("gone", "other first prompt", ["hi"], "Old project name");
  d.workspaces.get("ws-gone")!.archived = true;
  d.chat("blank", "third first prompt", ["hi"], "   ");
  for (const [agentId, expected] of [["untitled", "first prompt"], ["gone", "other first prompt"], ["blank", "third first prompt"]]) {
    const saved = await saveSession({ ...input, agentId }, d.context);
    assert.equal(saved.title, expected);
    const text = await readFile(saved.path, "utf8");
    assert.doesNotMatch(text, /Project title/, "a chat without a project title keeps the original header");
  }
  // A daemon that cannot answer for the workspace must not stop the export.
  const failing = { paseo: { ...d.context.paseo, workspaces: { ref: () => { throw new Error("daemon unavailable"); } } } } as unknown as PluginHandlerContext;
  assert.equal((await saveSession({ ...input, agentId: "untitled" }, failing)).title, "first prompt");
  assert.equal(await readProjectTitle(undefined, d.context), null);
});

test("title: archive saves the project title before it closes the workspace, and the archived list shows it", async (t) => {
  const d = await daemon(t);
  d.chat("chat-1", "first prompt that never changes", ["Why is the sky blue?", "Rayleigh scattering."], "Sky colour explained");
  const result = await d.service.archive({ agentId: "chat-1" }, d.context);
  assert.equal(result.title, "Sky colour explained");
  assert.equal(result.workspace.archived, true);
  assert.deepEqual(archiveSession.output.parse(result), result);
  assert.ok(result.path);
  assert.match(await readFile(result.path, "utf8"), /^# Sky colour explained$/m);
  // This is why the title is read first: once the workspace is archived the daemon no longer returns it.
  assert.equal(await readProjectTitle("ws-chat-1", d.context), null);
  const listed = await d.service.list({}, d.context);
  assert.deepEqual(listed.entries.map((entry) => entry.title), ["Sky colour explained"]);
  assert.equal(d.chats.get("chat-1")!.title, "first prompt that never changes");
});

test("title: a native archive with no saved export keeps the chat title in the list", async (t) => {
  const d = await daemon(t);
  d.chat("native", "first prompt only", ["hello"], "Project name").archivedAt = ARCHIVED_AT;
  assert.deepEqual((await d.service.list({}, d.context)).entries.map((entry) => entry.title), ["first prompt only"]);
});

test("text: the conversation is searchable, but not reasoning, tool output, or the shared export header", () => {
  const session = { id: "agent-1", title: "Snapshot of providers", provider: "codex", model: "m", cwd: "C:/p", createdAt: "x", status: "idle" };
  const at = (seq: number, item: object) => ({ seqStart: seq, seqEnd: seq, timestamp: "t", provider: "codex", item });
  const entries = [
    at(1, { type: "user_message", text: "Where is the zebra?" }),
    at(2, { type: "reasoning", text: "pondering the okapi question" }),
    at(3, { type: "tool_call", callId: "call_123", name: "Bash", status: "completed", detail: { type: "shell", command: "ls zebra-docs", output: "needle ".repeat(400) + "LASTWORD", metadata: { exit: "kiwi" } } }),
    at(8, { type: "tool_call", callId: "call_456", name: "Edit", status: "completed", detail: { type: "edit", filePath: "C:\\notes\\llama.md", oldString: "mango", newString: "papaya", unifiedDiff: "@@ guava" } }),
    at(9, { type: "tool_call", callId: "call_789", name: "Bash", status: "completed", detail: { type: "shell", command: `echo ${"x".repeat(1000)}` } }),
    at(4, { type: "assistant_message", text: "Check the zoo map." }),
    at(5, { type: "todo", items: [{ text: "Buy milk", completed: false }] }),
    at(6, { type: "error", message: "disk full" }),
    at(7, { type: "notification", level: "info", message: "heads up" }),
  ];
  const everything = { includeReasoning: true, includeTools: true, includeTimestamps: false };
  const bodies = {
    "markdown file": searchableBody(renderMarkdown(session, entries as never, everything, "now"), "markdown"),
    "JSON file": searchableBody(JSON.stringify({ schemaVersion: 1, session, entries }), "json"),
    "chat history": conversationText(entries.map(({ item }) => item)),
  };
  for (const [name, body] of Object.entries(bodies)) {
    assert.match(body, /^User: Where is the zebra\?/m, `${name}: roles read as labels, not numbered headings`);
    assert.match(body, /^Assistant: Check the zoo map\./m, name);
    assert.match(body, /^Tasks: .*Buy milk/m, name);
    assert.match(body, /^Error: disk full/m, name);
    assert.match(body, /^Notice: heads up/m, name);
    assert.match(body, /^Tool Bash: ls zebra-docs$/m, `${name}: the command is kept as plain words, without JSON keys or output`);
    assert.match(body, /^Tool Edit: C:\\notes\\llama\.md$/m, `${name}: the file path is kept, not the edit`);
    assert.doesNotMatch(body, /needle|kiwi|mango|papaya|guava|"type"|"command"/, `${name}: output, metadata, and diffs are not indexed`);
    assert.doesNotMatch(body, /okapi/, `${name}: reasoning is not indexed`);
    assert.doesNotMatch(body, /LASTWORD/, `${name}: tool output past the first ${TOOL_CHARS} characters is not indexed`);
    assert.equal(/^Tool Bash: echo x+$/m.exec(body)?.[0].length, "Tool Bash: ".length + TOOL_CHARS, `${name}: a long command is cut to ${TOOL_CHARS} characters`);
    assert.doesNotMatch(body, /Snapshot of|Session \| Value|Export options|<details>|<summary>|call_123|user_message|^## |\n{3,}/m, `${name}: no header or markup`);
  }
  // A Markdown file saved with Windows line endings is still read as a conversation.
  assert.match(searchableBody(renderMarkdown(session, entries as never, everything, "now").replace(/\n/g, "\r\n"), "markdown"), /^User: Where is the zebra\?/m);
  assert.equal(conversationText([null, undefined, { type: "reasoning", text: "x" }, { type: "mystery" }, { type: "todo", items: "nope" }]), "");
  assert.match(searchableBody("not json at all", "json"), /not json at all/);
  assert.equal(searchableBody("a\u0001b\u0002c\u0000d", "json"), "a b c d", "the snippet markers can never appear in indexed text");
  assert.equal(conversationText([{ type: "user_message", text: "x".repeat(MAX_INDEXED_CHARS + 50) }]).length, MAX_INDEXED_CHARS);
});

test("query: words become prefix matches and cannot be read as FTS5 syntax", () => {
  assert.equal(toMatchQuery("purge bun"), '"purge"* "bun"*');
  assert.equal(toMatchQuery('foo" OR "bar'), '"foo"* "OR"* "bar"*');
  assert.equal(toMatchQuery("NEAR(a b) AND -c*"), '"NEAR"* "a"* "b"* "AND"* "c"*');
  assert.equal(toMatchQuery("C:\\Users\\Alvin\\notes.md"), '"C"* "Users"* "Alvin"* "notes"* "md"*');
  assert.equal(toMatchQuery("  !!! ---  "), null);
  assert.equal(toMatchQuery(""), null);
  assert.equal(toMatchQuery(Array.from({ length: 30 }, (_, i) => `w${i}`).join(" "))!.split(" ").length, 12);
});

test("index: ranks titles above body text, matches prefixes and accents, and replaces documents", async (t) => {
  const d = await daemon(t);
  await d.index.use(hostContext, async (index) => {
    assert.ok(index, "node:sqlite with FTS5 must be available to run the search tests");
    index.put(doc({ key: "recipe", title: "Pasta recipe", body: "boil water and salt", agentId: "a1", sortKey: "2026-11-01" }));
    index.put(doc({ key: "notes", title: "Notes", body: "the pasta was overcooked, recipe later", agentId: "a1", sortKey: "2026-11-09" }));
    index.put(doc({ key: "cafe", title: "Trip", body: "We ate at a Café near the station" }));
    index.put(doc({ kind: "chat", key: "chat-1", title: "Pasta chat", body: "pasta pasta pasta" }));

    assert.deepEqual(index.search("pasta", "file", 10).map((hit) => hit.key), ["recipe", "notes"], "the title match outranks the body match");
    assert.deepEqual(index.search("pasta", "chat", 10).map((hit) => hit.key), ["chat-1"], "kinds stay apart");
    assert.deepEqual(index.search("overc", "file", 10).map((hit) => hit.key), ["notes"], "a word beginning matches");
    assert.deepEqual(index.search("cafe", "file", 10).map((hit) => hit.key), ["cafe"], "accents do not matter");
    assert.deepEqual(index.search("PASTA recipe", "file", 10).map((hit) => hit.key), ["recipe", "notes"], "every word must match, in any case");
    assert.deepEqual(index.search("pasta zebra", "file", 10), []);
    assert.deepEqual(index.search('" * ( ) - :', "file", 10), [], "punctuation alone searches for nothing");
    assert.deepEqual(index.search('pasta" OR "salt', "file", 10).map((hit) => hit.key), [], "OR is just a word here, not an operator");
    const [first] = index.search("overcooked", "file", 10);
    assert.equal(first.snippet.includes(marked("overcooked")), true);
    assert.equal(first.agentId, "a1");

    assert.equal(index.titleFor("a1"), "Notes", "the newest saved export names the chat");
    index.put(doc({ key: "notes", title: "Notes v2", body: "completely different words", agentId: "a1", sortKey: "2026-11-10" }));
    assert.deepEqual(index.search("overcooked", "file", 10), [], "a replaced document no longer matches its old text");
    assert.deepEqual(index.search("different", "file", 10).map((hit) => hit.key), ["notes"]);
    assert.equal(index.titleFor("a1"), "Notes v2");
    index.remove("file", "notes");
    assert.deepEqual(index.keys("file").sort(), ["cafe", "recipe"]);
    assert.equal(index.stamp("file", "notes"), undefined);
  });
  // The index is on disk, not in memory: a new connection sees it.
  await d.index.use(hostContext, async (index) => { assert.deepEqual(index!.search("pasta", "file", 10).map((hit) => hit.key), ["recipe"]); });
  assert.equal(d.index.reason(), null);
});

test("index: overlapping first-time opens do not drop each other's work", async (t) => {
  const d = await daemon(t);
  const first = d.index.use(hostContext, async (index) => {
    index!.put(doc({ key: "from-first", title: "First", body: "alpha" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    return index!.search("beta", "file", 5).map((hit) => hit.key);
  });
  const second = d.index.use(hostContext, async (index) => {
    index!.put(doc({ key: "from-second", title: "Second", body: "beta" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    return index!.search("alpha", "file", 5).map((hit) => hit.key);
  });
  assert.deepEqual(await Promise.all([first, second]), [["from-second"], ["from-first"]], "each sees the other's document through its own connection");
  await d.index.use(hostContext, async (index) => assert.deepEqual(index!.keys("file").sort(), ["from-first", "from-second"]));
});

test("index: a corrupt file or an old schema is rebuilt, and an unusable folder reports why", async (t) => {
  const d = await daemon(t);
  const file = join(await hostCatalogDirectory(d.catalogRoot, hostContext), INDEX_FILENAME);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "this is not a sqlite database, it is just bytes ".repeat(200));
  await d.index.use(hostContext, async (index) => {
    assert.ok(index, "a corrupt cache is replaced, not reported as unavailable");
    index.put(doc({ key: "after", title: "Recovered", body: "fresh start" }));
    assert.deepEqual(index.search("fresh", "file", 5).map((hit) => hit.key), ["after"]);
  });

  const { DatabaseSync } = await import("node:sqlite");
  const old = new DatabaseSync(file);
  old.exec("DROP TABLE IF EXISTS docs_fts; DROP TABLE IF EXISTS docs; CREATE TABLE docs(legacy TEXT); INSERT INTO docs VALUES ('x'); PRAGMA user_version = 99;");
  old.close();
  await d.index.use(hostContext, async (index) => {
    assert.ok(index);
    assert.deepEqual(index.keys("file"), [], "a foreign layout is dropped and recreated");
    index.put(doc({ key: "again", title: "Again", body: "works" }));
  });

  const blocker = join(d.home, "not-a-folder");
  await writeFile(blocker, "x");
  const broken = createSearchIndexProvider({ catalogRoot: join(blocker, "catalog") });
  const seen: unknown[] = [];
  assert.equal(await broken.use(hostContext, async (index) => { seen.push(index); return "ran anyway"; }), "ran anyway");
  assert.deepEqual(seen, [null]);
  assert.ok(broken.reason(), "the reason is reported to the screen");
});

test("files: saved exports are searchable by their conversation text as soon as they are remembered", async (t) => {
  const d = await daemon(t);
  d.chat("chat-1", "first prompt", ["How do I purge the bun cache?", "Run bun pm cache rm and reinstall."], "Reinstall pi via npm");
  const saved = await saveSession({ agentId: "chat-1", options, format: "markdown", destination: "custom", directory: d.exports }, d.context);
  await d.files.remember(saved.path, d.context);

  // No listing has run yet: remembering the file indexed it.
  const found = await d.files.search({ query: "purg" }, d.context);
  assert.equal(found.available, true);
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].path, (await d.files.list({}, d.context)).entries[0].path);
  assert.ok(found.hits[0].snippet.includes(marked("purge")), found.hits[0].snippet);
  assert.deepEqual(searchArchiveFiles.output.parse(found), found);
  assert.deepEqual((await d.files.search({ query: "reinstall" }, d.context)).hits.map((hit) => hit.path), [found.hits[0].path], "the title is searched too");
  assert.equal((await d.files.search({ query: "snapshot" }, d.context)).hits.length, 0, "the fixed export header is not searchable");
  assert.equal((await d.files.search({ query: "" }, d.context)).hits.length, 0);
  assert.equal((await d.files.search({ query: "unrelated" }, d.context)).hits.length, 0);
});

test("files: a listing indexes what it finds, notices edits, and forgets deleted exports", async (t) => {
  const d = await daemon(t);
  d.chat("chat-1", "first prompt", ["Tell me about pineapple farming."], "Fruit");
  const saved = await saveSession({ agentId: "chat-1", options, format: "json", destination: "custom", directory: d.exports }, d.context);
  // Never remembered: only a listing can discover this file.
  assert.equal((await d.files.search({ query: "pineapple" }, d.context)).hits.length, 0);
  const listed = await d.files.list({}, d.context);
  assert.equal(listed.entries.length, 1);
  assert.equal((await d.files.search({ query: "pineapple" }, d.context)).hits.length, 1);

  const original = JSON.parse(await readFile(saved.path, "utf8"));
  original.entries[0].item.text = "Tell me about mango harvests, a much longer sentence than before.";
  await writeFile(saved.path, JSON.stringify(original));
  await utimes(saved.path, new Date(), new Date(Date.now() + 5000));
  assert.equal((await d.files.search({ query: "pineapple" }, d.context)).hits.length, 0, "search itself notices an edited export");
  assert.equal((await d.files.search({ query: "mango" }, d.context)).hits.length, 1);

  await rm(saved.path);
  assert.equal((await d.files.search({ query: "mango" }, d.context)).hits.length, 0, "a deleted export stops matching");
  assert.equal((await d.files.list({}, d.context)).entries.length, 0);
  await d.index.use(d.context, async (index) => assert.deepEqual(index!.keys("file"), []));
});

test("files: listing is answered from the index until a file changes", async (t) => {
  const d = await daemon(t);
  d.chat("chat-1", "first prompt", ["alpha"], "Original title");
  const saved = await saveSession({ agentId: "chat-1", options, format: "markdown", destination: "custom", directory: d.exports }, d.context);
  // A whole-second time survives being set again exactly; a fractional one can come back a millisecond off.
  const fixed = new Date("2026-11-10T08:00:00.000Z");
  await utimes(saved.path, fixed, fixed);
  assert.equal((await d.files.list({}, d.context)).entries[0].title, "Original title");
  // Same size and modified time, different bytes: only a cache would still say "Original title".
  const before = await stat(saved.path);
  await writeFile(saved.path, (await readFile(saved.path, "utf8")).replaceAll("Original title", "Replaced title"));
  await utimes(saved.path, fixed, fixed);
  assert.equal((await stat(saved.path)).size, before.size, "the replacement must keep the size for this check to mean anything");
  assert.equal(Math.trunc((await stat(saved.path)).mtimeMs), Math.trunc(before.mtimeMs));
  assert.equal((await d.files.list({}, d.context)).entries[0].title, "Original title");
  // A real edit (new modified time) is read again.
  await utimes(saved.path, new Date(), new Date(Date.now() + 7000));
  assert.equal((await d.files.list({}, d.context)).entries[0].title, "Replaced title");
});

test("files: search failing never breaks listing, restoring, or remembering", async (t) => {
  const d = await daemon(t);
  const blocker = join(d.home, "blocked");
  await writeFile(blocker, "x");
  const files = createArchiveFiles(async () => d.preferences, { home: d.home, catalogRoot: join(d.home, "catalog-2"), index: createSearchIndexProvider({ catalogRoot: join(blocker, "nope") }), refreshIntervalMs: 0 });
  d.chat("chat-1", "first prompt", ["hello world"], "Greeting");
  const saved = await saveSession({ agentId: "chat-1", options, format: "markdown", destination: "custom", directory: d.exports }, d.context);
  await files.remember(saved.path, d.context);
  assert.equal((await files.list({}, d.context)).entries.length, 1);
  const found = await files.search({ query: "hello" }, d.context);
  assert.equal(found.available, false);
  assert.deepEqual(found.hits, []);
  assert.ok(found.reason);
  assert.deepEqual(searchArchiveFiles.output.parse(found), found);
});

test("native: archived chats are indexed from their own history and found by text", async (t) => {
  const d = await daemon(t);
  d.chat("c1", "first prompt one", ["Plan the pineapple pizza.", "Use ham."], null, { archivedAt: ARCHIVED_AT });
  d.chat("c2", "first prompt two", ["Fix the router firmware.", "Flash it."], null, { archivedAt: ARCHIVED_AT });
  d.chat("live", "still active", ["pineapple in an active chat"]);
  const found = await d.service.search({ query: "pineapple" }, d.context);
  assert.equal(found.available, true);
  assert.equal(found.pending, 0);
  assert.deepEqual(found.hits.map((hit) => hit.agentId), ["c1"], "only archived chats, only the matching one");
  assert.ok(found.hits[0].snippet.includes(marked("pineapple")));
  assert.deepEqual(searchArchives.output.parse(found), found);
  assert.deepEqual(d.timelineReads.sort(), ["c1", "c2"], "the active chat is never read");
  // Indexed once: the next searches read nothing.
  assert.deepEqual((await d.service.search({ query: "firmware" }, d.context)).hits.map((hit) => hit.agentId), ["c2"]);
  assert.equal(d.timelineReads.length, 2);
});

test("native: only the conversation of an archived chat is indexed, not its reasoning or tool output", async (t) => {
  const d = await daemon(t);
  d.chat("c1", "first", [], null, { archivedAt: ARCHIVED_AT, items: [
    { type: "user_message", text: "alpha question" },
    { type: "reasoning", text: "bravo private thought" },
    { type: "tool_call", callId: "x", name: "Read", status: "completed", detail: { type: "read", filePath: "notes-delta.md", content: `${"filler ".repeat(100)}charlie` } },
    { type: "assistant_message", text: "echo answer" },
  ] });
  const found = async (query: string) => (await d.service.search({ query }, d.context)).hits.map((hit) => hit.agentId);
  assert.deepEqual([await found("alpha"), await found("echo"), await found("delta")], [["c1"], ["c1"], ["c1"]], "your words, the answer, and the tool's path are searchable");
  assert.deepEqual([await found("bravo"), await found("charlie")], [[], []], "reasoning and tool output are not");
});

test("native: chats are indexed in batches and an empty query only advances the indexing", async (t) => {
  const d = await daemon(t, { indexBatch: 6 });
  for (let i = 0; i < 8; i++) d.chat(`c${i}`, `chat ${i}`, [`topic number${i}`], null, { archivedAt: ARCHIVED_AT });
  const first = await d.service.search({ query: "" }, d.context);
  assert.deepEqual([first.pending, first.hits.length], [2, 0]);
  assert.equal(d.timelineReads.length, 6);
  const second = await d.service.search({ query: "number7" }, d.context);
  assert.equal(second.pending, 0);
  assert.deepEqual(second.hits.map((hit) => hit.agentId), ["c7"]);
  assert.equal(d.timelineReads.length, 8);
});

test("native: a call stops indexing when its time budget is spent, but always makes progress", async (t) => {
  const d = await daemon(t, { indexBatch: 100, indexBudgetMs: 0 });
  for (let i = 0; i < 3; i++) d.chat(`c${i}`, `chat ${i}`, [`topic number${i}`], null, { archivedAt: ARCHIVED_AT });
  assert.equal((await d.service.search({ query: "" }, d.context)).pending, 2, "one chat per call when the budget is already spent");
  assert.equal((await d.service.search({ query: "" }, d.context)).pending, 1);
  assert.deepEqual((await d.service.search({ query: "number2" }, d.context)).hits.map((hit) => hit.agentId), ["c2"]);
  assert.equal(d.timelineReads.length, 3);
  const roomy = await daemon(t, { indexBatch: 100, indexBudgetMs: 60_000 });
  for (let i = 0; i < 3; i++) roomy.chat(`c${i}`, `chat ${i}`, [`topic number${i}`], null, { archivedAt: ARCHIVED_AT });
  assert.equal((await roomy.service.search({ query: "" }, roomy.context)).pending, 0, "a generous budget indexes everything in one call");
});

test("native: one unreadable chat does not block the others and is not retried on every search", async (t) => {
  const d = await daemon(t, { indexBatch: 6 });
  d.chat("bad", "broken history", ["unreachable"], null, { archivedAt: ARCHIVED_AT, broken: true });
  for (let i = 0; i < 7; i++) d.chat(`ok${i}`, `fine ${i}`, [`readable${i}`], null, { archivedAt: ARCHIVED_AT });
  let result = await d.service.search({ query: "readable6" }, d.context);
  // The first batch of six spent one slot on the unreadable chat, so two readable chats are still waiting.
  assert.deepEqual([result.pending, result.hits.length], [2, 0]);
  result = await d.service.search({ query: "readable6" }, d.context);
  assert.equal(result.pending, 0, "the unreadable chat is not counted as pending, so the screen can stop asking");
  assert.deepEqual(result.hits.map((hit) => hit.agentId), ["ok6"]);
  const reads = d.timelineReads.filter((id) => id === "bad").length;
  await d.service.search({ query: "readable0" }, d.context);
  assert.equal(d.timelineReads.filter((id) => id === "bad").length, reads, "no retry inside the cool-down");
});

test("native: a restored chat leaves the index and is indexed again when re-archived", async (t) => {
  const d = await daemon(t);
  const chat = d.chat("c1", "first", ["original wording"], null, { archivedAt: ARCHIVED_AT });
  assert.equal((await d.service.search({ query: "original" }, d.context)).hits.length, 1);
  chat.archivedAt = null;
  chat.texts = ["original wording", "plus a later message about marmalade"];
  assert.deepEqual((await d.service.search({ query: "original" }, d.context)).hits, []);
  await d.index.use(d.context, async (index) => assert.deepEqual(index!.keys("chat"), []));
  chat.archivedAt = "2026-11-12T09:00:00.000Z";
  assert.deepEqual((await d.service.search({ query: "marmalade" }, d.context)).hits.map((hit) => hit.agentId), ["c1"]);
});

test("native: without a search index the answer says so instead of failing", async (t) => {
  const d = await daemon(t);
  d.chat("c1", "first", ["text"], null, { archivedAt: ARCHIVED_AT });
  const plain = createArchiveService(async () => d.preferences);
  const result = await plain.search({ query: "text" }, d.context);
  assert.deepEqual([result.available, result.pending, result.hits], [false, 0, []]);
  assert.ok(result.reason);
  assert.equal((await plain.list({}, d.context)).entries.length, 1);
});

test("shared: snippets split into highlighted parts, and matches put text hits first", () => {
  assert.deepEqual(snippetParts(`…the ${marked("pasta")} was ${marked("over")}cooked…`), [
    { text: "…the ", match: false }, { text: "pasta", match: true }, { text: " was ", match: false },
    { text: "over", match: true }, { text: "cooked…", match: false },
  ]);
  assert.deepEqual(snippetParts("plain"), [{ text: "plain", match: false }]);
  assert.deepEqual(snippetParts(""), []);
  const rows = [{ id: "a", title: "Alpha" }, { id: "b", title: "Pasta recipe" }, { id: "c", title: "Gamma" }, { id: "d", title: "Delta" }];
  const hits = new Map([["c", { rank: -2 }], ["d", { rank: -9 }]]);
  const local = (row: { title: string }, word: string) => row.title.toLowerCase().includes(word);
  assert.deepEqual(searchMatches(rows, "pasta", local, (row) => hits.get(row.id)).map((row) => row.id), ["d", "c", "b"], "best text hit first, then title-only matches, and non-matches hidden");
  assert.deepEqual(searchMatches(rows, "", local, () => undefined).map((row) => row.id), ["a", "b", "c", "d"], "an empty box shows everything in order");
  assert.deepEqual(searchMatches(rows, "zzz", local, () => undefined), []);
});
