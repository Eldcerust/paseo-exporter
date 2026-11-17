import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { filterProviders, MODEL_LIST_LIMIT, modelLabel, visibleModels, type ModelSelection, type OriginalModel, type ProviderChoice } from "../shared/models";

export interface ModelPickerProps {
  providers: readonly ProviderChoice[];
  /** The host is still scanning providers for this folder, or the first answer has not arrived. */
  loading: boolean;
  error?: string;
  onRetry(): void;
  /** What the chat was exported with, so that model can be marked. */
  original: OriginalModel;
  selection: ModelSelection | null;
  /** Why the preselected model differs from the exported one, when it does. */
  note: string | null;
  onChange(selection: ModelSelection): void;
  disabled?: boolean;
  theme: { colors: Record<string, string> };
}

/**
 * Chooses the provider and model for a restored chat from what the host actually offers: providers that are
 * enabled and ready, with their real models. Nothing is typed in, so a disabled or misspelled provider cannot
 * be chosen. The list shows a few models at a time, so there is no scroll area of its own inside the page.
 */
export function ModelPicker({ providers, loading, error, onRetry, original, selection, note, onChange, disabled = false, theme }: ModelPickerProps) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<string>();
  const colors = theme.colors;
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted, fontSize: 12 };
  const matching = filterProviders(providers, search);
  const active = matching.find((provider) => provider.id === tab) ?? matching.find((provider) => provider.id === selection?.provider) ?? matching[0];
  const shown = active ? visibleModels(active, selection, MODEL_LIST_LIMIT) : [];
  const hidden = active ? active.models.length - shown.length : 0;
  const chosen = providers.find((provider) => provider.id === selection?.provider)?.models.find((model) => model.id === selection?.model);
  const chosenProvider = providers.find((provider) => provider.id === selection?.provider);
  function choice(label: string, selected: boolean, onPress: () => void, accessibilityLabel = label) {
    return <Pressable key={accessibilityLabel} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
      style={{ paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: selected ? colors.accent : colors.surface1, backgroundColor: colors.surface1, opacity: disabled ? 0.5 : 1 }}>
      <Text numberOfLines={1} style={{ color: selected ? colors.accent : colors.foreground, fontSize: 13, fontWeight: selected ? "600" : "400" }}>{selected ? "✓ " : ""}{label}</Text>
    </Pressable>;
  }
  return <View style={{ gap: 8 }}>
    <Text style={{ ...text, fontWeight: "600" }}>Provider and model for the restored chat</Text>
    <Text style={muted}>Only providers that are enabled and ready on this host are listed.</Text>
    {!!note && <Text accessibilityLiveRegion="polite" style={{ ...text, fontSize: 12 }}>{note}</Text>}
    {!!error && <Text accessibilityRole="alert" selectable style={text}>{error}</Text>}
    {!!error && choice("Retry loading providers", false, onRetry)}
    {loading && !providers.length && !error && <Text style={muted}>Loading providers…</Text>}
    {!loading && !error && !providers.length && <Text style={muted}>No enabled, available models were reported for this folder. Enable a provider in Paseo, then retry.</Text>}
    {!!providers.length && <>
      <TextInput accessibilityLabel="Search models" value={search} onChangeText={setSearch} editable={!disabled} autoCapitalize="none" autoCorrect={false}
        placeholder="Search models" placeholderTextColor={colors.foregroundMuted} style={{ ...text, padding: 12, backgroundColor: colors.surface1, borderRadius: 8 }} />
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {matching.map((provider) => choice(`${provider.label} · ${provider.models.length}`, provider.id === active?.id, () => setTab(provider.id), `${provider.label}, ${provider.models.length} ${provider.models.length === 1 ? "model" : "models"}`))}
      </View>
      {!matching.length && <Text style={muted}>No models match “{search.trim()}”.</Text>}
      <View style={{ gap: 6 }}>
        {active && shown.map((model) => {
          const exported = active.id === original.provider && model.id === original.model;
          const label = `${modelLabel(model.id, model.label)}${exported ? " (exported with this)" : ""}`;
          return choice(label, selection?.provider === active.id && selection.model === model.id, () => onChange({ provider: active.id, model: model.id }));
        })}
      </View>
      {hidden > 0 && <Text style={muted}>+{hidden} more. Search to narrow.</Text>}
      {!!chosen?.efforts.length && <View style={{ gap: 6 }}>
        <Text style={{ ...text, fontSize: 12, fontWeight: "600" }}>Effort</Text>
        <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {choice("Provider default", !selection?.effort, () => onChange({ provider: selection!.provider, model: selection!.model }), "Effort: Provider default")}
          {chosen.efforts.map((option) => choice(option.label, selection?.effort === option.id, () => onChange({ provider: selection!.provider, model: selection!.model, effort: option.id }), `Effort: ${option.label}`))}
        </View>
      </View>}
      {!!selection && !!chosen && <Text selectable style={muted}>The restored chat will use {chosenProvider?.label ?? selection.provider} · {modelLabel(chosen.id, chosen.label)}{selection.effort ? ` · ${chosen.efforts.find((option) => option.id === selection.effort)?.label ?? selection.effort} effort` : ""}.</Text>}
    </>}
  </View>;
}
