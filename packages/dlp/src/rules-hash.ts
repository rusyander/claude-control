import { createHash } from 'node:crypto';
import type { DlpRule } from '@agentdeck/contracts';

/**
 * Хэш набора правил маски: ядро кладёт его в регистрацию сеанса (`HopDlpPolicy.rulesHash`), хост
 * звеньев считает тот же хэш по правилам, которыми маскирует, и при расхождении отказывает.
 * Иначе ядро думало бы, что сеанс идёт под одним набором, а звено маскировало бы другим —
 * человек правил словарь, а запрос уходил по старому. Порядок правил значим (первое сработавшее
 * правило блокировки решает), поэтому он входит в хэш как есть.
 */
export function rulesHashOf(rules: readonly DlpRule[]): string {
  const canonical = rules.map((rule) =>
    Object.fromEntries(Object.entries(rule).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
