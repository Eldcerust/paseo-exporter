import { useEffect, useState } from "react";
import { Text } from "react-native";
import { snippetParts } from "../shared/search";

/** The value once it has stopped changing for `delayMs`, so a search runs per pause rather than per key. */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/** The passage around a text match, with each matched word emphasised. */
export function Snippet({ text, color, highlight }: { text: string; color: string; highlight: string }) {
  return <Text selectable style={{ color, fontSize: 12 }}>
    {snippetParts(text.replace(/\s+/g, " ")).map((part, index) => <Text key={index} style={part.match ? { color: highlight, fontWeight: "700" } : undefined}>{part.text}</Text>)}
  </Text>;
}
