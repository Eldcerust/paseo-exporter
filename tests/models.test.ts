import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { availableProviders, describeCatalog, expandCatalog, isDiscovering, loadCatalog, resolveSelection } from "../server/catalog";
import { filterProviders, MODEL_LIST_LIMIT, modelLabel, pickInitial, splitSelection, validSelection, visibleModels, type ProviderChoice } from "../shared/models";
import { listArchiveModels } from "../shared/archive-files";
import { compactSnapshot } from "./catalog-fixture";

const paseoWith = (...snapshots: unknown[]) => {
  let calls = 0;
  const paseo = { providers: { snapshot: async () => snapshots[Math.min(calls++, snapshots.length - 1)] } } as unknown as PluginHandlerContext["paseo"];
  return { paseo, calls: () => calls };
};
const snapshot = () => expandCatalog(compactSnapshot() as never);
const noWait = { intervalMs: 0, sleep: async () => {} };
const choice = (id: string, label: string, models: Array<[string, string, boolean?]>): ProviderChoice => ({
  id, label, models: models.map(([modelId, modelName, isDefault]) => ({ id: modelId, label: modelName, isDefault: isDefault === true, efforts: [] })),
});

test("catalog: the daemon's compact wire form is expanded, and only enabled, ready providers are offered", () => {
  const expanded = snapshot();
  assert.deepEqual(expanded.entries.map((entry) => entry.provider), ["claude", "pi", "opencode", "codex"]);
  assert.deepEqual(availableProviders(expanded).map((entry) => entry.provider), ["claude", "pi"], "disabled OpenCode and unready Codex are not available");
  const { providers, discovering } = describeCatalog(expanded);
  assert.equal(discovering, false);
  assert.deepEqual(providers.map((provider) => [provider.id, provider.label, provider.models.map((model) => model.id)]), [
    ["claude", "Claude", ["claude-opus-5-5", "claude-sonnet-5-5"]],
    ["pi", "Pi", ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]],
  ], "a model that is not selectable is not offered");
  const opus = providers[0].models[0];
  assert.deepEqual([opus.isDefault, opus.defaultEffortId], [true, "medium"]);
  assert.deepEqual(opus.efforts, [{ id: "low", label: "Low", isDefault: false }, { id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High", isDefault: false }]);
  assert.deepEqual(providers[1].models[0].efforts, [], "a model without an effort table has no effort choices");
  assert.deepEqual(listArchiveModels.output.parse({ discovering, providers }), { discovering, providers });
  assert.equal(expandCatalog(expanded), expanded, "an already plain snapshot is left alone");
  assert.throws(() => expandCatalog({ ...compactSnapshot(), compactSnapshot: { ...compactSnapshot().compactSnapshot, thinkingSets: [] } } as never), /missing thinking set/);
});

test("catalog: a folder the host is still scanning is reported as discovering, not as empty", () => {
  const scanning = expandCatalog(compactSnapshot({ claudeStatus: "loading" }) as never);
  assert.equal(isDiscovering(scanning), true);
  assert.equal(isDiscovering(scanning, "pi"), false, "only the provider being waited for counts");
  assert.equal(describeCatalog(scanning).discovering, true);
});

test("catalog: loading waits for the chosen provider to be discovered, within a limit", async () => {
  const slow = paseoWith(compactSnapshot({ claudeStatus: "loading" }), compactSnapshot({ claudeStatus: "loading" }), compactSnapshot());
  assert.equal(availableProviders(await loadCatalog(slow.paseo, "C:/p", "claude", noWait)).length, 2);
  assert.equal(slow.calls(), 3);
  const stuck = paseoWith(compactSnapshot({ claudeStatus: "loading" }));
  const result = await loadCatalog(stuck.paseo, "C:/p", "claude", { ...noWait, timeoutMs: 0 });
  assert.equal(isDiscovering(result, "claude"), true, "it gives up and returns what it has");
  assert.equal(stuck.calls(), 1);
});

test("catalog: a chosen provider, model and effort are checked against what the host offers", async () => {
  const { paseo } = paseoWith(compactSnapshot());
  assert.deepEqual(await resolveSelection(paseo, "C:/p", { provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "high" }, noWait),
    { provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "high" });
  assert.deepEqual(await resolveSelection(paseo, "C:/p", { provider: "pi", model: "deepseek/deepseek-flash" }, noWait), { provider: "pi", model: "deepseek/deepseek-flash" });
  await assert.rejects(resolveSelection(paseo, "C:/p", { provider: "opencode", model: "opencode-go/deepseek-v4.1-flash" }, noWait), /opencode provider is not enabled or not ready.*not restored.*another provider/);
  await assert.rejects(resolveSelection(paseo, "C:/p", { provider: "codex", model: "x" }, noWait), /codex provider is not enabled or not ready/);
  await assert.rejects(resolveSelection(paseo, "C:/p", { provider: "claude", model: "claude-opus-4" }, noWait), /Claude does not offer a model called claude-opus-4/);
  await assert.rejects(resolveSelection(paseo, "C:/p", { provider: "claude", model: "claude-hidden" }, noWait), /does not offer a model/);
  await assert.rejects(resolveSelection(paseo, "C:/p", { provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "extreme" }, noWait), /Opus 5\.5 has no effort level called extreme/);
  await assert.rejects(resolveSelection(paseo, "C:/p", { provider: "pi", model: "deepseek/deepseek-flash", thinkingOptionId: "high" }, noWait), /no effort level/, "a model without an effort table accepts none");
});

test("models: an export's provider and model text is split at the first slash", () => {
  assert.deepEqual(splitSelection("claude/claude-sonnet-5-5"), { provider: "claude", model: "claude-sonnet-5-5" });
  assert.deepEqual(splitSelection("opencode/opencode-go/deepseek-v4.1-flash"), { provider: "opencode", model: "opencode-go/deepseek-v4.1-flash" });
  assert.deepEqual(splitSelection("pi/deepseek/deepseek-flash"), { provider: "pi", model: "deepseek/deepseek-flash" });
  assert.deepEqual(splitSelection("claude"), { provider: "claude", model: null });
  assert.deepEqual(splitSelection("claude/"), { provider: "claude/", model: null });
  assert.deepEqual(splitSelection("/model"), { provider: "/model", model: null });
  assert.deepEqual(splitSelection("  pi/x  "), { provider: "pi", model: "x" });
});

test("models: labels, search, and the visible list", () => {
  assert.equal(modelLabel("deepseek/deepseek-flash", "DeepSeek V4.1 Flash"), "deepseek/DeepSeek V4.1 Flash", "the upstream is shown when the label omits it");
  assert.equal(modelLabel("deepseek/x", "DeepSeek/X"), "DeepSeek/X");
  assert.equal(modelLabel("claude-opus-5-5", "Opus 5.5"), "Opus 5.5");
  const providers = [choice("claude", "Claude", [["opus", "Opus 5.5"], ["sonnet", "Sonnet 5.5"]]), choice("pi", "Pi", [["deepseek/flash", "DeepSeek Flash"], ["openai/gpt", "GPT 5.5"]])];
  assert.deepEqual(filterProviders(providers, "").map((provider) => provider.id), ["claude", "pi"]);
  assert.deepEqual(filterProviders(providers, "  SONNET ").map((provider) => [provider.id, provider.models.map((model) => model.id)]), [["claude", ["sonnet"]]]);
  assert.deepEqual(filterProviders(providers, "pi flash").map((provider) => provider.models.map((model) => model.id)), [["deepseek/flash"]], "every word must match, including the provider name");
  assert.deepEqual(filterProviders(providers, "zzz"), []);

  const many = choice("pi", "Pi", Array.from({ length: 20 }, (_, i) => [`m${i}`, `Model ${i}`] as [string, string]));
  assert.deepEqual(visibleModels(many, null, MODEL_LIST_LIMIT).map((model) => model.id), Array.from({ length: MODEL_LIST_LIMIT }, (_, i) => `m${i}`));
  const pinned = visibleModels(many, { provider: "pi", model: "m15" }, MODEL_LIST_LIMIT).map((model) => model.id);
  assert.equal(pinned.length, MODEL_LIST_LIMIT);
  assert.equal(pinned[0], "m15", "a selected model beyond the limit is never hidden");
  assert.deepEqual(visibleModels(many, { provider: "claude", model: "m15" }, MODEL_LIST_LIMIT).length, MODEL_LIST_LIMIT, "another provider's selection changes nothing");
});

test("models: what is preselected, and why a substitute is explained", () => {
  const providers = [
    { ...choice("claude", "Claude", [["claude-opus-5-5", "Opus 5.5", true], ["claude-sonnet-5-5", "Sonnet 5.5"]]) },
    { ...choice("pi", "Pi", [["deepseek/deepseek-flash", "DeepSeek V4.1 Flash"], ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", true]]) },
  ];
  assert.deepEqual(pickInitial(providers, { provider: "claude", model: "claude-sonnet-5-5" }), { selection: { provider: "claude", model: "claude-sonnet-5-5" }, note: null }, "the exported model, when offered");
  const retired = pickInitial(providers, { provider: "claude", model: "claude-sonnet-3" })!;
  assert.deepEqual(retired.selection, { provider: "claude", model: "claude-opus-5-5" }, "the provider's own default when the exported model is gone");
  assert.match(retired.note!, /exported with claude\/claude-sonnet-3, which Claude no longer offers\. Claude · Opus 5\.5 is selected instead/);
  const disabled = pickInitial(providers, { provider: "opencode", model: "opencode-go/deepseek-v4.1-flash" })!;
  assert.deepEqual(disabled.selection, { provider: "claude", model: "claude-opus-5-5" }, "the first available provider when the exported one is off");
  assert.match(disabled.note!, /exported with opencode\/opencode-go\/deepseek-v4\.1-flash, which is not enabled or not ready on this host\. Claude · Opus 5\.5 is selected instead/);
  assert.equal(pickInitial(providers, { provider: "pi", model: null })!.selection.model, "deepseek/deepseek-v4-pro", "a provider-only export gets that provider's default, silently");
  assert.equal(pickInitial(providers, { provider: "pi", model: null })!.note, null);
  assert.equal(pickInitial([], { provider: "claude", model: "x" }), null, "with nothing offered there is nothing to preselect");
  assert.equal(pickInitial([choice("pi", "Pi", [])], { provider: "pi", model: "x" }), null);

  assert.deepEqual(validSelection(providers, { provider: "pi", model: "deepseek/deepseek-flash" }), { provider: "pi", model: "deepseek/deepseek-flash" });
  assert.equal(validSelection(providers, { provider: "opencode", model: "x" }), null, "a pick that is no longer offered is dropped");
  assert.equal(validSelection(providers, null), null);
  const withEffort = [{ id: "claude", label: "Claude", models: [{ id: "m", label: "M", isDefault: true, efforts: [{ id: "high", label: "High", isDefault: false }] }] }];
  assert.deepEqual(validSelection(withEffort, { provider: "claude", model: "m", effort: "high" }), { provider: "claude", model: "m", effort: "high" });
  assert.deepEqual(validSelection(withEffort, { provider: "claude", model: "m", effort: "gone" }), { provider: "claude", model: "m" }, "an effort the model lacks is dropped, the model kept");
});
