import {
  GROUP_SIGNALS_CAP,
  type GroupSignal,
  type GroupSignalSeverity,
  type GroupWatchRule,
} from '@agentdeck/contracts/group-watch';
import type { RuleHit } from './watch.types.ts';

/**
 * Попадания правил → сигналы на записи группы. Активный сигнал по паре
 * (правило, чат) один: повтор обновляет его числа, а не плодит строки. Условие
 * кончилось — сигнал закрыт (`clearedAt`) и остаётся свёрнутой строкой. Новые
 * первыми, потолок 20: уходят старые закрытые, активный — никогда.
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

/**
 * Чем ведает слияние. `rules` — правила, чьи сигналы оно поднимает и закрывает
 * (нет — все); `group` — сигнал один на группу, а не на чат (R8, R9): активный
 * ищется по правилу, `chatId` — лишь ссылка «открыть чат» на звено-источник.
 */
export interface MergeScope {
  rules?: ReadonlySet<GroupWatchRule>;
  group?: boolean;
}

export function mergeSignals(
  existing: readonly GroupSignal[],
  scope: SignalScope,
  hits: readonly RuleHit[],
  now: number,
  makeId: () => string,
  merge: MergeScope = {},
): MergedSignals {
  const iso = new Date(now).toISOString();
  const signals = existing.map((signal) => ({ ...signal }));
  const raised: GroupSignal[] = [];
  let structural = false;
  let numbers = false;
  const mine = (signal: GroupSignal): boolean =>
    !signal.clearedAt &&
    (merge.rules?.has(signal.rule) ?? true) &&
    (merge.group === true || signal.chatId === scope.chatId);

  for (const hit of hits) {
    const active = signals.find((signal) => mine(signal) && signal.rule === hit.rule);
    if (active) {
      // Сменилась только подстановка (другая команда, другой файл) — тоже правка строки на записи.
      if (
        !sameNumbers(active.numbers, hit.numbers) ||
        (hit.params && !sameValues(active.params ?? {}, hit.params))
      )
        numbers = true;
      active.numbers = hit.numbers;
      if (hit.params) active.params = hit.params;
      // Важность выросла (вопрос висит дольше `askAlertMinutes`) — тот же сигнал, но снова
      // кандидат наружу: «внимание» ушло один раз, а ночь у карточки — уже тревога (C02).
      // Вниз не идёт: тревога держится, пока условие не кончится.
      if (RANK[hit.severity] > RANK[active.severity]) {
        active.severity = hit.severity;
        raised.push(active);
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
    if (!mine(signal) || live.has(signal.rule)) continue;
    signal.clearedAt = iso;
    structural = true;
  }

  return { signals: capSignals(signals), raised, structural, numbers };
}

/**
 * Новые первыми; сверх потолка уходят закрытые, старые первыми. Активный не
 * вытесняется никогда: следующая оценка не нашла бы его и подняла заново под
 * новым id — с записью на каждом событии. Активных и так немного: правило на чат.
 */
export function capSignals(signals: readonly GroupSignal[]): GroupSignal[] {
  const sorted = [...signals].sort((left, right) => right.at.localeCompare(left.at));
  while (sorted.length > GROUP_SIGNALS_CAP) {
    const cleared = sorted.findLastIndex((signal) => Boolean(signal.clearedAt));
    if (cleared === -1) break;
    sorted.splice(cleared, 1);
  }
  return sorted;
}

/**
 * Закрыть активные сигналы чата — звено закончилось, следить больше не за чем.
 * `rules` — только эти правила (сигналы группы R8/R9 закрывает её же оценка).
 */
export function clearChatSignals(
  existing: readonly GroupSignal[],
  chatId: string,
  now: number,
  rules?: ReadonlySet<GroupWatchRule>,
): { signals: GroupSignal[]; changed: boolean } {
  const iso = new Date(now).toISOString();
  let changed = false;
  const signals = existing.map((signal) => {
    if (signal.clearedAt || signal.chatId !== chatId || !(rules?.has(signal.rule) ?? true))
      return signal;
    changed = true;
    return { ...signal, clearedAt: iso };
  });
  return { signals, changed };
}

const RANK: Record<GroupSignalSeverity, number> = { info: 0, warn: 1, alert: 2 };

/**
 * Кому из поднятых сигналов идти наружу (Telegram, вебхук): только «внимание»
 * и «тревога»; повтор того же ключа — когда прошёл срок тишины или важность
 * выросла с прошлой отправки (внимание → тревога идёт сразу). `sent` — память
 * отправленного (ключ → когда и с какой важностью), правится здесь.
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
    const escalated = previous !== undefined && RANK[signal.severity] > RANK[previous.severity];
    if (previous && !escalated && now - previous.at < cooldownMs) continue;
    sent.set(key, { at: now, severity: signal.severity });
    out.push(signal);
  }
  return out;
}
