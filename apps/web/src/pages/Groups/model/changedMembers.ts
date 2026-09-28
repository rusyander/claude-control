/**
 * Участник оригинала пары словами интерфейса: «скилл ticket-delivery», а не
 * ключ `skill:ticket-delivery`. У хука id — событие и хэш содержимого
 * (`PostToolUse:1a2b3c4d`); хэш человеку ничего не говорит, остаётся событие.
 */
export function changedMemberLabel(key: string, kindWord: (kind: string) => string): string {
  const at = key.indexOf(':');
  if (at <= 0) return key;
  const kind = key.slice(0, at);
  let id = key.slice(at + 1);
  if (kind === 'hook') id = id.replace(/:[0-9a-f]{8}$/, '');
  return `${kindWord(kind)} ${id}`;
}
