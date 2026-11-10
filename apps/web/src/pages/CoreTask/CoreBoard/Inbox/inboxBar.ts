import { INBOX_DEFAULTS, type InboxSection } from '@agentdeck/contracts/core/inbox';

/** Сводка строки над доской: сколько источников, сколько выключено и ставят в очередь сами. */
export interface InboxSummary {
  total: number;
  off: number;
  auto: number;
  pollMinutes: number;
}

/** Сводка из раздела `inbox`; раздела нет — источников нет, частота — умолчание ядра. */
export function inboxSummary(section: InboxSection | undefined): InboxSummary {
  const sources = section?.sources ?? [];
  return {
    total: sources.length,
    off: sources.filter((s) => !s.enabled).length,
    auto: sources.filter((s) => s.enabled && s.autoQueue === true).length,
    pollMinutes: (section?.pollMs ?? INBOX_DEFAULTS.pollMs) / 60_000,
  };
}
