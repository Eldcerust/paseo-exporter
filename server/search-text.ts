import type { ExportFormat } from "../shared/export";

// What gets searched is the conversation: what you wrote, what the assistant answered, task lists,
// errors and notices, and for each tool call its name and what it was asked to do (the command, file
// path or query). Tool output, file contents, diffs and reasoning are left out on purpose. On real
// chats they were about 96% of the exported text, so indexing them made the index five times larger
// and let every file dump and log match common words.
export const MAX_INDEXED_CHARS = 1_000_000;
// How much of a tool call is kept: the command or path, not what came back.
export const TOOL_CHARS = 200;
// Fields of a tool call's detail that hold what came back or what changed, not what was asked for.
const BULKY_DETAIL_KEYS = new Set(["type", "output", "metadata", "content", "oldString", "newString", "unifiedDiff", "diff", "patch", "result", "stdout", "stderr", "text"]);
// Control characters other than tab and newlines. This also removes the two snippet marker characters.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

export const cleanText = (value: string) => value.replace(CONTROL, " ");
const str = (value: unknown) => (typeof value === "string" ? value : "");

function gather(value: unknown, out: string[], left: { chars: number }, depth = 0) {
  if (left.chars <= 0 || depth > 4) return;
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    if (text) { out.push(text.slice(0, left.chars)); left.chars -= text.length + 1; }
  } else if (Array.isArray(value)) for (const entry of value) gather(entry, out, left, depth + 1);
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) if (!BULKY_DETAIL_KEYS.has(key)) gather(entry, out, left, depth + 1);
  }
}
/** What a tool call was asked to do, as plain words: its command, file path, query. Never its output. */
export function toolDetailText(detail: unknown) {
  const out: string[] = [];
  gather(detail, out, { chars: TOOL_CHARS });
  return out.join(" ").slice(0, TOOL_CHARS);
}
const toolText = (name: string, detail: string) => `Tool ${name}: ${detail}`.trimEnd();

/** One timeline item as searchable text, or null when it is not part of the conversation. */
export function itemText(source: object): string | null {
  // Timeline items are typed per kind, so they are read loosely here: anything unexpected is simply skipped.
  const item = source as Record<string, unknown>;
  switch (item.type) {
    case "user_message": return `User: ${str(item.text)}`;
    case "assistant_message": return `Assistant: ${str(item.text)}`;
    case "todo": return Array.isArray(item.items) ? `Tasks: ${item.items.map((task) => str((task as { text?: unknown })?.text)).filter(Boolean).join("; ")}` : null;
    case "error": return `Error: ${str(item.message)}`;
    case "notification": return `Notice: ${str(item.message)}`;
    case "tool_call": return toolText(str(item.name), toolDetailText(item.detail));
    default: return null;
  }
}

/** The searchable text of a conversation: the items that carry text, one paragraph each, capped in size. */
export function conversationText(items: Iterable<object | null | undefined>) {
  const parts: string[] = [];
  for (const item of items) {
    const text = item && typeof item === "object" ? itemText(item) : null;
    if (text?.trim()) parts.push(text);
  }
  return cleanText(parts.join("\n\n")).slice(0, MAX_INDEXED_CHARS);
}

// A Markdown export is a header, then one "## N. Role" section per entry, separated by "---" lines.
// Only the role sections are read, so the header every export shares (session table, disclaimer,
// option line) is never part of the searchable text.
function markdownText(raw: string) {
  const parts: string[] = [];
  for (const section of raw.replace(/\r\n/g, "\n").split(/\n---\n\n(?=## \d+\. )/)) {
    const match = /^\s*## \d+\. ([^\n]*)\n*([\s\S]*)$/.exec(section);
    if (!match) continue;
    const [, role, text] = match;
    if (role === "User" || role === "Assistant" || role === "Tasks" || role === "Error") parts.push(`${role}: ${text.trim()}`);
    else if (role.startsWith("Notice")) parts.push(`Notice: ${text.trim()}`);
    else if (role.startsWith("Tool: ")) {
      // The call's detail is the fenced JSON block of the section.
      const fenced = /(`{3,})json\n([\s\S]*?)\n\1/.exec(text)?.[2];
      let detail = "";
      try { detail = toolDetailText(JSON.parse(fenced ?? "null")); } catch { /* an unreadable block adds nothing but the tool name */ }
      parts.push(toolText(role.slice("Tool: ".length), detail));
    }
    // Reasoning, plugin receipts, compaction and other events are not conversation.
  }
  return cleanText(parts.join("\n\n")).slice(0, MAX_INDEXED_CHARS);
}

/** The searchable text of a saved export. The fixed header every export shares is never part of it. */
export function searchableBody(content: string, format: ExportFormat) {
  if (format === "markdown") return markdownText(content);
  try {
    const { entries } = JSON.parse(content) as { entries?: Array<{ item?: { type?: unknown } } | null> };
    return conversationText((entries ?? []).map((entry) => entry?.item));
  } catch { return cleanText(content).slice(0, MAX_INDEXED_CHARS); }
}
