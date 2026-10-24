import type {
  ChatWatchSignalsResponse,
  GroupSignal,
  GroupSignalSeverity,
} from '@agentdeck/contracts/group-watch';

const RANK: Record<GroupSignalSeverity, number> = { info: 0, warn: 1, alert: 2 };

/**
 * Сигналы одиночного чата по любому из его ключей (id чата и id сессии): сторож
 * пишет под тем, что знал при старте прогона, а страница знает оба. Один сигнал
 * под двумя ключами показывается один раз.
 */
export function watchSignalsOf(
  view: ChatWatchSignalsResponse | undefined,
  keys: readonly (string | undefined)[],
): GroupSignal[] {
  if (!view) return [];
  const seen = new Set<string>();
  const out: GroupSignal[] = [];
  for (const key of keys) {
    for (const signal of (key && view.signals[key]) || []) {
      if (seen.has(signal.id)) continue;
      seen.add(signal.id);
      out.push(signal);
    }
  }
  return out;
}

/** Самый важный уровень среди сигналов; пусто — нет уровня. */
export function topSeverity(signals: readonly GroupSignal[]): GroupSignalSeverity | undefined {
  return signals.reduce<GroupSignalSeverity | undefined>(
    (worst, signal) =>
      worst === undefined || RANK[signal.severity] > RANK[worst] ? signal.severity : worst,
    undefined,
  );
}
