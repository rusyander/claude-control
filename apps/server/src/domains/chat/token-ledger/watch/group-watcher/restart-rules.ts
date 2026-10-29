import type { GroupWatch } from '@agentdeck/contracts/group-watch';
import { clip, EVENT_HOLD_MS, MINUTE_MS } from '../rules-util.ts';
import { absolutePath, normPath } from '../reduce-util.ts';
import type { RuleHit, WatchContext, WatchEvent } from '../watch.types.ts';

/**
 * Перезапуски сервера панели (внешний сторож, restarts.mjs): R38 — правка группы держит
 * перезапуск, R39 — перезапусков за час столько, что сам перезапуск и есть беда. Каждый
 * перезапуск рвёт или стопорит все живые прогоны панели (24.10: 362 за сутки).
 * Чистые функции: журнал и состояние сторожа dev-watch читает `dev-restarts.ts`.
 */

/**
 * Перезапуск, случившийся по журналу dev-watch: когда и из-за каких файлов (журнал называет
 * первые три). `deferredAt` — с какой минуты он ждал конца ходов, если ждал.
 */
export interface DevRestart {
  at: number;
  files: readonly string[];
  deferredAt?: number;
}

/** Что известно о перезапусках: случившиеся и тот, что ждёт конца ходов. */
export interface RestartFeed {
  done: readonly DevRestart[];
  pending?: { since: number; files: readonly string[] };
}

/** Правка файла группой: когда и что (путь сведён `normPath`). */
export interface EditedFile {
  at: number;
  path: string;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Файл, который правит вызов звена или его субагента (инструментом правки), — сведённый путь. */
export function editedFileOf(event: WatchEvent, ctx: WatchContext): EditedFile | undefined {
  if (event.kind !== 'tool' || !EDIT_TOOLS.has(event.name)) return undefined;
  const raw = event.input.file_path ?? event.input.notebook_path;
  const path = typeof raw === 'string' ? absolutePath(raw, ctx) : undefined;
  return path ? { at: event.t, path } : undefined;
}

/** Правка группы «вызвала» перезапуск, если была не раньше десяти минут до него (restarts.mjs:12). */
export const RESTART_EDIT_WINDOW_MS = 10 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
/** Строка журнала: `<ISO> перезапуск: a, b, c и ещё N` (dev-watch.mjs, `log(перезапуск: …)`). */
const RESTART_LINE = /^(\S+) перезапуск: (.+)$/;
/** Начало ожидания: `<ISO> правки ждут конца идущих ходов… — перезапуск [без предела] отложен`. */
const DEFER_LINE = /^(\S+) правки ждут .*отложен$/;
/** Ожидание кончилось без перезапуска: мутанты вернулись, сборка не поднялась. */
const DEFER_END = /перезапуск не нужен|не поднимается|не прошла/;

/**
 * Случившиеся перезапуски из текста журнала. Отложенный («перезапуск отложен»), ненужный
 * («перезапуск не нужен») и просьба человека строкой `перезапуск: …` не пишутся —
 * сам перезапуск идёт за ними отдельной строкой. Строка отсрочки перед ним — начало
 * ожидания (`deferredAt`); ненужный перезапуск и не поднявшаяся сборка его снимают.
 */
export function parseDevRestarts(text: string): DevRestart[] {
  const out: DevRestart[] = [];
  let deferredAt: number | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const deferral = DEFER_LINE.exec(line);
    if (deferral) {
      const at = Date.parse(deferral[1]!);
      deferredAt = Number.isFinite(at) ? at : undefined;
      continue;
    }
    if (DEFER_END.test(line)) deferredAt = undefined;
    const match = RESTART_LINE.exec(line);
    if (!match) continue;
    const at = Date.parse(match[1]!);
    if (!Number.isFinite(at)) continue;
    const files = match[2]!
      .replace(/ и ещё \d+$/, '')
      .split(', ')
      .map((file) => file.trim())
      .filter(Boolean);
    const waited = deferredAt !== undefined && deferredAt <= at;
    out.push({ at, files, ...(waited ? { deferredAt } : {}) });
    deferredAt = undefined;
  }
  return out;
}

/** Файлы перезапуска, которые группа правила с `from` по `to`: показанные пути без повторов. */
function editedOf(
  files: readonly string[],
  edits: readonly EditedFile[],
  from: number,
  to: number,
): { shown: string[]; since: number } | undefined {
  const byPath = new Map(files.map((file) => [normPath(file), file]));
  const ours = edits.filter((edit) => edit.at >= from && edit.at <= to && byPath.has(edit.path));
  if (ours.length === 0) return undefined;
  return {
    shown: [...new Set(ours.map((edit) => byPath.get(edit.path)!))],
    since: Math.min(...ours.map((edit) => edit.at)),
  };
}

/**
 * R38 — перезапуск ждёт правки этой группы: файлы отложенного перезапуска, которые группа
 * правила за десять минут до его начала или после; `waitMin` — сколько он уже ждёт. Ждущего
 * нет — случившийся за полчаса перезапуск из-за её правок (`R38done`): правки группы
 * переживают перезапуск в файле сторожа, журнал называет файлы и начало ожидания,
 * `othersAt` — сколько ещё живых групп шло в ту минуту.
 */
export function restartByGroup(
  feed: RestartFeed | undefined,
  edits: readonly EditedFile[],
  now: number,
  othersAt: (at: number) => number = () => 0,
): RuleHit | undefined {
  const pending = feed?.pending;
  if (pending && pending.files.length > 0) {
    const ours = editedOf(pending.files, edits, pending.since - RESTART_EDIT_WINDOW_MS, now);
    if (ours) {
      return {
        rule: 'R38',
        severity: 'info',
        textKey: 'groupWatch.rule.R38wait',
        numbers: {
          files: ours.shown.length,
          waiting: pending.files.length,
          waitMin: Math.max(0, Math.floor((now - pending.since) / MINUTE_MS)),
        },
        params: { path: clip(ours.shown[0]!) },
        since: ours.since,
      };
    }
  }
  const done = feed?.done ?? [];
  for (let i = done.length - 1; i >= 0; i -= 1) {
    const restart = done[i]!;
    if (restart.at > now) continue;
    if (now - restart.at > EVENT_HOLD_MS) break;
    const start = restart.deferredAt ?? restart.at;
    const ours = editedOf(restart.files, edits, start - RESTART_EDIT_WINDOW_MS, restart.at);
    if (!ours) continue;
    return {
      rule: 'R38',
      severity: 'info',
      textKey: 'groupWatch.rule.R38done',
      numbers: {
        files: ours.shown.length,
        waitMin: Math.round((restart.at - start) / MINUTE_MS),
        others: othersAt(restart.at),
      },
      params: { path: clip(ours.shown[0]!) },
      since: restart.at,
    };
  }
  return undefined;
}

/**
 * R39 — перезапусков за последний час не меньше `restartStorm`: каждый стопорит все живые
 * прогоны, ищи, что пишет в обслуживаемое дерево. Держится, пока за час их столько.
 *
 * `from` — с какого момента группа идёт (старт, нажатая перепроверка): перезапуск до него
 * её ничем не задел. Живой прогон 27.10: семь перезапусков от правок, пока ни одна группа
 * не шла, всплыли бурей у трёх перепроверок, нажатых позже.
 *
 * `paused` — отрезки пауз группы `[from, to)`: перезапуск на паузе тоже её не задел, а в
 * миг «Продолжить» — задел. Живой прогон 27.10 18:27: три перезапуска от правок сторожа,
 * пока группы стояли на паузе, всплыли бурей сразу после продолжения.
 */
export function restartStorm(
  feed: RestartFeed | undefined,
  settings: GroupWatch,
  now: number,
  from = 0,
  paused: readonly { from: number; to: number }[] = [],
): RuleHit | undefined {
  const hour = (feed?.done ?? []).filter(
    (one) =>
      one.at <= now &&
      now - one.at < HOUR_MS &&
      one.at >= from &&
      !paused.some((span) => one.at >= span.from && one.at < span.to),
  );
  if (hour.length < settings.restartStorm) return undefined;
  const sorted = hour.map((one) => one.at).sort((a, b) => a - b);
  return {
    rule: 'R39',
    severity: 'info',
    numbers: { restarts: hour.length },
    since: sorted[settings.restartStorm - 1]!,
  };
}
