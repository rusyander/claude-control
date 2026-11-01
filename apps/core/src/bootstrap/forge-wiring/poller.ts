import type { ForgePort } from '@agentdeck/contracts/core/forge';
import {
  pollOnce,
  requestOf,
  type AnswerTaskRequest,
  type PolledNote,
  type WatchedMr,
} from '../../publisher/events/poll.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { pathKey } from '../../platform/paths.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import { forgeForRemote } from '../panel-forge.ts';

/**
 * Обвязка опроса форжа (05:77, G2): ВЫКЛЮЧЕН, пока человек не включил его для проекта
 * (`enabled` — исходные репозитории из конфига ядра, читается на каждом круге; по умолчанию — ни
 * одного). Без модели и без записи в форж: читает события MR законченных задач и просит открыть
 * новую задачу ответов. Отметка и увиденные события живут в файле состояния — перезапуск ядра
 * не открывает задачу второй раз.
 */

/** Для каких исходных репозиториев человек включил опрос; `problem` — конфиг не той формы. */
export interface PollEnabled {
  repos: readonly string[];
  problem?: string;
}

export interface ForgePollerDeps {
  /** Репозитории, для которых опрос включён; по умолчанию — ни одного. */
  enabled?: () => PollEnabled;
  /**
   * MR законченных задач под наблюдением; зовётся, только когда опрос где-то включён, с ключами
   * путей (`pathKey`) включённых репозиториев — остальные можно не разбирать.
   */
  watched: (enabled: ReadonlySet<string>) => readonly WatchedMr[] | Promise<readonly WatchedMr[]>;
  /** Открыть новую задачу answer-reviewers; сбой — событие повторится на следующем опросе. */
  request: (req: AnswerTaskRequest) => Promise<void> | void;
  /** Файл отметок опроса (каталог ядра). */
  stateFile: string;
  forgeFor?: (url: string) => ForgePort;
  now?: () => number;
  intervalMs?: number;
  log?: (message: string) => void;
}

export interface PollTick {
  /** Проекты, опрошенные в этот раз. */
  polled: string[];
  requested: number;
  /** Проекты, чей опрос не прочитался (`unknown`) — отметка не сдвинута. */
  unknown: Record<string, string>;
}

/**
 * Отметки проекта (по адресу пуша без учётных данных):
 * - `cursor` — время последнего события, прочитанного в проекте; `start` — когда опрос проекта
 *   включили: события раньше — история до включения, не повод;
 * - `mrs` — своя отметка каждого MR (по номеру); MR без своей начинает с меньшего из `cursor` и
 *   своей публикации (F8: MR, выпавший из круга, не наследует чужой сдвиг);
 * - `pending` — заметки, ещё не ставшие задачей: MR удержан (ответы в работе) или задачу не
 *   открыли (отказ, сбой). Отметка MR при этом идёт дальше — окно запроса не растёт без предела;
 * - `retired` — слитые и закрытые MR с причиной: больше не читаются.
 */
interface ProjectMark {
  cursor: number;
  start?: number;
  seen: string[];
  mrs?: Record<string, number>;
  pending?: Record<string, PolledNote[]>;
  retired?: Record<string, string>;
}

/** Сколько увиденных событий помнить на проект: окно запроса с запасом их не старше. */
const SEEN_MAX = 500;
/** Сколько ждущих заметок держать на MR; лишние (старейшие) уходят с записью в журнал ядра. */
export const PENDING_MAX = 100;
export const DEFAULT_POLL_MS = 5 * 60_000;
/**
 * Запас окна позади отметки (F7): лента событий отдаёт событие позже его времени — GitHub
 * обещает от 30 с до 6 ч, GitLab пишет сразу. Перекрытие разбирает `seen`.
 */
export const POLL_LAG_MS: Record<ForgePort['kind'], number> = {
  gitlab: 5 * 60_000,
  github: 6 * 3_600_000,
  // Неизвестный форж — запас как у самого медленного из известных.
  generic: 6 * 3_600_000,
};

function readMarks(file: string): Record<string, ProjectMark> {
  const bytes = readBytesSync(file);
  if (!('value' in bytes)) return {};
  try {
    const doc = JSON.parse(bytes.value.toString('utf8')) as unknown;
    return typeof doc === 'object' && doc !== null && !Array.isArray(doc)
      ? (doc as Record<string, ProjectMark>)
      : {};
  } catch {
    // Испорченный файл отметок — начать с «сейчас»: лучше пропустить старую заметку, чем
    // открыть по каждой из них задачу заново.
    return {};
  }
}

export function createForgePoller(deps: ForgePollerDeps) {
  const enabled = deps.enabled ?? ((): PollEnabled => ({ repos: [] }));
  const forgeFor = deps.forgeFor ?? ((url: string) => forgeForRemote(url).port);
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  async function tick(): Promise<PollTick> {
    const out: PollTick = { polled: [], requested: 0, unknown: {} };
    const on = enabled();
    if (on.problem) deps.log?.(`forge poller: ${on.problem}`);
    // Ни одного включённого репозитория — журналы задач даже не читаются.
    if (on.repos.length === 0) return out;
    const keys = new Set(on.repos.map((r) => pathKey(r)));
    const byUrl = new Map<string, WatchedMr[]>();
    for (const mr of await deps.watched(keys)) {
      if (!keys.has(pathKey(mr.repo))) continue;
      byUrl.set(mr.url, [...(byUrl.get(mr.url) ?? []), mr]);
    }
    if (byUrl.size === 0) return out;
    const marks = readMarks(deps.stateFile);
    for (const [url, all] of byUrl) {
      const fresh = now();
      // Новый проект начинает с «сейчас»: опрос включили — история до включения не повод.
      const mark = marks[url] ?? { cursor: fresh, start: fresh, seen: [] };
      const next = await pollProject(url, mark, all, out);
      if (next) marks[url] = next;
      else if (!marks[url]) marks[url] = mark;
    }
    writeFileAtomic(deps.stateFile, JSON.stringify(marks));
    return out;
  }

  /** Один проект за круг; `null` — лента не прочитана, отметки проекта не меняются. */
  async function pollProject(
    url: string,
    mark: ProjectMark,
    all: readonly WatchedMr[],
    out: PollTick,
  ): Promise<ProjectMark | null> {
    const start = mark.start ?? mark.cursor;
    const own = { ...(mark.mrs ?? {}) };
    const pending = { ...(mark.pending ?? {}) };
    const retired = { ...(mark.retired ?? {}) };
    const cursorOf = (m: WatchedMr): number =>
      own[String(m.mrIid)] ?? Math.max(start, Math.min(mark.cursor, m.publishedAt ?? mark.cursor));
    const live = all.filter((m) => !(String(m.mrIid) in retired));
    if (live.length === 0) return { ...mark, start };
    const port = forgeFor(url);
    const lag = POLL_LAG_MS[port.kind] ?? 0;
    const seen = new Set(mark.seen);
    const known = new Set([...seen, ...all.flatMap((m) => m.seen ?? [])]);
    // Один запрос на проект — с самой ранней отметки MR минус запас задержки ленты; уже ставшее
    // задачей отсекают `known`, прочитанное задачей ответов — `handled` MR.
    const entries = live.map((mr) => ({ mr, from: Math.max(start, cursorOf(mr) - lag) }));
    const got = await pollOnce(port, entries, known);
    out.polled.push(url);
    if (!('value' in got)) {
      out.unknown[url] = 'unknown' in got ? got.unknown : 'absent';
      return null;
    }
    for (const { mr, state, notes } of got.value.mrs) {
      const iid = String(mr.mrIid);
      // Состояние MR не прочитано — круг этот MR не трогает: отметка, ждущие — как были.
      if (state === null) continue;
      if (state !== 'open') {
        retired[iid] = state;
        delete pending[iid];
        deps.log?.(`forge poller: ${url} !${iid} retired: ${state} — no longer watched`);
        continue;
      }
      own[iid] = Math.max(cursorOf(mr), got.value.cursor);
      const handled = new Set(mr.handled ?? []);
      const queue = new Map<string, PolledNote>();
      for (const n of [...(pending[iid] ?? []), ...notes]) {
        if (known.has(n.event.forgeEventId)) continue;
        if (n.objectId !== undefined && handled.has(n.objectId)) continue;
        queue.set(n.event.forgeEventId, n);
      }
      const ready = [...queue.values()];
      delete pending[iid];
      if (ready.length === 0) continue;
      // Ответы на MR в работе — заметки ждут конца его задачи, отметка идёт дальше.
      if (mr.held) {
        pending[iid] = bounded(url, iid, ready);
        continue;
      }
      try {
        await deps.request(requestOf(mr, ready));
        out.requested += 1;
        for (const n of ready) seen.add(n.event.forgeEventId);
      } catch (error) {
        // Не открытая задача — заметки ждут следующего круга; окно запроса от этого не растёт.
        pending[iid] = bounded(url, iid, ready);
        deps.log?.(`forge poller: request for ${url} !${iid} failed: ${String(error)}`);
      }
    }
    return {
      cursor: Math.max(mark.cursor, got.value.cursor),
      start,
      seen: [...seen].slice(-SEEN_MAX),
      mrs: own,
      ...(Object.keys(pending).length > 0 ? { pending } : {}),
      ...(Object.keys(retired).length > 0 ? { retired } : {}),
    };
  }

  function bounded(url: string, iid: string, notes: PolledNote[]): PolledNote[] {
    if (notes.length <= PENDING_MAX) return notes;
    const dropped = notes.length - PENDING_MAX;
    deps.log?.(
      `forge poller: ${url} !${iid}: ${dropped} waiting note(s) over ${PENDING_MAX} dropped (oldest)`,
    );
    return [...notes].sort((a, b) => a.at - b.at).slice(dropped);
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        // Круг не накладывается на круг: два параллельных прочли бы одни отметки и открыли бы
        // задачу по той же заметке дважды; медленный форж просто пропускает шаги таймера.
        if (inFlight) return;
        inFlight = tick()
          .then(
            () => undefined,
            (error: unknown) => deps.log?.(`forge poller: ${String(error)}`),
          )
          .finally(() => {
            inFlight = undefined;
          });
      }, deps.intervalMs ?? DEFAULT_POLL_MS);
      timer.unref?.();
    },
    /** Снимает таймер и ждёт идущий круг: после неё ни запроса к форжу, ни новой задачи. */
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
