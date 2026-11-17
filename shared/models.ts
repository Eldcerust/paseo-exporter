import { z } from "zod";

// The providers and models a restored chat can be created with, as the host reports them: only
// providers that are enabled and ready, only models that can be selected.
export const effortChoice = z.object({ id: z.string(), label: z.string(), isDefault: z.boolean() });
export const modelChoice = z.object({
  id: z.string(), label: z.string(), description: z.string().optional(), isDefault: z.boolean(),
  efforts: z.array(effortChoice), defaultEffortId: z.string().optional(),
});
export const providerChoice = z.object({ id: z.string(), label: z.string(), models: z.array(modelChoice) });
export type ModelChoice = z.infer<typeof modelChoice>;
export type ProviderChoice = z.infer<typeof providerChoice>;
export interface ModelSelection { provider: string; model: string; effort?: string }
export interface OriginalModel { provider: string; model: string | null }

// How many models one provider shows at once, so the picker never needs a scroll area of its own.
export const MODEL_LIST_LIMIT = 8;

/**
 * An export records the chat's provider and model as one text, `provider/model`, or just the provider.
 * Provider ids never contain a slash and model ids can (OpenCode and Pi prefix the upstream: `deepseek/…`),
 * so the first slash is the boundary.
 */
export function splitSelection(value: string): OriginalModel {
  const text = value.trim();
  const slash = text.indexOf("/");
  return slash < 1 || slash === text.length - 1 ? { provider: text, model: null } : { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

// Aggregator providers namespace model ids as "<upstream>/<model>" but label them without the upstream,
// so identical labels from different upstreams look the same. Show the upstream as a prefix.
export function modelLabel(id: string, label: string) {
  const slash = id.indexOf("/");
  if (slash < 1) return label;
  const upstream = id.slice(0, slash);
  return label.toLowerCase().startsWith(`${upstream.toLowerCase()}/`) ? label : `${upstream}/${label}`;
}

/** Providers narrowed to the models that match every word typed, ignoring case. Empty text keeps everything. */
export function filterProviders(providers: readonly ProviderChoice[], query: string): ProviderChoice[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...providers];
  return providers.flatMap((provider) => {
    const models = provider.models.filter((model) => {
      const text = `${provider.label} ${provider.id} ${model.label} ${model.id}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
    return models.length ? [{ ...provider, models }] : [];
  });
}

/** The models to list for a provider: the first `limit`, except that the selected model is never hidden beyond them. */
export function visibleModels(provider: ProviderChoice, selection: ModelSelection | null | undefined, limit: number): ModelChoice[] {
  const first = provider.models.slice(0, limit);
  const chosen = selection?.provider === provider.id ? provider.models.find((model) => model.id === selection.model) : undefined;
  return chosen && !first.includes(chosen) ? [chosen, ...first.slice(0, Math.max(0, limit - 1))] : first;
}

const defaultModel = (provider: ProviderChoice) => provider.models.find((model) => model.isDefault) ?? provider.models[0];
const nameOf = (provider: ProviderChoice | undefined, model: ModelChoice | undefined, fallback: string) =>
  provider && model ? `${provider.label} · ${modelLabel(model.id, model.label)}` : fallback;

/** A selection is only good while the provider and model are still offered. Returns it as-is, or null. */
export function validSelection(providers: readonly ProviderChoice[], selection: ModelSelection | null | undefined): ModelSelection | null {
  if (!selection) return null;
  const model = providers.find((provider) => provider.id === selection.provider)?.models.find((entry) => entry.id === selection.model);
  if (!model) return null;
  return selection.effort && !model.efforts.some((option) => option.id === selection.effort) ? { provider: selection.provider, model: selection.model } : selection;
}

/**
 * What to preselect for a restored chat. The model the chat was exported with, when it is still offered.
 * Otherwise the provider's own default model, and failing that the first available provider's, with a
 * note saying what was substituted and why, so a disabled or removed provider is never silently used.
 */
export function pickInitial(providers: readonly ProviderChoice[], original: OriginalModel): { selection: ModelSelection; note: string | null } | null {
  const same = providers.find((provider) => provider.id === original.provider);
  const exact = same?.models.find((model) => model.id === original.model);
  if (same && exact) return { selection: { provider: same.id, model: exact.id }, note: null };
  const asked = original.model ? `${original.provider}/${original.model}` : original.provider;
  if (same && defaultModel(same)) {
    const model = defaultModel(same)!;
    return { selection: { provider: same.id, model: model.id }, note: original.model
      ? `The chat was exported with ${asked}, which ${same.label} no longer offers. ${nameOf(same, model, "")} is selected instead.` : null };
  }
  const first = providers.find((provider) => defaultModel(provider));
  if (!first) return null;
  const model = defaultModel(first)!;
  return { selection: { provider: first.id, model: model.id },
    note: `The chat was exported with ${asked}, which is not enabled or not ready on this host. ${nameOf(first, model, "")} is selected instead.` };
}
