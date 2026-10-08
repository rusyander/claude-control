import type {
  ChatEscalationsView,
  ChatEscalationEntry,
} from '@agentdeck/contracts/chat-group-settings';

/** Непрочитанные заметки главного чата по любому из его ключей, без повторов. */
export function unreadEscalations(
  view: ChatEscalationsView | undefined,
  keys: readonly (string | undefined)[],
): ChatEscalationEntry[] {
  if (!view) return [];
  const seen = new Set<string>();
  const out: ChatEscalationEntry[] = [];
  for (const key of keys) {
    for (const entry of (key && view.chats[key]) || []) {
      if (entry.read || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}
