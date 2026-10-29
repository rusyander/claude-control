import type {
  CheckAnswer,
  CheckDecision,
  CheckEntry,
  CheckRequest,
} from '@agentdeck/contracts/core/records';
import { argvFor } from '../../../verifier/run/argv.ts';
import { parseFailing, passingOf } from '../../../verifier/run/failing.ts';
import type { RunResult } from '../../../verifier/run/run.types.ts';
import type { CallerResult } from '../checks.types.ts';
import { beatMsOf, cwdOutside, judge, notRun, quietBeat } from './helpers.ts';
import { move } from './journal.ts';
import { release } from './lease.ts';
import type { Gathered, Held, ServiceState } from './request.types.ts';
import { deadlineFor, epochOf, servicesUnready, settle } from './run-once.ts';

/** Дороги захвата (`exec: 'caller'`, 03:124): выдача argv под арендой и запись ответа вызывающего. */

/** Дороги захвата: argv отдан вызывающему, ядро держит аренду и ключ живыми до его ответа. */
export async function handOut(
  s: ServiceState,
  req: CheckRequest,
  g: Gathered,
  entry: CheckEntry,
  unit: string,
  decision: Extract<CheckDecision, { kind: 'run' }>,
  held: Held,
): Promise<CheckAnswer> {
  const { deps, pending } = s;
  const { argv, narrowed } = argvFor(entry, {
    unit,
    selection: decision.selection,
    base: null,
    files: [],
  });
  // cwd вне копии или сервисы не поднялись — вызывающему нечего запускать: запись
  // no-verdict(env), аренда снята.
  const unready = cwdOutside(req.copyDir, entry.cwd) ?? (await servicesUnready(s, req, entry));
  if (unready !== null) {
    try {
      const judged = judge(entry, narrowed, notRun(unready));
      const settled = settle(s, req, g, entry, unit, decision.grade, held.checkRunId, 'leased', {
        result: judged.result,
        verdict: judged.verdict,
        argv,
        startedAt: deps.now(),
        envPrepared: false,
      });
      return {
        kind: 'ran',
        recordId: settled.recordId,
        checkRunId: held.checkRunId,
        verdict: judged.verdict,
        exit: null,
        failing: [],
        note: unready,
      };
    } finally {
      release(s, req, held);
    }
  }
  const deadlineMs = deadlineFor(g, entry, unit);
  const epochBefore = await epochOf(s, req.taskId);
  // Таймеры живут вне любого ответа: исключение в них уронило бы весь процесс ядра.
  const timer = setInterval(() => {
    quietBeat(() => deps.queue.heartbeat(held.lease.leaseId));
    const key = held.key;
    if (key) quietBeat(() => deps.queue.beatInflight(req.project, key, held.claimRunId));
  }, beatMsOf(deps));
  const deadline = setTimeout(() => {
    // Вызывающий не ответил в срок: прогон снят, запись no-verdict(aborted) (G2). Сбой записи
    // исхода не роняет ядро: аренда и ключ снимаются в `finish` при любом исходе.
    finish(s, held.checkRunId, { exit: null, ms: deadlineMs, log: '' }, 'deadline').catch(
      () => undefined,
    );
  }, deadlineMs);
  timer.unref?.();
  deadline.unref?.();
  move(s, req, held.checkRunId, 'start', 'leased', 'running');
  pending.set(held.checkRunId, {
    req,
    g,
    entry,
    unit,
    grade: decision.grade,
    argv,
    narrowed,
    held,
    startedAt: deps.now(),
    epochBefore,
    timer,
    deadline,
  });
  return {
    kind: 'leased',
    leaseId: held.lease.leaseId,
    checkRunId: held.checkRunId,
    argv,
    deadlineMs,
  };
}

export async function finish(
  s: ServiceState,
  checkRunId: string,
  result: CallerResult,
  end: 'exit' | 'deadline',
): Promise<CheckAnswer> {
  const { pending } = s;
  const p = pending.get(checkRunId);
  if (!p)
    return {
      kind: 'refuse',
      unmet: [
        {
          code: 'record-missing',
          subject: `check run ${checkRunId} is not held`,
          next: 'request the check again',
        },
      ],
      next: 'request the check again',
    };
  pending.delete(checkRunId);
  clearInterval(p.timer);
  clearTimeout(p.deadline);
  try {
    const epochAfter = await epochOf(s, p.req.taskId);
    const run: RunResult = {
      end,
      exit: result.exit,
      signal: result.signal ?? null,
      ms: result.ms,
      log: result.log,
      logBytes: Buffer.byteLength(result.log),
      truncated: result.truncated === true,
      failing:
        end === 'exit' && result.exit !== 0 ? parseFailing(p.entry.filter?.kind, result.log) : [],
      ...passingOf(end, p.entry.filter?.kind, result.log),
      standEpoch: epochAfter,
      standMoved: p.epochBefore !== null && epochAfter !== null && p.epochBefore !== epochAfter,
      temp: { removed: true },
    };
    const judged = judge(p.entry, p.narrowed, run);
    const verdict = judged.verdict;
    const settled = settle(s, p.req, p.g, p.entry, p.unit, p.grade, checkRunId, 'running', {
      result: judged.result,
      verdict,
      argv: p.argv,
      startedAt: p.startedAt,
      // Окружение сеанса ядро не готовило: такая запись не составляет итог (04:13).
      envPrepared: false,
    });
    return {
      kind: 'ran',
      recordId: settled.recordId,
      checkRunId,
      verdict,
      exit: run.exit,
      failing: run.failing,
      ...((judged.note ?? settled.note) ? { note: judged.note ?? settled.note } : {}),
    };
  } finally {
    release(s, p.req, p.held);
  }
}
