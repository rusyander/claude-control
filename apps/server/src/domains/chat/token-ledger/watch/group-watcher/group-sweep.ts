import type { GroupWatch } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../../lib/app-store/app-store.types.ts';
import { groupDeliverAhead } from '../../../split-conveyor/split-conveyor.ts';
import { groupKeyOf, type WastePoint } from '../group-ledgers.ts';
import type { BurnPoint } from '../rules.ts';
import { clip, MINUTE_MS, minutes } from '../rules-util.ts';
import type { RuleHit } from '../watch.types.ts';
import type { DeferredStuck, GroupLive } from './group-watcher.types.ts';
import {
  ledgerFinding,
  ledgerGaps,
  type LedgerCheckRun,
  type LedgerSnapshot,
} from './ledger-rules.ts';
import {
  restartByGroup,
  restartStorm,
  type EditedFile,
  type RestartFeed,
} from './restart-rules.ts';
import { TERMINAL } from './timing.ts';
import { heavyRunHit, type FinishedRun, type HeavyRun } from './window-rules.ts';
import { unresumedPause } from './pause-rules.ts';
import { runSummaryHit } from './run-summary.ts';

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
  /** Ждущий D-n, который панель сама не разрешила (R45); нет — R45 молчит. */
  deferredStuck?: (parentChatId: string, groupIndex: number) => DeferredStuck | undefined;
  /** Группа ждёт решения человека по любому D-n (R43 тогда молчит: человеку есть что решить). */
  deferredWaiting?: (parentChatId: string, groupIndex: number) => boolean;
  /** Перезапуски панели (R38, R39); нет — оба молчат. */
  restarts?: RestartFeed;
  /** Правленые файлы группы по её ключу (R38). */
  editedFilesOf?: (groupKey: string) => readonly EditedFile[];
  /** Журнал проверок (R40, R41); нет — оба молчат. */
  ledger?: LedgerSnapshot;
  /** Проверки группы, которые журнал обязан был увидеть (R41). */
  checkRunsOf?: (groupKey: string) => readonly LedgerCheckRun[];
  /** Тяжёлые прогоны группы за полчаса по её ключу (R42); нет — R42 молчит. */
  heavyRunsOf?: (groupKey: string) => readonly HeavyRun[];
  /** Законченные прогоны группы за полчаса (R46); нет — R46 молчит. */
  finishedRunsOf?: (groupKey: string) => readonly FinishedRun[];
  /** Расход группы и её вызовы впустую (доля потерь R46); нет — итог без доли. */
  burnOf?: (groupKey: string) => readonly BurnPoint[];
  wasteOf?: (groupKey: string) => readonly WastePoint[];
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
  const lastAt = group.deliveryHistory?.at(-1)?.at;
  const since = Number.isFinite(lastAt ? Date.parse(lastAt) : NaN)
    ? Date.parse(lastAt as string)
    : input.now;
  if (!stuck && !misplaced) return newlyMissing(input.settings, nudges, rounds, since);
  const first = group.deliveryMissing?.[0];
  return {
    rule: 'R28',
    severity: 'warn',
    numbers: { nudges },
    ...(first ? { params: { missing: clip(first, 120) } } : {}),
    since,
  };
}

/**
 * R28 «каждый круг — новое» (сведение): напоминаний уже `nudgeRepeats`, а последний круг
 * нашёл недостающее, которого на прошлом не было, — доставка переделывается по кругу, а
 * не стоит. Набор, который только сжимается, — движение вперёд, не сигнал; тот же набор —
 * «внимание» выше.
 */
function newlyMissing(
  settings: GroupWatch,
  nudges: number,
  rounds: readonly string[],
  since: number,
): RuleHit | undefined {
  if (nudges < settings.nudgeRepeats || rounds.length < 2) return undefined;
  const before = new Set((rounds.at(-2) ?? '').split('\n'));
  const fresh = (rounds.at(-1) ?? '').split('\n').filter((item) => item && !before.has(item));
  const first = fresh[0];
  if (!first) return undefined;
  return {
    rule: 'R28',
    severity: 'info',
    numbers: { nudges, fresh: fresh.length },
    params: { missing: clip(first, 120) },
    since,
    textKey: 'groupWatch.rule.R28rounds',
  };
}

/**
 * R45 — группа ждёт решения по D-n, которое панель сама принять не смогла
 * (`not-auto-approved`): без человека она не двинется. Ожидания по замыслу —
 * защита бэкенда, основная копия, строки группы — сюда не попадают: их и так решает человек.
 */
function stuckDeferred(
  input: GroupSweepInput,
  parentChatId: string,
  group: SplitPlanGroupRecord,
): RuleHit | undefined {
  const stuck = input.deferredStuck?.(parentChatId, group.index);
  if (!stuck) return undefined;
  return {
    rule: 'R45',
    severity: 'info',
    numbers: { waitMin: minutes(Math.max(0, input.now - stuck.at)) },
    params: { id: stuck.id, tool: clip(stuck.tool, 60) },
    since: stuck.at,
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
  // R38: живые группы, шедшие уже тогда, — перезапуск в ту минуту задел и их.
  const moving: { key: string; startedAt: number }[] = [];
  for (const [parentChatId, plan] of Object.entries(input.plans)) {
    for (const group of plan.groups) {
      if (!MOVING.has(group.status)) continue;
      const started = group.startedAt ? Date.parse(group.startedAt) : NaN;
      moving.push({
        key: groupKeyOf(parentChatId, group.index),
        startedAt: Number.isFinite(started) ? started : 0,
      });
    }
  }
  const othersOf = (key: string) => (at: number) =>
    moving.filter((one) => one.key !== key && one.startedAt <= at).length;
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
        // R43: пауза стоит, а человеку решать нечего — напоминание, что её пора снять.
        const unresumed = paused
          ? unresumedPause(
              group,
              input.settings,
              input.now,
              input.deferredWaiting?.(parentChatId, group.index) === true,
            )
          : undefined;
        out.push({
          parentChatId,
          group,
          hits: unresumed ? [unresumed] : [],
          ...(paused ? { paused } : {}),
        });
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
        stuckDeferred(input, parentChatId, group),
        restartByGroup(input.restarts, input.editedFilesOf?.(key) ?? [], input.now, othersOf(key)),
        restartStorm(input.restarts, input.settings, input.now),
        ledgerFinding(input.ledger, group.path, input.now),
        ledgerGaps(input.ledger, group.path, input.checkRunsOf?.(key) ?? [], input.now),
        heavyRunHit(input.heavyRunsOf?.(key) ?? []),
        runSummaryHit({
          runs: input.finishedRunsOf?.(key) ?? [],
          burn: input.burnOf?.(key) ?? [],
          waste: input.wasteOf?.(key) ?? [],
          group,
        }),
      ];
      out.push({ parentChatId, group, hits: hits.filter((hit) => hit !== undefined) });
    }
  }
  for (const key of [...input.lastSeen.keys()]) if (!alive.has(key)) input.lastSeen.delete(key);
  for (const key of [...input.nudgeSnap.keys()]) if (!alive.has(key)) input.nudgeSnap.delete(key);
  return out;
}
