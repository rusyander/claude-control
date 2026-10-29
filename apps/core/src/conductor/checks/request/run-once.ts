import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CheckEntry,
  CheckRecord,
  CheckRequest,
  RecordGrade,
  Verdict,
} from '@agentdeck/contracts/core/records';
import type { CheckRunEvent, CheckRunState } from '@agentdeck/contracts/core/states';
import { argvFor } from '../../../verifier/run/argv.ts';
import { deadlineOf } from '../../../verifier/run/deadline.ts';
import type { RunLease, RunResult } from '../../../verifier/run/run.types.ts';
import type { RecordDraft } from '../../../verifier/store/index.ts';
import {
  HISTORY_RUNS,
  beatMsOf,
  cwdOutside,
  judge,
  message,
  notRun,
  quietBeat,
  why,
} from './helpers.ts';
import { journal, move } from './journal.ts';
import type { Gathered, Held, ServiceState } from './request.types.ts';

/** Прогон ядра под арендой: срок по истории, готовность сервисов, запись исхода (G2). */

/**
 * Срок прогона по истории проверки и единицы поверх ключей (A1-F06): у каждой правки свой
 * ключ, и срок только своего ключа был бы всегда «по умолчанию». Снятые прогоны (срок, отмена)
 * поднимают срок до 2× своей длины (A1r3-F08). История не прочитана — записи ключа запроса.
 */
export function deadlineFor(g: Gathered, entry: CheckEntry, unit: string): number {
  const own = 'value' in g.records ? g.records.value : [];
  const across =
    'value' in g.store ? g.store.value.history(entry.id, unit) : { unknown: why(g.store) };
  const seen = new Map<string, CheckRecord>();
  for (const r of [...own, ...('value' in across ? across.value : [])]) seen.set(r.id, r);
  const mine = [...seen.values()]
    .filter((r) => r.checkId === entry.id && r.unit === unit)
    .sort((a, b) => a.startedAt - b.startedAt);
  const learned = mine.filter((r) => r.verdict.kind !== 'no-verdict').map((r) => r.ms);
  const aborted = mine
    .filter((r) => r.verdict.kind === 'no-verdict' && r.verdict.reason === 'aborted')
    .map((r) => r.ms);
  return deadlineOf(learned.slice(-HISTORY_RUNS), aborted.slice(-HISTORY_RUNS)).ms;
}

/** Запись исхода и переход машины (G2): запись на каждом исходе после аренды. */
export function settle(
  s: ServiceState,
  req: CheckRequest,
  g: Gathered,
  entry: CheckEntry,
  unit: string,
  grade: RecordGrade,
  checkRunId: string,
  from: CheckRunState,
  out: {
    result: RunResult;
    verdict: Verdict;
    argv: string[];
    startedAt: number;
    envPrepared: boolean;
  },
): { recordId: string | null; note?: string } {
  const { result, verdict } = out;
  const event: CheckRunEvent =
    verdict.kind !== 'no-verdict'
      ? 'record'
      : verdict.reason === 'aborted' && from === 'running'
        ? 'abort'
        : 'no-verdict';
  const to: CheckRunState =
    event === 'record' ? 'recorded' : event === 'abort' ? 'aborted' : 'no-verdict';
  let recordId: string | null = null;
  let note: string | undefined;
  if (!('value' in g.key)) note = `not recorded: ${why(g.key)}`;
  else if (!('value' in g.store)) note = `not recorded: store ${why(g.store)}`;
  else {
    const draft: RecordDraft = {
      key: g.key.value.key,
      parts: g.key.value.parts,
      checkId: entry.id,
      unit,
      grade,
      origin: req.origin,
      verdict,
      exit: result.exit,
      ms: result.ms,
      startedAt: out.startedAt,
      argv: out.argv,
      failing: result.failing,
      ...(result.passing ? { passing: result.passing } : {}),
      // Итог раннера — флаки повторяет только красный, где каждый упавший назван (A1r2-F04).
      ...(result.failedCount !== undefined ? { failedCount: result.failedCount } : {}),
      retries: [],
      // Восстановление артефактов ещё не построено: проверка, что их объявила, не повторяется (D§3.4).
      artifacts: entry.artifacts.length === 0 ? [] : null,
      envPrepared: out.envPrepared,
      standEpoch: result.standEpoch,
      taskId: req.taskId,
      checkRunId,
    };
    // Срезанный раннером вывод (2 МБ + метка) хранилище замечает само; срез обёртки — нет.
    const written = g.store.value.write(draft, result.log, result.truncated);
    if ('value' in written) {
      recordId = written.value;
      journal(s, req, {
        kind: 'check.recorded',
        stepId: req.stepId,
        data: { checkRunId, recordId },
      });
    } else note = `store refused the write: ${why(written)}`;
  }
  move(s, req, checkRunId, event, from, to);
  return note === undefined ? { recordId } : { recordId, note };
}

/**
 * Сервисы записи до прогона (04:124, P58): `null` — готовы или не нужны, иначе причина. Вход
 * не подключён — тоже причина: проверка с сервисами без них зелёной не бывает.
 */
export async function servicesUnready(
  s: ServiceState,
  req: CheckRequest,
  entry: CheckEntry,
): Promise<string | null> {
  const { deps } = s;
  if (entry.needs.length === 0) return null;
  const services = deps.services;
  if (!services) return 'services: not wired';
  // Через `then`: и синхронное исключение входа — названная причина, а не брошенный ответ.
  const got = await Promise.resolve()
    .then(() => services(req, entry.needs))
    .catch((error: unknown): Fact<never> => ({ unknown: message(error) }));
  return 'value' in got ? null : `services: ${why(got)}`;
}

/** Эпоха стенда; синхронное исключение тоже `null` — иначе оно вылетает мимо `catch`. */
export function epochOf(s: ServiceState, taskId: string): Promise<number | null> {
  const { deps } = s;
  return Promise.resolve()
    .then(() => deps.standEpoch(taskId))
    .catch(() => null);
}

/** Один прогон ядра под уже взятой арендой; `checkRunId` заведён и `leased` в журнале. */
export async function runOnce(
  s: ServiceState,
  req: CheckRequest,
  g: Gathered,
  entry: CheckEntry,
  unit: string,
  grade: RecordGrade,
  selection: string[],
  held: Held,
): Promise<{ recordId: string | null; verdict: Verdict; result: RunResult; note?: string }> {
  const { deps, run } = s;
  const startedAt = deps.now();
  const { argv, narrowed } = argvFor(entry, { unit, selection, base: null, files: [] });
  const env = await deps.env(req);
  const unready =
    cwdOutside(req.copyDir, entry.cwd) ??
    ('value' in env ? await servicesUnready(s, req, entry) : `task env pin: ${why(env)}`);
  const beat: RunLease = {
    leaseId: held.lease.leaseId,
    beatMs: beatMsOf(deps),
    // Удар идёт из таймера раннера: исключение записи не должно дойти до процесса.
    heartbeat: () => {
      const key = held.key;
      if (key) quietBeat(() => deps.queue.beatInflight(req.project, key, held.claimRunId));
      return quietBeat(() => deps.queue.heartbeat(held.lease.leaseId));
    },
  };
  let result: RunResult;
  let from: CheckRunState = 'leased';
  if (unready !== null || !('value' in env)) {
    result = notRun(unready ?? 'task env pin');
  } else {
    move(s, req, held.checkRunId, 'start', 'leased', 'running');
    from = 'running';
    const signal = deps.signal?.(req);
    result = await run(
      {
        checkRunId: held.checkRunId,
        taskId: req.taskId,
        entry,
        argv,
        cwd: entry.cwd === '' ? req.copyDir : `${req.copyDir}/${entry.cwd}`,
        env: env.value,
        tempRoot: deps.tempRoot,
        deadlineMs: deadlineFor(g, entry, unit),
      },
      beat,
      { now: deps.now, standEpoch: deps.standEpoch, ...(signal ? { signal } : {}) },
    );
  }
  const judged = judge(entry, narrowed, result);
  const verdict = judged.verdict;
  const settled = settle(s, req, g, entry, unit, grade, held.checkRunId, from, {
    result: judged.result,
    verdict,
    argv,
    startedAt,
    envPrepared: 'value' in env,
  });
  // Прогона не было — причина (сервис, пин окружения, процесс не запустился) идёт модели,
  // а не одно «env»: лог записи её называет, но модель видит только ответ.
  const note = judged.note ?? settled.note ?? unready ?? judged.result.reason;
  return { ...settled, ...(note ? { note } : {}), verdict, result: judged.result };
}
