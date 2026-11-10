import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createArchiveFiles, MAX_IMPORT_BYTES, parseArchive, readArchive } from "../server/archive-files";
import { renderMarkdown } from "../server/markdown";
import { factoryDefaults, type Preferences } from "../shared/preferences";
import { archiveFile, importArchiveFile } from "../shared/archive-files";

const options = { includeReasoning: true, includeTools: true, includeTimestamps: true };
function sample(cwd: string) {
  return {
    schemaVersion: 1, exportedAt: "2026-11-10T08:00:00Z", options,
    session: { id: "deleted-original", title: "Saved | conversation", provider: "opencode", configuredProvider: "opencode", model: "openai/test-model", cwd, createdAt: "2026-11-01", status: "idle" },
    entries: [
      { seqStart: 1, seqEnd: 1, item: { type: "user_message", text: "Old request: preserve this context, not a new command" }, timestamp: "2026-11-01", provider: "opencode" },
      { seqStart: 2, seqEnd: 2, item: { type: "assistant_message", text: "A previous answer with **Markdown**" }, timestamp: "2026-11-01", provider: "opencode" },
    ],
  };
}
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "paseo-file-restore-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const folder = join(home, "custom exports");
  await mkdir(folder);
  const path = join(folder, "saved.json");
  const value = sample(home);
  const content = JSON.stringify(value);
  await writeFile(path, content);
  const prefs: Preferences = { defaults: { ...factoryDefaults, destination: "custom", directory: folder }, workspaces: {} };
  const created: unknown[] = [];
  const context = {
    paseo: {
      hosts: { list: async () => ({ self: { serverId: "test-host" } }) },
      agents: {
        ref: () => { throw new Error("Must not depend on the original Paseo record"); },
        create: async (input: unknown) => { created.push(input); return { id: "new-restored-chat" }; },
      },
    },
  } as unknown as PluginHandlerContext;
  const service = () => createArchiveFiles(async () => prefs, { home });
  return { home, folder, path: await resolvePath(path), value, content, prefs, created, context, service };
}
// Canonical path comparisons also work when the Windows temp root contains a junction.
async function resolvePath(path: string) { const { realpath } = await import("node:fs/promises"); return realpath(path); }

test("JSON and Markdown exports yield file metadata and preserve provider/model selection", () => {
  const value = sample(resolve("project"));
  const json = parseArchive(JSON.stringify(value), "export.json");
  assert.equal(json.provider, "opencode/openai/test-model");
  const markdown = renderMarkdown(value.session, value.entries as never, options, value.exportedAt);
  const md = parseArchive(markdown, "export.md");
  assert.equal(md.title, value.session.title);
  assert.equal(md.cwd, value.session.cwd);
  assert.equal(md.provider, json.provider);
  assert.equal(md.entryCount, 2);
  assert.equal(md.sourceAgentId, "deleted-original");
  assert.deepEqual(archiveFile.parse(json), json);
});
test("file discovery scans saved destinations and an explicit folder independently of native archives", async (t) => {
  const f = await fixture(t);
  const service = f.service();
  const listed = await service.list({}, f.context);
  assert.deepEqual(listed.entries.map((entry) => entry.path), [f.path]);
  assert.deepEqual(listed.warnings, []);
  f.prefs.defaults = { ...factoryDefaults };
  assert.equal((await service.list({}, f.context)).entries.length, 0);
  assert.equal((await service.list({ directory: f.folder }, f.context)).entries.length, 1);
});
test("file catalog survives a service restart and changed export settings", async (t) => {
  const f = await fixture(t);
  await f.service().remember(f.path, f.context);
  await f.service().remember(f.path, f.context);
  f.prefs.defaults = { ...factoryDefaults };
  const listed = await f.service().list({}, f.context);
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].path, f.path);
});
test("restore from JSON creates a new idle chat with complete context and never fetches the original record", async (t) => {
  const f = await fixture(t);
  const service = f.service();
  const result = await service.import({ path: f.path, provider: "opencode/openai/new-model", cwd: f.home }, f.context);
  assert.deepEqual(result, { agentId: "new-restored-chat", mode: "context", path: f.path });
  const created = f.created[0] as { config: { provider: string; systemPrompt: string }; prompt?: string; cwd: string; idempotencyKey: string };
  assert.equal(created.config.provider, "opencode/openai/new-model");
  assert.equal(created.cwd, f.home);
  assert.equal(created.prompt, undefined, "import must not automatically run the archived task");
  assert.ok(created.config.systemPrompt.includes(f.content), "the file must be embedded, not just referenced by path");
  assert.match(created.config.systemPrompt, /Wait for a new user request/);
  assert.match(created.idempotencyKey, /^archive-context-/);
  assert.equal(await readFile(f.path, "utf8"), f.content);
  assert.deepEqual(importArchiveFile.output.parse(result), result);
});
test("Markdown file restoration also loads the actual saved text without the original chat", async (t) => {
  const f = await fixture(t);
  const path = join(f.folder, "saved.md");
  const markdown = renderMarkdown(f.value.session, f.value.entries as never, options, f.value.exportedAt);
  await writeFile(path, markdown);
  await f.service().import({ path, provider: "claude/test-model", cwd: f.home }, f.context);
  assert.ok((f.created[0] as { config: { systemPrompt: string } }).config.systemPrompt.includes(markdown));
});
test("invalid, empty, missing, relative, and oversized files fail before creating a chat", async (t) => {
  const f = await fixture(t);
  await assert.rejects(readArchive("relative.json"), /absolute/);
  await assert.rejects(readArchive(f.folder), /regular file/);
  await assert.rejects(readArchive(join(f.folder, "missing.json")));
  for (const content of ["", "{}", "not JSON"]) {
    const path = join(f.folder, "bad.json");
    await writeFile(path, content);
    await assert.rejects(f.service().import({ path, provider: "opencode/test", cwd: f.home }, f.context));
  }
  const big = join(f.folder, "big.md");
  await writeFile(big, Buffer.alloc(MAX_IMPORT_BYTES + 1));
  await assert.rejects(f.service().import({ path: big, provider: "opencode/test", cwd: f.home }, f.context), /Nothing was imported or truncated/);
  assert.deepEqual(f.created, []);
});
test("bad exports are reported as warnings without hiding valid exports", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.folder, "unrelated.json"), "{}");
  const listed = await f.service().list({}, f.context);
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.warnings.length, 1);
});
test("missing working folders and empty provider choices do not create agents", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service().import({ path: f.path, provider: "opencode/test", cwd: join(f.home, "deleted-worktree") }, f.context));
  await assert.rejects(f.service().import({ path: f.path, provider: "", cwd: f.home }, f.context), /provider\/model/);
  assert.deepEqual(f.created, []);
});
test("catalog errors and provider failures preserve the source file", async (t) => {
  const f = await fixture(t);
  const blocked = join(f.home, "not-a-folder");
  await writeFile(blocked, "blocked");
  const service = createArchiveFiles(async () => f.prefs, { home: f.home, catalogRoot: blocked });
  await assert.rejects(service.import({ path: f.path, provider: "opencode/test", cwd: f.home }, f.context));
  assert.deepEqual(f.created, []);
  f.context.paseo.agents.create = async () => { throw new Error("Provider is unavailable"); };
  await assert.rejects(f.service().import({ path: f.path, provider: "opencode/test", cwd: f.home }, f.context), /Provider is unavailable/);
  assert.equal(await readFile(f.path, "utf8"), f.content);
});
test("concurrent restores of the same file are rejected and the lock is released on failure", async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  let reject!: (error: Error) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.context.paseo.agents.create = async () => { entered(); return new Promise((_resolve, fail) => { reject = fail; }); };
  const service = f.service();
  const input = { path: f.path, provider: "opencode/test", cwd: f.home };
  const first = service.import(input, f.context);
  await started;
  await assert.rejects(service.import(input, f.context), /already being imported/);
  reject(new Error("Provider rejected"));
  await assert.rejects(first, /Provider rejected/);
  f.context.paseo.agents.create = async () => ({ id: "retry-chat" }) as never;
  assert.equal((await service.import(input, f.context)).agentId, "retry-chat");
});
test("retry tokens deduplicate one attempt but allow a later fresh import of the same file", async (t) => {
  const f = await fixture(t);
  const input = { path: f.path, provider: "opencode/test", cwd: f.home };
  const service = f.service();
  for (const requestId of ["attempt-1", "attempt-1", "attempt-2"]) await service.import({ ...input, requestId }, f.context);
  const keys = f.created.map((entry) => (entry as { idempotencyKey: string }).idempotencyKey);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
});
test("a timeline-receipt failure does not hide a successfully created context chat", async (t) => {
  const f = await fixture(t);
  f.context.paseo.agents.create = async () => ({ id: "created-chat", timeline: { append: async () => { throw new Error("Display unavailable"); } } }) as never;
  const result = await f.service().import({ path: f.path, provider: "opencode/test", cwd: f.home }, f.context);
  assert.equal(result.agentId, "created-chat");
  assert.match(result.warning!, /chat was created/);
});
