import type { BoardEntry } from '@agentdeck/contracts/core/board';
import { newId } from '../../lib/ids/uuidv7.ts';
import { openAnswerTaskFromMr, type MrReader } from '../estimate/answer-from-mr.ts';
import { ANSWER_REVIEWERS_PRESET } from '../estimate/estimate.ts';
import type { SplitEnv } from '../estimate/estimate.types.ts';
import type { TaskRegistry } from '../tasks.ts';
import { anyWaiting, inWorkOf, startsToday } from './gates.ts';
import type { LaunchDeps, Launcher, StartOutcome } from './launch.types.ts';
import { checkStartProof } from './proof.ts';
import { boardEntryOf } from './start.ts';

/**
 * Запускатель доски (этап 12, P154–P156): стартует голову очереди, пока доска не на паузе, никто
 * не ждёт человека (если так настроено), стартов за местные сутки меньше предела и задач «в
 * работе» меньше предела. Голова — запись очереди с наименьшим рангом. Перед стартом —
 * доказательство (P183) и окно маршрута головы: окно держит — не стартует никто (очередь — это
 * порядок, следующая запись не обгоняет голову), голова несёт причину. Старт — тот же путь, что у
 * человека (оценка или ревью по ссылке) с ключом повтора записи: крах посреди старта и повтор
 * после перезапуска находят ту же задачу, а не открывают вторую.
 *
 * Такт — один за раз: пришедший во время такта просит ещё один круг, а не второй параллельный.
 */

/**
 * Дорога старта записи по пресету (P164): «ответить ревьюерам» — своя (`answerFromMr`), прочее —
 * общий старт (оценка или ревью по ссылке). Ссылка «ответить ревьюерам» в ревью по ссылке не идёт
 * никогда: там другая задача над тем же MR.
 */
function startRoad(entry: BoardEntry, deps: LaunchDeps): Promise<StartOutcome> {
  if (entry.preset !== ANSWER_REVIEWERS_PRESET) return deps.start(entry);
  if (!deps.answerFromMr)
    return Promise.resolve({
      refused: 'answering reviewers from the board is not wired in this core',
    });
  return deps.answerFromMr(entry);
}

export interface AnswerEntryDeps {
  registry: TaskRegistry;
  split(): SplitEnv | undefined;
  reader: MrReader;
}

/** Старт записи «мой MR с открытыми нитями» дорогой ответов ревьюерам (ключ повтора — `entry.cmdId`). */
export async function startAnswerEntry(
  entry: BoardEntry,
  deps: AnswerEntryDeps,
): Promise<StartOutcome> {
  const cmdId = entry.cmdId;
  if (!cmdId) return { refused: 'start without a replay key' };
  if (entry.launch.kind !== 'link') return { refused: 'answering reviewers needs an MR link' };
  if (!entry.launch.repo) return { refused: 'no local repository for the MR link' };
  const env = deps.split();
  if (!env) return { refused: 'the conductor is not running in this core' };
  const boardEntry = boardEntryOf(entry);
  if ('refused' in boardEntry) return boardEntry;
  const got = await openAnswerTaskFromMr(
    { cmdId, mrUrl: entry.launch.mrUrl, repo: entry.launch.repo, boardEntry },
    deps.reader,
    deps.registry,
    env,
  );
  return 'opened' in got ? { taskId: got.opened } : { refused: got.refused.join('; ') };
}

export function createLauncher(deps: LaunchDeps): Launcher {
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  const save = (entryId: string, change: (e: BoardEntry) => void): void => {
    deps.store.update(null, deps.now(), (file) => {
      const entry = file.entries.find((e) => e.entryId === entryId);
      if (!entry) return { ok: false, refusal: 'gone' };
      change(entry);
      return { ok: true };
    });
  };

  /** Запись обратно во «Входящие» с причиной: старт не случился, место и сутки не тратятся. */
  const backToInbox = (entryId: string, reason: string): void => {
    save(entryId, (e) => {
      e.state = 'inbox';
      e.reason = reason.slice(0, 2000);
      delete e.proof;
      delete e.cmdId;
      delete e.startedAt;
    });
    deps.note(`board: entry ${entryId} back to inbox: ${reason}`);
  };

  const finish = (entryId: string, outcome: StartOutcome): void => {
    if ('taskId' in outcome) {
      save(entryId, (e) => {
        e.state = 'started';
        e.taskId = outcome.taskId;
      });
      return;
    }
    backToInbox(entryId, outcome.refused);
  };

  const start = async (entry: BoardEntry): Promise<void> => {
    let outcome: StartOutcome;
    try {
      outcome = await startRoad(entry, deps);
    } catch (error) {
      outcome = { refused: `start failed: ${(error as Error).message}` };
    }
    finish(entry.entryId, outcome);
  };

  /** Старт, оборванный крахом: тот же путь с тем же ключом повтора — та же задача (G5). */
  const resumeStarting = async (): Promise<void> => {
    for (const e of deps.store.read().entries) {
      if (stopped) return;
      if (e.state === 'starting' && e.cmdId) await start(e);
    }
  };

  /** Один круг: стартовать, сколько можно; `false` — стартовать больше нечего или нельзя. */
  const startOne = async (): Promise<boolean> => {
    const section = deps.section();
    if ('unknown' in section) {
      deps.note(`board: launcher idle, config unreadable: ${section.unknown}`);
      return false;
    }
    const limits = section.value;
    if (limits.paused) return false;
    const file = deps.store.read();
    const { states } = deps.tasks.states();
    if (limits.stopOnQuestion && anyWaiting(states)) return false;
    const now = deps.now();
    if (limits.perDay !== null && startsToday(file.entries, now) >= limits.perDay) return false;
    if (inWorkOf(states, file.entries) >= limits.inWork) return false;
    const head = file.entries
      .filter((e) => e.state === 'queued')
      .sort((a, b) => a.rank - b.rank)[0];
    if (!head) return false;
    const proof = checkStartProof(head, deps.proof);
    if (!proof.ok) {
      backToInbox(head.entryId, proof.reason);
      return true;
    }
    const route = deps.route(head);
    if ('hold' in route) {
      if (head.reason !== route.hold) save(head.entryId, (e) => void (e.reason = route.hold));
      return false;
    }
    const cmdId = newId();
    save(head.entryId, (e) => {
      e.state = 'starting';
      e.cmdId = cmdId;
      e.startedAt = now;
      if (route.hint) e.reason = route.hint;
      else delete e.reason;
    });
    await start({ ...head, state: 'starting', cmdId, startedAt: now });
    return true;
  };

  const run = async (): Promise<void> => {
    await resumeStarting();
    do {
      again = false;
      while (!stopped && (await startOne()));
    } while (again && !stopped);
  };

  return {
    tick() {
      if (stopped) return Promise.resolve();
      if (running) {
        again = true;
        return running;
      }
      running = run()
        .catch((error: unknown) => deps.note(`board: launcher tick failed: ${String(error)}`))
        .finally(() => {
          running = null;
        });
      return running;
    },
    async stop() {
      stopped = true;
      await running;
    },
  };
}
