import {
  GROUP_SIGNALS_CAP,
  type GroupSignal,
  type GroupSignalSeverity,
} from '@agentdeck/contracts/group-watch';
import type { RuleHit } from './watch.types.ts';

/**
 * Попадания правил → сигналы на записи группы. Активный сигнал по паре
 * (правило, чат) один: повтор обновляет его числа, а не плодит строки. Условие
 * кончилось — сигнал закрыт (`clearedAt`) и остаётся свёрнутой строкой. Новые
 * первыми, потолок 20: уходят старые закрытые, потом старые вообще.
 */

export interface SignalScope {
  chatId: string;
  groupIndex: number;
  stage?: string;
}

export interface MergedSignals {
  signals: GroupSignal[];
  /** Сигналы, впервые ставшие активными, — кандидаты в уведомление. */
  raised: GroupSignal[];
  /** Поменялся состав (новый, закрытый) — запись сохраняется сразу. */
  structural: boolean;
  /** Поменялись только числа активных — сохраняется на тике, не на каждом событии. */
  numbers: boolean;
}

const sameValues = <T>(left: Record<string, T>, right: Record<string, T>): boolean => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
};
const sameNumbers = sameValues<number>;

export function mergeSignals(
  existing: readonly GroupSignal[],
  scope: SignalScope,
  hits: readonly RuleHit[],
  now: number,
  makeId: () => string,
): MergedSignals {
  const iso = new Date(now).toISOString();
  const signals = existing.map((signal) => ({ ...signal }));
  const raised: GroupSignal[] = [];
  let structural = false;
  let numbers = false;

  for (const hit of hits) {
    const active = signals.find(
      (signal) => !signal.clearedAt && signal.rule === hit.rule && signal.chatId === scope.chatId,
    );
    if (active) {
      // Сменилась только подстановка (другая команда, другой файл) — тоже правка строки на записи.
      if (
        !sameNumbers(active.numbers, hit.numbers) ||
        (hit.params && !sameValues(active.params ?? {}, hit.params))
      )
        numbers = true;
      active.numbers = hit.numbers;
      if (hit.params) active.params = hit.params;
      if (active.severity !== hit.severity) {
        active.severity = hit.severity;
        structural = true;
      }
      continue;
    }
    const signal: GroupSignal = {
      id: makeId(),
      rule: hit.rule,
      severity: hit.severity,
      groupIndex: scope.groupIndex,
      chatId: scope.chatId,
      ...(scope.stage ? { stage: scope.stage } : {}),
      // Битое время повода — «сейчас»: `toISOString` от NaN бросает и роняет весь тик.
      at: new Date(Number.isFinite(hit.since) ? Math.min(hit.since, now) : now).toISOString(),
      numbers: hit.numbers,
      textKey: `groupWatch.rule.${hit.rule}`,
      ...(hit.params ? { params: hit.params } : {}),
    };
    signals.push(signal);
    raised.push(signal);
    structural = true;
  }

  const live = new Set(hits.map((hit) => hit.rule));
  for (const signal of signals) {
    if (signal.clearedAt || signal.chatId !== scope.chatId || live.has(signal.rule)) continue;
    signal.clearedAt = iso;
    structural = true;
  }

  return { signals: capSignals(signals), raised, structural, numbers };
}

/** Новые первыми; сверх потолка уходят сначала старые закрытые. */
export function capSignals(signals: readonly GroupSignal[]): GroupSignal[] {
  const sorted = [...signals].sort((left, right) => right.at.localeCompare(left.at));
  while (sorted.length > GROUP_SIGNALS_CAP) {
    const cleared = sorted.findLastIndex((signal) => Boolean(signal.clearedAt));
    sorted.splice(cleared === -1 ? sorted.length - 1 : cleared, 1);
  }
  return sorted;
}

/** Закрыть активные сигналы чата — звено закончилось, следить больше не за чем. */
export function clearChatSignals(
  existing: readonly GroupSignal[],
  chatId: string,
  now: number,
): { signals: GroupSignal[]; changed: boolean } {
  const iso = new Date(now).toISOString();
  let changed = false;
  const signals = existing.map((signal) => {
    if (signal.clearedAt || signal.chatId !== chatId) return signal;
    changed = true;
    return { ...signal, clearedAt: iso };
  });
  return { signals, changed };
}

const RANK: Record<GroupSignalSeverity, number> = { info: 0, warn: 1, alert: 2 };

/**
 * Кому из поднятых сигналов идти в Telegram: только «внимание» и «тревога»;
 * повтор того же ключа — когда важность выросла или прошёл срок тишины.
 * `sent` — память отправленного (ключ → когда и с какой важностью), правится здесь.
 */
export function signalsToNotify(
  raised: readonly GroupSignal[],
  keyOf: (signal: GroupSignal) => string,
  sent: Map<string, { at: number; severity: GroupSignalSeverity }>,
  cooldownMs: number,
  now: number,
): GroupSignal[] {
  const out: GroupSignal[] = [];
  for (const signal of raised) {
    if (RANK[signal.severity] < RANK.warn) continue;
    const key = keyOf(signal);
    const previous = sent.get(key);
    const rose = previous && RANK[signal.severity] > RANK[previous.severity];
    if (previous && !rose && now - previous.at < cooldownMs) continue;
    sent.set(key, { at: now, severity: signal.severity });
    out.push(signal);
  }
  return out;
}
