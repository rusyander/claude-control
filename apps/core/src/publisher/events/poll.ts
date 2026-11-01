import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgeActivity, ForgeMr, ForgePort } from '@agentdeck/contracts/core/forge';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';

/**
 * Опрос форжа после публикации (05:77, решение G2): без модели, только чтение. Новая заметка
 * ДРУГОЙ учётки в MR законченной задачи — событие форжа (`forge.event`, источник `poller`) и
 * просьба открыть НОВУЮ задачу answer-reviewers. Свои заметки публикатора, пуши и прочее —
 * не повод: ядро не ждёт ревью, модель не опрашивает.
 */

/** MR законченной задачи под наблюдением. */
export interface WatchedMr {
  taskId: string;
  /** Единица задачи, чья `publish.mr` — этот MR. */
  unitId: string;
  /** Исходный репозиторий — по нему человек включает опрос (`forgePoll`). */
  repo: string;
  /** Удалённый репозитория, чей адрес пуша — `url`. */
  remote: string;
  /** Адрес пуша remote БЕЗ учётных данных (`user:token@` срезан) — по нему форж и цель события. */
  url: string;
  mrIid: number;
  /**
   * События, уже ставшие задачей (строки `forge.event` опроса в журналах задач этого MR): крах
   * между созданием задачи и записью отметок не открывает её второй раз.
   */
  seen?: readonly string[];
  /**
   * Ответы на этот MR уже в работе (задача MR ещё не закончена или создаётся): просьб по нему нет,
   * его новые заметки копятся в отметках опроса и придут, когда задача закончится.
   */
  held?: boolean;
  /**
   * Заметки (id объекта форжа), которые задача ответов уже прочла в нитях MR при публикации и
   * закончилась `done` (05:77): всё, что было в её `publish.read`, — её; следующую задачу
   * открывают только заметки после того чтения.
   */
  handled?: readonly string[];
  /** Время первой `publish.mr` этого MR в журналах: раньше него заметок в MR быть не могло. */
  publishedAt?: number;
}

export type PollerEvent = JournalDataV1['forge.event'];

/** Заметка опроса, ещё не ставшая задачей: строка журнала + id объекта форжа и его время. */
export interface PolledNote {
  event: PollerEvent;
  objectId?: string;
  at: number;
}

/** Просьба открыть новую задачу ответов ревьюерам — одна на MR за опрос. */
export interface AnswerTaskRequest {
  fromTaskId: string;
  unitId: string;
  repo: string;
  remote: string;
  url: string;
  mrIid: number;
  /** Строки `forge.event`, которые откроют журнал новой задачи (причина её появления). */
  events: PollerEvent[];
}

/** MR в опросе и время, с которого его заметки ещё не разобраны. */
export interface PollEntry {
  mr: WatchedMr;
  from: number;
}

export interface MrPoll {
  mr: WatchedMr;
  /** Состояние MR на форже; `null` — не прочитано: этот круг MR не трогает. */
  state: ForgeMr['state'] | null;
  /** Новые заметки других учёток с `from` (без увиденных и прочитанных задачей ответов). */
  notes: PolledNote[];
}

export interface PollResult {
  mrs: MrPoll[];
  /** Время последнего события в ответе форжа, иначе нижняя граница запроса. */
  cursor: number;
}

function eventOf(a: ForgeActivity, mr: WatchedMr): PollerEvent {
  return {
    forgeEventId: `${a.type}:${a.id}`,
    type: a.type,
    target: `${mr.url} !${mr.mrIid}`,
    source: 'poller',
    mrIid: mr.mrIid,
    author: a.author,
  };
}

export function requestOf(mr: WatchedMr, notes: readonly PolledNote[]): AnswerTaskRequest {
  return {
    fromTaskId: mr.taskId,
    unitId: mr.unitId,
    repo: mr.repo,
    remote: mr.remote,
    url: mr.url,
    mrIid: mr.mrIid,
    events: notes.map((n) => n.event),
  };
}

/**
 * Один опрос одного форжа: одно чтение ленты с самой ранней `from` и состояние каждого MR.
 * `seen` — id событий, уже ставших задачей (окно запроса перекрывает прошлое — задержка ленты,
 * F7 — и повтор их не повторяет). Сбой чтения ленты — `unknown`: «не прочитал» не значит
 * «ревьюер молчит», и отметки не двигаются.
 */
export async function pollOnce(
  port: ForgePort,
  entries: readonly PollEntry[],
  seen: ReadonlySet<string>,
): Promise<Fact<PollResult>> {
  if (entries.length === 0) return { value: { mrs: [], cursor: 0 } };
  const since = Math.min(...entries.map((e) => e.from));
  const me = await port.whoAmI();
  if (!('value' in me)) return { unknown: 'unknown' in me ? me.unknown : 'forge account absent' };
  const activity = await port.activitySince({
    since,
    refs: [],
    mrIids: entries.map((e) => e.mr.mrIid),
  });
  if ('unknown' in activity) return activity;
  const list = 'value' in activity ? activity.value : [];
  const mrs: MrPoll[] = [];
  // Окно одно на проект (с самой ранней `from`): заметка MR раньше его отметки — уже задача
  // (`seen`), ждущая (`pending`) или прочитанная (`handled`); иначе она не разобрана и нужна.
  for (const { mr } of entries) {
    const read = await port.mr(mr.mrIid);
    const handled = new Set(mr.handled ?? []);
    const notes = list
      .filter((a) => a.mrIid === mr.mrIid && a.type === 'note')
      .filter((a) => a.author !== me.value.username)
      .filter((a) => a.objectId === undefined || !handled.has(a.objectId))
      .map((a): PolledNote => ({
        event: eventOf(a, mr),
        at: a.at,
        ...(a.objectId === undefined ? {} : { objectId: a.objectId }),
      }))
      .filter((n) => !seen.has(n.event.forgeEventId));
    mrs.push({ mr, state: 'value' in read ? read.value.state : null, notes });
  }
  let cursor = since;
  for (const a of list) cursor = Math.max(cursor, a.at);
  return { value: { mrs, cursor } };
}
