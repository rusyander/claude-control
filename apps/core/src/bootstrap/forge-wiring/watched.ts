import { join } from 'node:path';
import {
  ANSWER_REVIEWERS_PRESET,
  BASE_PIN_SIGNAL,
  parseBasePin,
} from '../../conductor/estimate/index.ts';
import type { TaskRegistry, TaskSummary } from '../../conductor/tasks.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { publicationOf } from '../../journal/reduce/publish.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { pathKey } from '../../platform/paths.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import type { WatchedMr } from '../../publisher/events/poll.ts';
import { repoServerOf } from '../publish-wiring/unit-view.ts';

/**
 * Какие MR опрашивать (05:77, 01:61) — только из журналов задач, памяти процесса нет:
 * - MR единицы — её `publish.mr`; задача ответов несёт тот же MR (личность скопирована), и все
 *   задачи одного MR смотрятся вместе по адресу MR;
 * - MR удержан (`held`), пока его задача не закончена — в том числе ждущая запуска задача ответов
 *   и недоделанная, у которой есть строки `forge.event` опроса, но ещё нет единицы (крах посреди
 *   создания, F2): просьб по нему нет, его заметки ждут конца задачи в отметках опроса;
 * - иначе наблюдает ПОСЛЕДНЯЯ задача этого MR, закончившаяся `done`; провал и отмена — нет;
 * - `seen` — id событий опроса из журналов задач MR: крах между созданием задачи и записью
 *   отметок опроса не открывает её второй раз. Исключение — задача без единицы, кончившаяся
 *   `failed` (сбой при создании): её заметка не разобрана, следующий круг откроет задачу снова;
 * - `handled` — заметки, прочитанные публикацией (`publish.read`) задач ответов, кончившихся
 *   `done` (F5): всё до того чтения — их;
 * - адрес — адрес пуша без учётных данных (F9): токен из `https://user:token@…` не уходит ни в
 *   файл отметок, ни в журнал ядра, ни в цель события.
 * Журнал законченной задачи не меняется — его разбор помнится по (задача, seq).
 */

interface UnitMr {
  unitId: string;
  /** Исходный репозиторий единицы (`task.created.repos[].path`). */
  repo: string;
  /** Ссылка базы: приколотая (`origin/main`) или `baseRef` задачи. */
  ref: string;
  mrIid: number;
  mrUrl: string;
  /** Время первой строки `publish.mr` этой единицы. */
  at: number;
}

interface TaskMrs {
  units: UnitMr[];
  /** События опроса: номер MR, цель (адрес пуша без учётных данных) и id. */
  pollerEvents: { mrIid: number; url: string; id: string }[];
  /** Заметки, прочитанные публикацией, по номеру MR. */
  read: { mrIid: number; notes: string[] }[];
  answers: boolean;
}

export interface WatchedDeps {
  registry: TaskRegistry;
  git?: GitOptions;
  log?: (message: string) => void;
}

/** Адрес без `user:password@` (https/ssh-URL); scp-вид `git@host:path` и путь — как есть. */
export function withoutUserinfo(url: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.username === '' && parsed.password === '') return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Не разбирается как URL — срезать вручную всё до последнего `@` в части хоста.
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1');
  }
}

/** Цель события опроса `<адрес> !<номер>` → адрес без учётных данных. */
function targetUrl(target: string): string {
  const cut = target.lastIndexOf(' !');
  return withoutUserinfo(cut < 0 ? target : target.slice(0, cut));
}

function readTaskMrs(dir: string, taskId: string, state: TaskFoldState): TaskMrs {
  const repos = new Map<string, { path: string; baseRef: string }>();
  const unitRepo = new Map<string, string>();
  const pins = new Map<string, string>();
  const mrAt = new Map<string, number>();
  const out: TaskMrs = {
    units: [],
    pollerEvents: [],
    read: [],
    answers: state.created?.scenario.id === ANSWER_REVIEWERS_PRESET,
  };
  for (const line of readJournalLines(dir, taskId).lines) {
    if (line.kind === 'task.created') {
      const data = line.data as { repos: { repoKey: string; path: string; baseRef: string }[] };
      for (const r of data.repos) repos.set(r.repoKey, r);
    } else if (line.kind === 'unit.created') {
      const data = line.data as { unitId: string; repoKey: string };
      unitRepo.set(data.unitId, data.repoKey);
    } else if (line.kind === 'signal') {
      const s = line.data as { signal: string; subject: string; detail: string };
      const pin = s.signal === BASE_PIN_SIGNAL ? parseBasePin(s.detail) : null;
      if (pin) pins.set(s.subject, pin.ref);
    } else if (line.kind === 'publish.mr') {
      const data = line.data as { unitId: string };
      if (!mrAt.has(data.unitId)) mrAt.set(data.unitId, line.at);
    } else if (line.kind === 'publish.read') {
      const data = line.data as { mrIid: number; notes?: string[] };
      out.read.push({ mrIid: data.mrIid, notes: data.notes ?? [] });
    } else if (line.kind === 'forge.event') {
      const e = line.data as {
        source?: string;
        mrIid?: number;
        forgeEventId: string;
        target: string;
      };
      if (e.source === 'poller' && typeof e.mrIid === 'number')
        out.pollerEvents.push({ mrIid: e.mrIid, url: targetUrl(e.target), id: e.forgeEventId });
    }
  }
  for (const unitId of Object.keys(state.units)) {
    const mr = publicationOf(state, unitId).mr;
    const key = unitRepo.get(unitId);
    const repo = key === undefined ? undefined : repos.get(key);
    if (!mr || key === undefined || !repo) continue;
    out.units.push({
      unitId,
      repo: repo.path,
      ref: pins.get(key) ?? repo.baseRef,
      mrIid: mr.mrIid,
      mrUrl: mr.url,
      at: mrAt.get(unitId) ?? Number.POSITIVE_INFINITY,
    });
  }
  return out;
}

interface Carrier {
  summary: TaskSummary;
  unit: UnitMr;
  mrs: TaskMrs;
}

/** Задача с событиями опроса, но без единицы с MR — недоделанная при создании. */
interface HalfMade {
  summary: TaskSummary;
  events: TaskMrs['pollerEvents'];
}

export function createWatched(deps: WatchedDeps) {
  const memo = new Map<string, { seq: number; mrs: TaskMrs }>();

  function mrsOf(s: TaskSummary): TaskMrs | undefined {
    const hit = memo.get(s.taskId);
    if (hit && hit.seq === s.seq) return hit.mrs;
    try {
      const own = deps.registry.live(s.taskId);
      const state = own?.state ?? deps.registry.view(s.taskId);
      if (!state) return undefined;
      const dir = own?.dir ?? join(deps.registry.tasksDir, s.taskId);
      const mrs = readTaskMrs(dir, s.taskId, state);
      // Помнится только законченная: журнал идущей ещё растёт.
      if (s.ended !== null) memo.set(s.taskId, { seq: s.seq, mrs });
      return mrs;
    } catch (error) {
      deps.log?.(`forge poller: task ${s.taskId} journal unreadable: ${String(error)}`);
      return undefined;
    }
  }

  /** `enabled` — ключи путей включённых репозиториев: адрес пуша читается только для них. */
  return async function watched(enabled?: ReadonlySet<string>): Promise<WatchedMr[]> {
    const byMr = new Map<string, Carrier[]>();
    const halfMade: HalfMade[] = [];
    // id — uuidv7, `list()` отсортирован по ним: порядок списка — порядок создания задач.
    for (const s of deps.registry.list()) {
      const mrs = mrsOf(s);
      if (!mrs) continue;
      if (mrs.units.length === 0 && mrs.pollerEvents.length > 0)
        halfMade.push({ summary: s, events: mrs.pollerEvents });
      for (const unit of mrs.units) {
        if (enabled && !enabled.has(pathKey(unit.repo))) continue;
        const key = `${unit.mrUrl}#${unit.mrIid}`;
        byMr.set(key, [...(byMr.get(key) ?? []), { summary: s, unit, mrs }]);
      }
    }
    const out: WatchedMr[] = [];
    // Сервер репозитория читается раз на круг, а не на каждый MR: у одного репозитория все MR на
    // одном удалённом, а каждое чтение — несколько процессов git. Круг по N MR одного проекта
    // порождал 4·N процессов, и опрос дорожал с каждой законченной задачей (на Windows под
    // нагрузкой ~130 мс на процесс). Между кругами не помнится: человек мог сменить адрес.
    const servers = new Map<string, ReturnType<typeof repoServerOf>>();
    const serverOf = (repo: string, ref: string) => {
      const key = `${pathKey(repo)}\0${ref}`;
      let got = servers.get(key);
      if (!got) servers.set(key, (got = repoServerOf(repo, ref, deps.git)));
      return got;
    };
    for (const carriers of byMr.values()) {
      const first = carriers[0]!;
      const server = await serverOf(first.unit.repo, first.unit.ref);
      if (!('value' in server)) {
        deps.log?.(`forge poller: ${first.unit.repo}: ${server.unknown}`);
        continue;
      }
      const url = withoutUserinfo(server.value.url);
      const iid = first.unit.mrIid;
      const own = (e: { mrIid: number }) => e.mrIid === iid;
      const half = halfMade.filter((h) => h.events.some((e) => own(e) && e.url === url));
      // Недоделанная задача, кончившаяся провалом, заметку не разобрала — её события не «увидены».
      const seen = [
        ...carriers.flatMap((c) => c.mrs.pollerEvents),
        ...half.filter((h) => h.summary.ended !== 'failed').flatMap((h) => h.events),
      ]
        .filter(own)
        .map((e) => e.id);
      const held =
        carriers.some((c) => c.summary.ended === null) ||
        half.some((h) => h.summary.ended === null);
      const done = carriers.filter((c) => c.summary.ended === 'done');
      const last = held ? (done.at(-1) ?? carriers.at(-1)) : done.at(-1);
      if (!last) continue;
      const handled = done
        .filter((c) => c.mrs.answers)
        .flatMap((c) => c.mrs.read.filter(own).flatMap((r) => r.notes));
      const publishedAt = Math.min(...carriers.map((c) => c.unit.at));
      out.push({
        taskId: last.summary.taskId,
        unitId: last.unit.unitId,
        repo: last.unit.repo,
        remote: server.value.remote,
        url,
        mrIid: iid,
        seen: [...new Set(seen)],
        ...(Number.isFinite(publishedAt) ? { publishedAt } : {}),
        ...(handled.length > 0 ? { handled: [...new Set(handled)] } : {}),
        ...(held ? { held: true } : {}),
      });
    }
    return out;
  };
}
