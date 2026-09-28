import type { Dictionary } from '../../shared/config/i18n';

/**
 * След вопроса, закрытого автономией чата, — одна строка на выбор. Живёт
 * отдельным модулем, потому что нужен двум лентам: потоковой и транскрипту.
 *
 * Пустой список — выбор есть, а разобрать его прогон не смог (не видел самого
 * вызова): вопрос всё равно закрыт, и строка говорит только это (F-132).
 */
export function autoPickText(
  picks: readonly { label: string }[],
  t: Pick<Dictionary, 'chat'>,
): string {
  if (picks.length === 0) return t.chat.autoPickUnparsed;
  return picks.map((pick) => t.chat.autoPick(pick.label)).join('\n');
}
