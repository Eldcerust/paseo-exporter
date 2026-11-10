import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createArchiveService } from "../server/archive";
import { factoryDefaults, type Preferences } from "../shared/preferences";
import { archiveSession, listArchives, restoreArchive } from "../shared/archive";

const archivedAt = "2026-11-10T07:00:00.000Z";
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-archive-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agent = {
    id: "chat-1", title: "Archived conversation", provider: "codex", model: "test-model",
    workspaceId: "workspace-1", cwd: directory, createdAt: "2026-11-01T00:00:00Z",
    status: "idle", activeTurn: null as unknown, archivedAt: null as string | null,
  };
  const calls = { ref: [] as string[], refresh: 0, history: 0, archive: 0, reload: 0 };
  const handle = {
    refresh: async () => { calls.refresh++; return { agent: { ...agent } }; },
    archive: async () => { calls.archive++; agent.archivedAt = archivedAt; return { archivedAt }; },
    reload: async () => { calls.reload++; agent.archivedAt = null; return { agent: { ...agent } }; },
    timeline: { refetch: async () => {
      calls.history++;
      return { agent: { ...agent }, epoch: "epoch", entries: [
        { seqStart: 1, seqEnd: 1, provider: "codex", timestamp: archivedAt, item: { type: "user_message", text: "Keep my chat" }, sourceSeqRanges: [], collapsed: [] },
        { seqStart: 2, seqEnd: 2, provider: "codex", timestamp: archivedAt, item: { type: "reasoning", text: "private thought" }, sourceSeqRanges: [], collapsed: [] },
      ], hasOlder: false, error: null, gap: false, staleCursor: false, reset: false };
    } },
  };
  const preferences: Preferences = {
    defaults: { ...factoryDefaults, destination: "custom", directory }, workspaces: {},
  };
  const context = { paseo: { agents: { ref: (id: string) => { calls.ref.push(id); return handle; } } } } as unknown as PluginHandlerContext;
  return { directory, agent, calls, handle, context, preferences, service: createArchiveService(async () => preferences) };
}

test("archive saves workspace defaults before soft-deleting the original session", async (t) => {
  const f = await fixture(t);
  f.preferences.workspaces[f.agent.workspaceId] = {
    ...f.preferences.defaults, format: "json", options: { includeReasoning: false, includeTools: false, includeTimestamps: false },
  };
  f.handle.archive = async () => {
    f.calls.archive++;
    const files = await readdir(f.directory);
    assert.equal(files.length, 1, "a durable export must exist before native archive");
    const saved = JSON.parse(await readFile(join(f.directory, files[0]), "utf8"));
    assert.equal(saved.entries.length, 1);
    assert.equal(saved.entries[0].timestamp, undefined);
    assert.equal(saved.session.id, "chat-1");
    f.agent.archivedAt = archivedAt;
    return { archivedAt };
  };
  const result = await f.service.archive({ agentId: "chat-1" }, f.context);
  assert.ok(result.path.endsWith(".json"));
  assert.equal(result.entryCount, 1);
  assert.equal(result.archivedAt, archivedAt);
  assert.equal(f.calls.archive, 1);
  assert.ok(f.calls.ref.every((id) => id === "chat-1"));
  assert.deepEqual(archiveSession.output.parse(result), result);
});
test("archive falls back to saved host defaults and supports the session folder", async (t) => {
  const f = await fixture(t);
  f.preferences.defaults.destination = "session";
  const result = await f.service.archive({ agentId: "chat-1" }, f.context);
  assert.equal(result.path.startsWith(join(f.directory, "Paseo Exports")), true);
  assert.match(await readFile(result.path, "utf8"), /Keep my chat/);
  assert.match(await readFile(result.path, "utf8"), /private thought/);
});
test("clipboard defaults never archive or fetch history", async (t) => {
  const f = await fixture(t);
  f.preferences.defaults.destination = "clipboard";
  await assert.rejects(f.service.archive({ agentId: "chat-1" }, f.context), /needs a saved file/);
  assert.equal(f.calls.history, 0);
  assert.equal(f.calls.archive, 0);
  assert.deepEqual(await readdir(f.directory), []);
});
test("running, initializing, active-turn, and already-archived chats cannot be archived", async (t) => {
  const f = await fixture(t);
  for (const status of ["running", "initializing"]) {
    f.agent.status = status;
    await assert.rejects(f.service.archive({ agentId: "chat-1" }, f.context), /finish or stop/);
  }
  f.agent.status = "idle";
  f.agent.activeTurn = { turnId: "turn" };
  await assert.rejects(f.service.archive({ agentId: "chat-1" }, f.context), /finish or stop/);
  f.agent.activeTurn = null;
  f.agent.archivedAt = archivedAt;
  await assert.rejects(f.service.archive({ agentId: "chat-1" }, f.context), /already archived/);
  assert.equal(f.calls.history, 0);
  assert.equal(f.calls.archive, 0);
});
test("settings errors and invalid destinations leave the session active", async (t) => {
  const f = await fixture(t);
  const invalid = createArchiveService(async () => { throw new Error("Settings are invalid"); });
  await assert.rejects(invalid.archive({ agentId: "chat-1" }, f.context), /Settings are invalid/);
  f.preferences.defaults.directory = "relative-folder";
  await assert.rejects(f.service.archive({ agentId: "chat-1" }, f.context), /absolute host folder/);
  assert.equal(f.calls.history, 0);
  assert.equal(f.calls.archive, 0);
});
test("incomplete history and failed file writes never archive a chat", async (t) => {
  const f = await fixture(t);
  const history = f.handle.timeline.refetch;
  f.handle.timeline.refetch = async () => ({ ...await history(), gap: true });
  await assert.rejects(f.service.archive({ agentId: "chat-1" }, f.context), /incomplete/);
  f.handle.timeline.refetch = history;
  const notDirectory = join(f.directory, "a-file");
  await writeFile(notDirectory, "not a directory");
  f.preferences.defaults.directory = notDirectory;
  await assert.rejects(f.service.archive({ agentId: "chat-1" }, f.context));
  assert.equal(f.calls.archive, 0);
  assert.equal(f.agent.archivedAt, null);
});
test("a new turn during export prevents archive and reports the retained file", async (t) => {
  const f = await fixture(t);
  const refresh = f.handle.refresh;
  f.handle.refresh = async () => {
    if (f.calls.refresh === 1) f.agent.status = "running";
    return refresh();
  };
  await assert.rejects(f.service.archive({ agentId: "chat-1" }, f.context), /Export saved to .*but archiving did not complete/);
  assert.equal((await readdir(f.directory)).length, 1);
  assert.equal(f.calls.archive, 0);
});
test("native archive failure keeps the export and releases the operation lock", async (t) => {
  const f = await fixture(t);
  const archive = f.handle.archive;
  f.handle.archive = async () => { throw new Error("Daemon rejected archive"); };
  await assert.rejects(f.service.archive({ agentId: "chat-1" }, f.context), /Export saved to .*Daemon rejected archive/);
  assert.equal((await readdir(f.directory)).length, 1);
  f.handle.archive = archive;
  await f.service.archive({ agentId: "chat-1" }, f.context);
  assert.equal((await readdir(f.directory)).length, 2);
  assert.equal(f.calls.archive, 1);
});
test("concurrent archive and restore requests for one chat are rejected", async (t) => {
  const f = await fixture(t);
  let release!: (value: Preferences) => void;
  let entered!: () => void;
  const enteredSettings = new Promise<void>((resolve) => { entered = resolve; });
  const service = createArchiveService(async () => { entered(); return new Promise<Preferences>((resolve) => { release = resolve; }); });
  const first = service.archive({ agentId: "chat-1" }, f.context);
  await enteredSettings;
  await assert.rejects(service.archive({ agentId: "chat-1" }, f.context), /already in progress/);
  await assert.rejects(service.restore({ agentId: "chat-1" }, f.context), /already in progress/);
  release(f.preferences);
  await first;
  assert.equal(f.calls.archive, 1);
});
test("archive listing walks all directory pages, excludes active chats, deduplicates, and sorts newest first", async (t) => {
  const f = await fixture(t);
  const old = { ...f.agent, id: "old", archivedAt: "2026-11-01T00:00:00Z" };
  const recent = { ...f.agent, id: "recent", archivedAt };
  const pages = [
    { entries: [{ agent: old }, { agent: f.agent }], pageInfo: { hasMore: true, nextCursor: "page-2" } },
    { entries: [{ agent: recent }, { agent: old }], pageInfo: { hasMore: false, nextCursor: null } },
  ];
  const requests: unknown[] = [];
  const context = { paseo: { agents: { list: async (input: unknown) => { requests.push(input); return pages.shift(); } } } } as unknown as PluginHandlerContext;
  const result = await f.service.list({}, context);
  assert.deepEqual(result.entries.map((entry) => entry.id), ["recent", "old"]);
  assert.deepEqual(requests, [undefined, "page-2"].map((cursor) => ({
    filter: { includeArchived: true, includeBackground: true }, sort: [{ key: "created_at", direction: "desc" }],
    page: { limit: 200, ...(cursor ? { cursor } : {}) },
  })));
  assert.deepEqual(listArchives.output.parse(result), result);
});
test("archive listing fails rather than silently returning a truncated or looping list", async (t) => {
  const f = await fixture(t);
  for (const nextCursor of [null, "repeated"]) {
    const context = { paseo: { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor } }) } } } as unknown as PluginHandlerContext;
    await assert.rejects(f.service.list({}, context), /list changed/);
  }
});
test("restore reloads the original archived agent without creating or importing a session", async (t) => {
  const f = await fixture(t);
  f.agent.archivedAt = archivedAt;
  const result = await f.service.restore({ agentId: "chat-1" }, f.context);
  assert.deepEqual(result, { agentId: "chat-1" });
  assert.equal(f.calls.reload, 1);
  assert.equal(f.calls.history, 0);
  assert.equal(f.agent.archivedAt, null);
  assert.deepEqual(restoreArchive.output.parse(result), result);
});
test("repeated restore never reloads or interrupts an already-active chat", async (t) => {
  const f = await fixture(t);
  f.agent.status = "running";
  await f.service.restore({ agentId: "chat-1" }, f.context);
  assert.equal(f.calls.reload, 0);
});
test("restore reports deleted sessions, provider errors, and unsuccessful unarchive", async (t) => {
  const f = await fixture(t);
  const refresh = f.handle.refresh;
  f.handle.refresh = async () => null as never;
  await assert.rejects(f.service.restore({ agentId: "chat-1" }, f.context), /no longer exists/);
  await assert.rejects(f.service.archive({ agentId: "chat-1" }, f.context), /not found/);
  f.handle.refresh = refresh;
  f.agent.archivedAt = archivedAt;
  f.handle.reload = async () => { throw new Error("Provider persistence missing"); };
  await assert.rejects(f.service.restore({ agentId: "chat-1" }, f.context), /persistence missing/);
  f.handle.reload = async () => ({ agent: { ...f.agent } });
  await assert.rejects(f.service.restore({ agentId: "chat-1" }, f.context), /did not restore/);
});
