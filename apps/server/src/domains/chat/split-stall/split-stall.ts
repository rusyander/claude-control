import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import { findTranscript } from '../ChatTranscriptFile/ChatTranscriptFile.ts';

/**
 * Сторож повисших групп разделения (строка 8 плана скорости гейтов, журнал 19.10).
 *
 * Группа «работает», а её транскрипт молчит часами: CLI ждёт итога вызова, чей
 * процесс снял перезапуск панели, или ход умер так, что панель этого не узнала.
 * Замер двух групп 16–19.10: ~54 ч мёртвого времени на группу против ~5 ч работы,
 * 4 ч из них — ожидание вызова, которого уже не было. Человек замечал это только
 * глазами. Теперь молчание дольше любого законного вызова — обрыв: процесс снят,
 * группа идёт путём оборванного хода (продолжение с восстановлением состояния).
 */

/**
 * Порог молчания. Самый долгий законный вызов группы — гейт на переднем плане с
 * таймаутом 30 мин, внутри которого стоит и очередь тяжёлых проверок машины
 * (до 25 мин): час молчания ни одна живая работа не даёт.
 */
export const STALL_SILENT_MS = 60 * 60_000;

/** Как часто сторож смотрит на группы: порог в час не требует чаще. */
export const STALL_POLL_MS = 5 * 60_000;

export type StallStopOutcome = 'stopped' | 'absent' | 'unconfirmed';

export interface SplitStallDeps {
  plans: () => SplitPlanRecord[];
  /** Все ключи разговоров группы: первый чат, звенья цепочки, синонимы `new-…`. */
  chatIdsOf: (record: SplitPlanRecord, group: SplitPlanGroupRecord) => string[];
  /** Время последней записи транскриптов этих разговоров; нечем судить — `undefined`. */
  lastActivity: (chatIds: readonly string[]) => number | undefined;
  /** Жив ли процесс CLI хоть одного из разговоров. */
  processAlive: (chatIds: readonly string[]) => boolean;
  /** Висит запрос прав человеку: молчание — его, а не группы. */
  waitingOnHuman: (chatIds: readonly string[]) => boolean;
  stop: (chatId: string) => StallStopOutcome;
  /** Путь оборванного хода; `undefined` — группа уже не «работает». */
  interrupt: (parentChatId: string, index: number) => { resumed: boolean } | undefined;
  /**
   * Снимок того, что держало вызов (`stall-diagnostic.ts`), ДО снятия процесса:
   * снятие стирает улики. Ответ — путь журнала; `undefined` или сбой — без него.
   */
  diagnose?: (input: {
    key: string;
    record: SplitPlanRecord;
    group: SplitPlanGroupRecord;
    chatIds: readonly string[];
    silentMs: number;
  }) => Promise<string | undefined>;
  notify: (
    parentChatId: string,
    group: SplitPlanGroupRecord,
    silentMs: number,
    resumed: boolean,
    logPath?: string,
  ) => void;
  log: (message: string, error?: unknown) => void;
  now?: () => number;
  silentMs?: number;
}

/**
 * Один обход. Молчание считается от самого позднего из: записи транскрипта,
 * старта группы и момента, когда сторож впервые увидел её в этом состоянии, —
 * свежепродолженная группа со старым транскриптом не падает сразу же.
 *
 * `background` с живым процессом сторож не трогает: фон держит сам процесс, а
 * простой такого процесса ограничивает пул живых сессий (6 ч) — его закрытие и
 * так ведёт в обрыв. Без живого процесса пробуждения не будет никогда.
 */
export function createSplitStallWatch(deps: SplitStallDeps): () => Promise<string[]> {
  const seen = new Map<string, { status: string; since: number }>();
  /** Журнал уже снят для этого обрыва (повтор после «не снят» не пишет второй). */
  const diagnosed = new Map<string, string | undefined>();
  const limit = deps.silentMs ?? STALL_SILENT_MS;
  let busy = false;

  interface Stalled {
    key: string;
    record: SplitPlanRecord;
    group: SplitPlanGroupRecord;
    ids: string[];
    last: number;
    silent: number;
  }

  const collect = (now: number): Stalled[] => {
    const found: Stalled[] = [];
    const watched = new Set<string>();
    for (const record of deps.plans()) {
      for (const group of record.groups) {
        if (group.status !== 'started' && group.status !== 'background') continue;
        const key = `${record.parentChatId}#${group.index}`;
        watched.add(key);
        const mark = seen.get(key);
        if (!mark || mark.status !== group.status) {
          seen.set(key, { status: group.status, since: now });
          diagnosed.delete(key);
          continue;
        }
        const ids = deps.chatIdsOf(record, group);
        if (ids.length === 0) continue;
        const last = deps.lastActivity(ids);
        // Транскрипта нет (чужой CLI, сессия не успела начаться) — судить не по чему.
        if (last === undefined) continue;
        const started = group.startedAt ? Date.parse(group.startedAt) : Number.NaN;
        const silent = now - Math.max(last, mark.since, Number.isNaN(started) ? 0 : started);
        if (silent < limit) continue;
        if (group.status === 'background' && deps.processAlive(ids)) continue;
        if (deps.waitingOnHuman(ids)) continue;
        found.push({ key, record, group, ids, last, silent });
      }
    }
    for (const key of seen.keys()) {
      if (watched.has(key)) continue;
      seen.delete(key);
      diagnosed.delete(key);
    }
    return found;
  };

  const settle = async (item: Stalled): Promise<boolean> => {
    const { key, record, group, ids, silent } = item;
    if (deps.diagnose && !diagnosed.has(key)) {
      let path: string | undefined;
      try {
        path = await deps.diagnose({ key, record, group, chatIds: ids, silentMs: silent });
      } catch (error) {
        deps.log(`split stall: diagnostic of ${key} failed`, error);
      }
      diagnosed.set(key, path);
      // Пока снимался список процессов (~1 с), группа могла ожить или смениться.
      const latest = deps.lastActivity(ids);
      const fresh = deps
        .plans()
        .find((plan) => plan.parentChatId === record.parentChatId)
        ?.groups.find((candidate) => candidate.index === group.index);
      if ((latest !== undefined && latest > item.last) || fresh?.status !== group.status) {
        diagnosed.delete(key);
        return false;
      }
    }
    // Процесс, который панель не смогла снять, работает дальше без присмотра —
    // второй CLI в той же копии правил бы то же дерево наперегонки.
    const outcomes = ids.map((id) => deps.stop(id));
    if (outcomes.includes('unconfirmed')) {
      deps.log(`split stall: process of ${key} not confirmed stopped, retry next pass`);
      return false;
    }
    const result = deps.interrupt(record.parentChatId, group.index);
    seen.delete(key);
    const logPath = diagnosed.get(key);
    diagnosed.delete(key);
    if (!result) return false;
    deps.notify(record.parentChatId, group, silent, result.resumed, logPath);
    return true;
  };

  // Обход асинхронный (снимок процессов), а таймер не ждёт: второй обход поверх
  // идущего снимал бы ту же группу дважды.
  return async () => {
    if (busy) return [];
    busy = true;
    try {
      const fired: string[] = [];
      for (const item of collect(deps.now?.() ?? Date.now())) {
        if (await settle(item)) fired.push(item.key);
      }
      return fired;
    } finally {
      busy = false;
    }
  };
}

/**
 * Последняя запись транскриптов Claude Code этих разговоров — вместе с
 * транскриптами их субагентов (`<сессия>/subagents/*.jsonl`): пока субагент
 * работает, главный файл молчит законно.
 */
export function transcriptActivity(
  projectsDir: string,
  chatIds: readonly string[],
): number | undefined {
  let latest: number | undefined;
  const bump = (path: string): void => {
    try {
      const mtime = statSync(path).mtimeMs;
      if (latest === undefined || mtime > latest) latest = mtime;
    } catch {
      // Файл исчез между листингом и чтением — не довод ни за, ни против.
    }
  };
  for (const chatId of chatIds) {
    const path = findTranscript(projectsDir, chatId);
    if (!path) continue;
    bump(path);
    const subagents = join(path.slice(0, -'.jsonl'.length), 'subagents');
    if (!existsSync(subagents)) continue;
    for (const name of readdirSync(subagents)) {
      if (name.endsWith('.jsonl')) bump(join(subagents, name));
    }
  }
  return latest;
}
