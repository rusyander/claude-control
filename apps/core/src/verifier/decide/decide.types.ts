import type { CheckRecord } from '@agentdeck/contracts/core/records';

/** Вердикт ключа по его записям (D§3.5): основание для повтора, повтора тестов или прогона. */
export type KeyVerdict =
  | { kind: 'none' }
  | { kind: 'green'; record: CheckRecord }
  | { kind: 'red'; record: CheckRecord }
  | { kind: 'flaky-unresolved'; record: CheckRecord };
