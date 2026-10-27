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

/**
 * Серьёзность, когда её не назвал никто (модель недоступна или промолчала):
 * приоритет ставится у КАЖДОЙ задачи (владелец 25.10.2026), а «средняя» —
 * то, что Jira сама поставила бы по умолчанию, только теперь это видно в задаче.
 */
export const DEFAULT_SEVERITY: TicketSeverity = 'medium';

/**
 * Jira отвергла именно приоритет: поле не на экране создания проекта или имени
 * нет в схеме приоритетов проекта (список `/priority` — общий на установку, схема
 * у проекта может быть уже). Ответ Jira — `{"errors":{"priority":"…"}}` в подробности
 * отказа; по нему публикация повторяет заведение без приоритета, а не теряет задачу.
 */
export function priorityRejected(error: unknown): boolean {
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  if (typeof detail !== 'string' || !detail.trim()) return false;
  try {
    const parsed = JSON.parse(detail) as { errors?: Record<string, unknown> };
    return Boolean(
      parsed.errors && typeof parsed.errors === 'object' && 'priority' in parsed.errors,
    );
  } catch {
    // Хвост тела обрезан до 500 знаков — JSON может не собраться.
    return /"errors"\s*:\s*\{[^}]*"priority"\s*:/.test(detail);
  }
}

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
