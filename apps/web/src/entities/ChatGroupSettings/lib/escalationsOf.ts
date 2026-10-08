import type {
  ChatEscalationsView,
  ChatEscalationEntry,
} from '@agentdeck/contracts/chat-group-settings';

/** Заметки главного чата по любому из его ключей. */
export function escalationsOf(
  view: ChatEscalationsView | undefined,
  keys: readonly (string | undefined)[],
): ChatEscalationEntry[] {
  if (!view) return [];
  const seen = new Set<string>();
  const out: ChatEscalationEntry[] = [];
  for (const key of keys) {
    for (const entry of (key && view.chats[key]) || []) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}
