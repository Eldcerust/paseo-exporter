import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ProviderChoice } from "../shared/models";

type Paseo = PluginHandlerContext["paseo"];
type Snapshot = Awaited<ReturnType<Paseo["providers"]["snapshot"]>>;

// The daemon reports providers in wire form: `entries` is empty and the catalog sits in
// `compactSnapshot`, where each model points into a shared table of thinking-option sets. Rebuild the
// plain `entries` so the rest of the code sees one shape.
export function expandCatalog(snapshot: Snapshot): Snapshot {
  const compact = snapshot.compactSnapshot;
  if (!compact || snapshot.entries.length) return snapshot;
  const entries = compact.entries.map(({ models: compactModels, ...entry }) => {
    if (!compactModels) return entry;
    const models = compactModels.map(({ thinkingSet, ...model }) => {
      if (thinkingSet === undefined) return { provider: entry.provider, ...model };
      const set = compact.thinkingSets[thinkingSet];
      if (!set) throw new RangeError(`Provider snapshot references missing thinking set ${thinkingSet}`);
      return { provider: entry.provider, ...model, thinkingOptions: set.options,
        ...(set.defaultOptionId !== undefined ? { defaultThinkingOptionId: set.defaultOptionId } : {}) };
    });
    return { ...entry, models };
  });
  return { ...snapshot, entries };
}

// The daemon discovers providers lazily per folder: the first read of a folder it has not scanned returns
// at once with every enabled provider `loading` and no models. That is not an answer yet.
export const isDiscovering = (snapshot: Snapshot, provider?: string) =>
  snapshot.entries.some((entry) => entry.enabled && entry.status === "loading" && (!provider || entry.provider === provider));

// A provider can be used only while it is enabled and ready.
export const availableProviders = (snapshot: Snapshot) => snapshot.entries.filter((entry) => entry.enabled && entry.status === "ready");

export const readCatalog = async (paseo: Paseo, cwd: string) => expandCatalog(await paseo.providers.snapshot({ cwd }));

/** The choices for the picker: only enabled, ready providers, and only models that can be selected. */
export function describeCatalog(snapshot: Snapshot): { discovering: boolean; providers: ProviderChoice[] } {
  return {
    discovering: isDiscovering(snapshot),
    providers: availableProviders(snapshot).map((provider) => ({
      id: provider.provider, label: provider.label ?? provider.provider,
      models: (provider.models ?? []).filter((model) => model.isSelectable !== false).map((model) => ({
        id: model.id, label: model.label, ...(model.description ? { description: model.description } : {}), isDefault: model.isDefault === true,
        efforts: (model.thinkingOptions ?? []).map((option) => ({ id: option.id, label: option.label, isDefault: option.id === model.defaultThinkingOptionId || option.isDefault === true })),
        ...(model.defaultThinkingOptionId ? { defaultEffortId: model.defaultThinkingOptionId } : {}),
      })),
    })).filter((provider) => provider.models.length),
  };
}

export interface CatalogTiming { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> }

/** Reads the catalog, waiting out the daemon's first-time discovery of `provider` (bounded), then returns what it has. */
export async function loadCatalog(paseo: Paseo, cwd: string, provider: string, { timeoutMs = 10_000, intervalMs = 400, sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }: CatalogTiming = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await readCatalog(paseo, cwd);
    if (!isDiscovering(snapshot, provider) || Date.now() >= deadline) return snapshot;
    await sleep(intervalMs);
  }
}

/**
 * Checks a chosen provider, model and effort against what the host offers right now, so a provider that
 * was disabled after the picker loaded fails here with a clear reason, before any workspace or chat exists.
 */
export async function resolveSelection(paseo: Paseo, cwd: string, input: { provider: string; model: string; thinkingOptionId?: string }, timing?: CatalogTiming) {
  const snapshot = await loadCatalog(paseo, cwd, input.provider, timing);
  const provider = availableProviders(snapshot).find((entry) => entry.provider === input.provider);
  if (!provider) throw new Error(`The ${input.provider} provider is not enabled or not ready on this host, so the chat was not restored. Choose another provider.`);
  const model = provider.models?.find((entry) => entry.id === input.model && entry.isSelectable !== false);
  if (!model) throw new Error(`${provider.label ?? provider.provider} does not offer a model called ${input.model}, so the chat was not restored. Choose one from the list.`);
  if (input.thinkingOptionId && !model.thinkingOptions?.some((option) => option.id === input.thinkingOptionId)) {
    throw new Error(`${model.label} has no effort level called ${input.thinkingOptionId}, so the chat was not restored. Choose one from the list.`);
  }
  return { provider: provider.provider, model: model.id, ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}) };
}
