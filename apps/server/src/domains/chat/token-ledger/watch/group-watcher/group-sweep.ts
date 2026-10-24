import type { GroupWatch } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../../lib/app-store/app-store.types.ts';
import { groupDeliverAhead } from '../../../split-conveyor/split-conveyor.ts';
import { groupKeyOf } from '../group-ledgers.ts';
import { clip, MINUTE_MS, minutes } from '../rules-util.ts';
import type { RuleHit } from '../watch.types.ts';
import type { GroupLive } from './group-watcher.types.ts';
import { TERMINAL } from './timing.ts';

/**
 * Правила группы, не сессии (A5): R22 — группа стоит без хода, R28 — напоминания о
 * доставке её не двигают. Чистая функция над записями разделения и памятью сторожа:
 * сессии группы может не быть вовсе (её забыли после тишины, панель перезапускалась) —
 * именно тогда R22 и нужен.
 */

/** R22 становится тревогой, когда тишина длится втрое дольше порога. */
export const SILENT_ALERT_FACTOR = 3;
/** Статусы, в которых группа обязана двигаться сама: стоять ей не с чего. */
const MOVING = new Set(['started', 'background', 'awaiting']);
/** Стадии разговора, где пуш и MR — не их работа (доставка впереди, R28); план — только чтение (F-116). */
const PRE_DELIVER = new Set(['plan', 'work', 'review']);

/** Когда группа последний раз подавала голос и был ли то подхват без потока без конца хода. */
export interface SeenMark {
  at: number;
  detached?: boolean;
}

/** Что сторож видел в счётчике напоминаний: число и наборы «не хватает» на каждом новом. */
export interface NudgeSnap {
  nudges: number;
  rounds: string[];
  /**
   * Пауза (F-51): число напоминаний и время, когда сторож видел группу на паузе.
   * Напоминания до паузы — прошлое: после снятия R28 считает только новые.
   */
  floor?: { nudges: number; at: number };
}

export interface GroupSweepInput {
  plans: Record<string, { groups: readonly SplitPlanGroupRecord[] }>;
  /** Живость группы по её ключам; нет — R22 молчит: судить не по чему. */
  live?: (parentChatId: string, group: SplitPlanGroupRecord) => GroupLive;
  /** Затравка тишины после перезапуска: когда группа последний раз писала (транскрипт). */
  seenAt?: (parentChatId: string, group: SplitPlanGroupRecord) => number | undefined;
  lastSeen: Map<string, SeenMark>;
  nudgeSnap: Map<string, NudgeSnap>;
  settings: GroupWatch;
  now: number;
  /** Старт сторожа: тишина без иной метки меряется от него. */
  bornAt: number;
}

export interface GroupSweepHit {
  parentChatId: string;
  group: SplitPlanGroupRecord;
  hits: RuleHit[];
  paused?: boolean;
}

/**
 * Отложенное продолжение: место под потолком, сброс лимита, очередь занятой
 * сессии, лежащий сервис, повтор доставки панелью (`deliveryRetry.at` — срок
 * назначен, таймер его снимет, когда сработает).
 */
function scheduled(group: SplitPlanGroupRecord, now: number): boolean {
  if (group.parked || group.continueQueuedAt || group.blockedSince) return true;
  if (group.deliveryRetry?.at) return true;
  const until = group.limitUntil ? Date.parse(group.limitUntil) : NaN;
  return Number.isFinite(until) && until > now;
}

const missingKey = (missing: readonly string[] | undefined): string =>
  [...(missing ?? [])].sort().join('\n');

/**
 * Последняя метка группы: из памяти сторожа, иначе — с диска (переписка звена),
 * со старта группы или со старта сторожа. Найденная ложится в память: файл
 * читается один раз, а не на каждом тике.
 */
function seenOf(
  input: GroupSweepInput,
  parentChatId: string,
  group: SplitPlanGroupRecord,
): SeenMark {
  const key = groupKeyOf(parentChatId, group.index);
  const known = input.lastSeen.get(key);
  if (known) return known;
  const started = group.startedAt ? Date.parse(group.startedAt) : NaN;
  const candidates = [input.seenAt?.(parentChatId, group), started].filter(
    (value): value is number => value !== undefined && Number.isFinite(value),
  );
  const at = candidates.length > 0 ? Math.max(...candidates) : input.bornAt;
  const mark = { at: Math.min(at, input.now) };
  input.lastSeen.set(key, mark);
  return mark;
}

function silentStop(
  input: GroupSweepInput,
  parentChatId: string,
  group: SplitPlanGroupRecord,
  live: GroupLive | undefined,
): RuleHit | undefined {
  const { now, settings } = input;
  const key = groupKeyOf(parentChatId, group.index);
  if (!live) return undefined;
  // Ход, вопрос, очередь, пауза, отложенное продолжение, решение человека на карточке
  // (без записи вопроса) — группа стоит законно; часы тишины начинаются, когда законная
  // причина кончилась, а не с последнего события (F-53: решение ждали 40 мин — после
  // него R22 не поднимается тревогой за эти 40 мин).
  if (
    live.running ||
    live.ask ||
    live.queued ||
    live.paused ||
    group.waitingFor === 'decision' ||
    scheduled(group, now)
  ) {
    const mark = input.lastSeen.get(key);
    input.lastSeen.set(key, { at: now, ...(mark?.detached ? { detached: true } : {}) });
    return undefined;
  }
  const mark = seenOf(input, parentChatId, group);
  const idle = now - mark.at;
  const span = settings.silentStopMinutes * MINUTE_MS;
  if (idle < span) return undefined;
  const why =
    mark.detached || group.interruptedAt
      ? 'restart'
      : group.status === 'awaiting'
        ? 'awaiting'
        : 'no-run';
  return {
    rule: 'R22',
    severity: idle >= span * SILENT_ALERT_FACTOR ? 'alert' : 'warn',
    numbers: { idleMin: minutes(idle) },
    params: { why },
    since: mark.at,
  };
}

/**
 * Наборы «не хватает» на последних напоминаниях: из журнала доставки на записи,
 * а пока его нет (старая запись) — из того, что сторож сам видел при росте счётчика.
 */
function nudgeRounds(input: GroupSweepInput, key: string, group: SplitPlanGroupRecord): string[] {
  const nudges = group.deliveryNudges ?? 0;
  const snap = input.nudgeSnap.get(key);
  if (!snap || snap.nudges !== nudges) {
    const rounds =
      snap && nudges > snap.nudges ? [...snap.rounds, missingKey(group.deliveryMissing)] : [];
    input.nudgeSnap.set(key, {
      nudges,
      rounds: rounds.slice(-2),
      ...(snap?.floor ? { floor: snap.floor } : {}),
    });
  }
  const floorAt = input.nudgeSnap.get(key)?.floor?.at;
  const history = (group.deliveryHistory ?? []).filter(
    (round) => floorAt === undefined || Date.parse(round.at) > floorAt,
  );
  if (history.length > 0) return history.map((round) => missingKey(round.missing));
  return input.nudgeSnap.get(key)?.rounds ?? [];
}

function idleNudges(
  input: GroupSweepInput,
  parentChatId: string,
  group: SplitPlanGroupRecord,
): RuleHit | undefined {
  const nudges = group.deliveryNudges ?? 0;
  const key = groupKeyOf(parentChatId, group.index);
  const rounds = nudgeRounds(input, key, group);
  if (nudges < 1) return undefined;
  const floor = input.nudgeSnap.get(key)?.floor;
  if (floor && nudges <= floor.nudges) return undefined;
  const need = Math.min(input.settings.nudgeRepeats, 2);
  const last = rounds.slice(-need);
  const stuck =
    nudges >= input.settings.nudgeRepeats &&
    last.length === need &&
    last.every((round) => round === last[0]);
  // Напоминание ушло в разговор работы или ревью, а доставка впереди: пуш там закрыт.
  const misplaced = PRE_DELIVER.has(group.deliveryNudgeStage ?? '') && groupDeliverAhead(group);
  if (!stuck && !misplaced) return undefined;
  const lastAt = group.deliveryHistory?.at(-1)?.at;
  const since = lastAt ? Date.parse(lastAt) : NaN;
  const first = group.deliveryMissing?.[0];
  return {
    rule: 'R28',
    severity: 'warn',
    numbers: { nudges },
    ...(first ? { params: { missing: clip(first, 120) } } : {}),
    since: Number.isFinite(since) ? since : input.now,
  };
}

/**
 * Пауза (F-51): напоминания до неё — прошлое. Счёт и время паузы — в память сторожа,
 * наборы «не хватает» — с чистого листа.
 */
function quietNudges(input: GroupSweepInput, key: string, group: SplitPlanGroupRecord): void {
  const nudges = group.deliveryNudges ?? 0;
  const floor = input.nudgeSnap.get(key)?.floor;
  if (floor?.nudges === nudges) return;
  input.nudgeSnap.set(key, { nudges, rounds: [], floor: { nudges, at: input.now } });
}

/**
 * Обход всех живых групп всех разделений: попадания R22 и R28 на каждую (пустой список
 * тоже — им закрываются прежние сигналы). Память сторожа ограничена живыми группами.
 * `paused` — группа или её дерево на паузе: сторож гасит ей и списки расхода (R8, R21).
 */
export function sweepGroups(input: GroupSweepInput): GroupSweepHit[] {
  const out: GroupSweepHit[] = [];
  const alive = new Set<string>();
  for (const [parentChatId, plan] of Object.entries(input.plans)) {
    for (const group of plan.groups) {
      if (TERMINAL.has(group.status)) continue;
      const key = groupKeyOf(parentChatId, group.index);
      alive.add(key);
      if (!MOVING.has(group.status)) {
        // Пауза и очередь до старта: стоять ей законно, часы тишины пойдут после.
        input.lastSeen.set(key, { at: input.now });
        const paused = group.status === 'paused';
        if (paused) quietNudges(input, key, group);
        out.push({ parentChatId, group, hits: [], ...(paused ? { paused } : {}) });
        continue;
      }
      const live = input.live?.(parentChatId, group);
      // Пауза дерева («Остановить всё») статус группы не меняет — та же пауза.
      if (live?.paused) {
        silentStop(input, parentChatId, group, live);
        quietNudges(input, key, group);
        out.push({ parentChatId, group, hits: [], paused: true });
        continue;
      }
      const hits = [
        silentStop(input, parentChatId, group, live),
        idleNudges(input, parentChatId, group),
      ];
      out.push({ parentChatId, group, hits: hits.filter((hit) => hit !== undefined) });
    }
  }
  for (const key of [...input.lastSeen.keys()]) if (!alive.has(key)) input.lastSeen.delete(key);
  for (const key of [...input.nudgeSnap.keys()]) if (!alive.has(key)) input.nudgeSnap.delete(key);
  return out;
}
