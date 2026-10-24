import type { TicketSeverity } from '@agentdeck/contracts/split-ticket-batch';

/**
 * Серьёзность находки → приоритет Jira ПО ИМЕНИ из списка этой установки.
 * Схемы приоритетов у команд свои («Highest», «Blocker», «Высокий»), поэтому
 * имена-кандидаты по порядку; ни одного нет в списке — приоритета нет, и
 * серьёзность уходит меткой `severity-<x>` и строкой в описании.
 */
const CANDIDATES: Record<TicketSeverity, readonly string[]> = {
  critical: ['critical', 'highest', 'blocker', 'urgent', 'критический', 'блокирующий', 'наивысший'],
  high: ['high', 'major', 'высокий', 'важный'],
  medium: ['medium', 'normal', 'средний', 'обычный', 'нормальный'],
  low: ['low', 'minor', 'lowest', 'trivial', 'низкий', 'незначительный', 'низший'],
};

/** Имя приоритета установки для серьёзности или `undefined`, если такого нет. */
export function priorityFor(
  severity: TicketSeverity,
  priorities: readonly string[],
): string | undefined {
  const byName = new Map(priorities.map((name) => [name.trim().toLowerCase(), name]));
  for (const candidate of CANDIDATES[severity]) {
    const found = byName.get(candidate);
    if (found) return found;
  }
  return undefined;
}
