import type { EnvItemKind, EnvNeeds } from '@agentdeck/contracts/portable-env';

/**
 * Порядок видов записи на экране — от того, что человек правит чаще всего, к
 * служебному. Алфавит здесь был бы честнее всего только к словарю: «команды»
 * оказались бы выше «инструкций», хотя открывают паспорт ради вторых.
 *
 * Список ПОЛНЫЙ по словарю канона: вид, забытый здесь, не исчезнет с экрана —
 * он уедет в конец (`kindOrder` возвращает длину списка), а не потеряется
 * молча. Потерять запись значило бы показать среду, которой нет.
 */
export const KIND_ORDER: readonly EnvItemKind[] = [
  'instructions',
  'skill',
  'command',
  'subagent',
  'hook',
  'permission',
  'mcpServer',
  'envVar',
  'secret',
  'plugin',
  'panelGroup',
  'conversation',
];

/** Ключ перевода названия вида. Вид без перевода показывает свой идентификатор. */
export function kindLabelKey(kind: EnvItemKind): string {
  return `portability.kind.${kind}`;
}

/**
 * Требования записи одной строкой: список фактов либо причина, по которой их
 * нет. «Ничего не нужно» и «определить не удалось» — РАЗНЫЕ вещи, и на экране
 * они обязаны читаться по-разному: из первого следует, что запись переедет
 * куда угодно, из второго — что переносить её вслепую нельзя.
 */
export function needsSummary(needs: EnvNeeds): { facts: readonly string[]; why: string | null } {
  if (needs.resolution === 'facts') return { facts: needs.facts, why: null };
  return { facts: [], why: needs.why };
}
