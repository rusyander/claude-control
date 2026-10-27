import type {
  GroupSignal,
  GroupSignalSeverity,
  GroupWatch,
  GroupWatchRule,
} from '@agentdeck/contracts/group-watch';

/**
 * Пауза сторожа на безопасной точке (F1 = B, 27.10): по желанию, выключена по
 * умолчанию. Сигнал правила «трата по кругу» у группы взводит паузу, а ставит её
 * конец хода — следующее звено не заводится. Сам сторож паузу не снимает, R43
 * напоминает о стоящей. Здесь — только решение: какое правило держит группу.
 *
 * Правила — те, где беда повторяется, пока группа идёт: проверка по кругу (R4),
 * расход группы (R8), сон — проверка (R11), перечитывание (R12), тяжёлые проверки
 * по кругу (R21), один и тот же сбой (R24), проверки мимо журнала (R41), тяжёлый
 * прогон (R42). Окно подписки (R9) — беда аккаунта, а не группы: пауза одной из
 * групп ничего бы не решила.
 */
export const AUTO_PAUSE_RULES: ReadonlySet<GroupWatchRule> = new Set<GroupWatchRule>([
  'R4',
  'R8',
  'R11',
  'R12',
  'R21',
  'R24',
  'R41',
  'R42',
]);

const RANK: Record<GroupSignalSeverity, number> = { info: 0, warn: 1, alert: 2 };

/**
 * Правило, по которому сторож ставит паузу группе на конце хода; нет — пауза не нужна.
 * Сторож выключен или пауза не включена — никогда. Из нескольких горящих — самое
 * важное, при равной важности — раньше сработавшее (его беда идёт дольше).
 */
export function autoPauseRule(
  settings: Pick<GroupWatch, 'enabled' | 'autoPause'>,
  signals: readonly GroupSignal[],
): GroupWatchRule | undefined {
  if (!settings.enabled || !settings.autoPause) return undefined;
  let best: GroupSignal | undefined;
  for (const signal of signals) {
    if (signal.clearedAt || !AUTO_PAUSE_RULES.has(signal.rule)) continue;
    if (
      !best ||
      RANK[signal.severity] > RANK[best.severity] ||
      (RANK[signal.severity] === RANK[best.severity] && signal.at < best.at)
    ) {
      best = signal;
    }
  }
  return best?.rule;
}
