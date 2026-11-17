import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createArchiveFiles, MAX_IMPORT_BYTES, parseArchive, readArchive } from "../server/archive-files";
import { renderMarkdown } from "../server/markdown";
import { factoryDefaults, type Preferences } from "../shared/preferences";
import { archiveFile, importArchiveFile, listArchiveModels } from "../shared/archive-files";
import { compactSnapshot } from "./catalog-fixture";

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
  // Paseo puts a chat made with only a folder in that folder's default workspace ("master"), so the
  // import makes a workspace first. A workspace's chats are created in the folder it was made for.
  const workspaceCalls = { created: [] as Array<{ source: { path: string; projectId?: string }; title: string }>, archived: [] as string[] };
  const projects = [{ id: "workspace-default", projectId: "project-1", projectRootPath: home }];
  // The host's provider catalog. Each read takes the next snapshot, and the last one repeats.
  const catalog = { snapshots: [compactSnapshot()] as unknown[], calls: [] as unknown[] };
  const context = {
    paseo: {
      hosts: { list: async () => ({ self: { serverId: "test-host" } }) },
      agents: {
        ref: () => { throw new Error("Must not depend on the original Paseo record"); },
        create: async (input: { config: { provider: string } }) => {
          // The real SDK refuses a provider that is not `provider/model`.
          if (!/^[^/]+\/.+/.test(input.config.provider)) throw new Error('Expected config.provider in "provider/model" format');
          created.push(input);
          return { id: "new-restored-chat" };
        },
      },
      providers: { snapshot: async (input: unknown) => { catalog.calls.push(input); return catalog.snapshots.length > 1 ? catalog.snapshots.shift() : catalog.snapshots[0]; } },
      workspaces: {
        list: async () => ({ entries: projects }),
        create: async (input: { source: { path: string; projectId?: string }; title: string }) => {
          workspaceCalls.created.push(input);
          const id = `workspace-new-${workspaceCalls.created.length}`;
          return {
            id,
            agents: { create: (options: object) => (context.paseo.agents.create as (input: unknown) => Promise<unknown>)({ ...options, cwd: input.source.path }) },
            archive: async () => { workspaceCalls.archived.push(id); return { requestId: "r", workspaceId: id, archivedAt: "now", error: null }; },
          };
        },
      },
    },
  } as unknown as PluginHandlerContext;
  const service = () => createArchiveFiles(async () => prefs, { home, catalogTiming: { intervalMs: 0, sleep: async () => {} } });
  return { home, folder, path: await resolvePath(path), value, content, prefs, created, context, service, workspaceCalls, projects, catalog };
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
  assert.equal((created.config as { model?: string }).model, undefined, "the text form is used as given, with no model field");
  assert.deepEqual(f.catalog.calls, [], "and the host's catalog is not consulted");
  assert.equal(created.cwd, f.home);
  assert.equal(created.prompt, undefined, "import must not automatically run the archived task");
  assert.ok(created.config.systemPrompt.includes(f.content), "the file must be embedded, not just referenced by path");
  assert.match(created.config.systemPrompt, /Wait for a new user request/);
  assert.match(created.idempotencyKey, /^archive-context-/);
  assert.equal(await readFile(f.path, "utf8"), f.content);
  assert.deepEqual(importArchiveFile.output.parse(result), result);
});
test("restore gives the chat its own workspace named with the original title, not the folder's default", async (t) => {
  const f = await fixture(t);
  const result = await f.service().import({ path: f.path, provider: "opencode/test", cwd: f.home }, f.context);
  assert.deepEqual(f.workspaceCalls.created, [{ source: { kind: "directory", path: f.home, projectId: "project-1" }, title: "Saved | conversation" }],
    "the workspace carries the original title and joins the folder's project");
  assert.equal((f.created[0] as { title: string }).title, "Restored: Saved | conversation", "the chat keeps its Restored: label");
  assert.equal(result.warning, undefined);
  assert.deepEqual(f.workspaceCalls.archived, [], "the new workspace is kept");
});
test("restore finds the folder's project despite a trailing slash, and omits the project when there is none", async (t) => {
  const f = await fixture(t);
  const service = f.service();
  await service.import({ path: f.path, provider: "opencode/test", cwd: `${f.home}${sep}`, requestId: "a" }, f.context);
  assert.equal(f.workspaceCalls.created[0].source.projectId, "project-1");
  f.projects.length = 0;
  await service.import({ path: f.path, provider: "opencode/test", cwd: f.home, requestId: "b" }, f.context);
  assert.deepEqual(f.workspaceCalls.created[1].source, { kind: "directory", path: f.home });
});
test("restore falls back to the default workspace with a warning when no workspace can be made", async (t) => {
  const f = await fixture(t);
  f.context.paseo.workspaces.create = async () => { throw new Error("The daemon refused"); };
  const result = await f.service().import({ path: f.path, provider: "opencode/test", cwd: f.home }, f.context);
  assert.equal(result.agentId, "new-restored-chat", "the chat is still restored");
  assert.match(result.warning!, /workspace for the restored chat could not be created \(The daemon refused\).*default workspace.*git branch/);
  assert.equal((f.created[0] as { cwd: string }).cwd, f.home);
  assert.deepEqual(importArchiveFile.output.parse(result), result);
});
test("restore removes the workspace it made when the chat cannot be created", async (t) => {
  const f = await fixture(t);
  f.context.paseo.agents.create = async () => { throw new Error("Provider is unavailable"); };
  await assert.rejects(f.service().import({ path: f.path, provider: "opencode/test", cwd: f.home }, f.context), /Provider is unavailable/);
  assert.deepEqual(f.workspaceCalls.archived, ["workspace-new-1"], "no empty workspace is left in the sidebar");
});
test("a retried restore does not leave an extra workspace behind", async (t) => {
  const f = await fixture(t);
  const service = f.service();
  // The daemon answers a repeated idempotency key with the chat from the first attempt.
  f.context.paseo.agents.create = async () => ({ id: "first-attempt-chat", refresh: async () => ({ agent: { workspaceId: "workspace-from-first-attempt" } }) }) as never;
  await service.import({ path: f.path, provider: "opencode/test", cwd: f.home, requestId: "same" }, f.context);
  assert.deepEqual(f.workspaceCalls.archived, ["workspace-new-1"]);
  f.context.paseo.agents.create = async () => ({ id: "fresh-chat", refresh: async () => ({ agent: { workspaceId: "workspace-new-2" } }) }) as never;
  await service.import({ path: f.path, provider: "opencode/test", cwd: f.home, requestId: "other" }, f.context);
  assert.deepEqual(f.workspaceCalls.archived, ["workspace-new-1"], "a chat in the workspace just made keeps it");
});
test("the model picker lists only what the host offers for the folder, and says while it is still scanning", async (t) => {
  const f = await fixture(t);
  const service = f.service();
  const listed = await service.models({ cwd: f.home }, f.context);
  assert.deepEqual(listed.providers.map((provider) => provider.id), ["claude", "pi"], "disabled and unready providers are not offered");
  assert.equal(listed.discovering, false);
  assert.deepEqual(f.catalog.calls, [{ cwd: f.home }], "the folder is what the host scans");
  assert.deepEqual(listArchiveModels.output.parse(listed), listed);
  f.catalog.snapshots = [compactSnapshot({ claudeStatus: "loading" })];
  const scanning = await service.models({ cwd: f.home }, f.context);
  assert.deepEqual([scanning.discovering, scanning.providers.map((provider) => provider.id)], [true, ["pi"]], "a provider still loading is reported, not offered");
  await assert.rejects(service.models({ cwd: "relative" }, f.context), /absolute/);
});
test("a chosen model is sent the way the SDK expects, after the host confirms it", async (t) => {
  const f = await fixture(t);
  const result = await f.service().import({ path: f.path, provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "high", cwd: f.home }, f.context);
  assert.equal(result.agentId, "new-restored-chat");
  const config = (f.created[0] as { config: { provider: string; model?: string; thinkingOptionId?: string; systemPrompt: string } }).config;
  assert.deepEqual([config.provider, config.model, config.thinkingOptionId], ["claude/claude-opus-5-5", undefined, "high"], "the SDK takes provider/model as one text, and the effort as its own field");
  assert.ok(config.systemPrompt.includes(f.content), "the conversation is still embedded");
  assert.deepEqual(f.catalog.calls, [{ cwd: f.home }]);
  // No effort chosen: none is sent, so the provider's own default applies.
  await f.service().import({ path: f.path, provider: "pi", model: "deepseek/deepseek-flash", cwd: f.home, requestId: "second" }, f.context);
  const second = (f.created[1] as { config: Record<string, unknown> }).config;
  assert.deepEqual([second.provider, "model" in second, "thinkingOptionId" in second], ["pi/deepseek/deepseek-flash", false, false], "a slash-style model id stays whole after the provider");
  // The model and effort are part of the retry key: the same attempt with another model is a different chat.
  await f.service().import({ path: f.path, provider: "pi", model: "deepseek/deepseek-v4-pro", cwd: f.home, requestId: "second" }, f.context);
  assert.notEqual((f.created[1] as { idempotencyKey: string }).idempotencyKey, (f.created[2] as { idempotencyKey: string }).idempotencyKey);
});
test("a provider that is disabled, unready, or missing the model is refused before anything is created", async (t) => {
  const f = await fixture(t);
  const service = f.service();
  const attempts: Array<[Parameters<typeof service.import>[0], RegExp]> = [
    [{ path: f.path, provider: "opencode", model: "opencode-go/deepseek-v4.1-flash", cwd: f.home }, /opencode provider is not enabled or not ready on this host, so the chat was not restored/],
    [{ path: f.path, provider: "codex", model: "gpt", cwd: f.home }, /codex provider is not enabled or not ready/],
    [{ path: f.path, provider: "claude", model: "claude-opus-4", cwd: f.home }, /Claude does not offer a model called claude-opus-4/],
    [{ path: f.path, provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "extreme", cwd: f.home }, /no effort level called extreme/],
  ];
  for (const [input, message] of attempts) await assert.rejects(service.import(input, f.context), message);
  assert.deepEqual(f.created, [], "no chat was created");
  assert.deepEqual(f.workspaceCalls.created, [], "and no workspace either");
});
test("restoring waits for the host to finish discovering the chosen provider", async (t) => {
  const f = await fixture(t);
  f.catalog.snapshots = [compactSnapshot({ claudeStatus: "loading" }), compactSnapshot({ claudeStatus: "loading" }), compactSnapshot()];
  const result = await f.service().import({ path: f.path, provider: "claude", model: "claude-sonnet-5-5", cwd: f.home }, f.context);
  assert.equal(result.agentId, "new-restored-chat");
  assert.equal(f.catalog.calls.length, 3, "it read again until the provider was ready");
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
