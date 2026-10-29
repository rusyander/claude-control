import type {
  CheckAnswer,
  CheckDecision,
  CheckEntry,
  CheckRequest,
} from '@agentdeck/contracts/core/records';
import { handOut } from './caller.ts';
import { flakyChain } from './flaky.ts';
import { message, quietly } from './helpers.ts';
import { move, requested } from './journal.ts';
import { lease, release } from './lease.ts';
import type { Contended, Gathered, Held, ServiceState } from './request.types.ts';
import { runOnce } from './run-once.ts';

/** Решение `run`: ключ «в полёте» → аренда слота → прогон ядра или выдача argv вызывающему. */
export async function execute(
  s: ServiceState,
  req: CheckRequest,
  g: Gathered,
  entry: CheckEntry,
  unit: string,
  asked: Extract<CheckDecision, { kind: 'run' }>,
  lockTimeout: boolean,
  answerBy: number,
): Promise<CheckAnswer | Contended> {
  const { deps } = s;
  // Разряд — по охвату, а не по фазе: прогон всей единицы (выборка пуста) посреди работы лежит
  // на ключе всей единицы, и итог обязан его повторить (04:57). `narrow` на этом ключе итог не
  // принял бы никогда, а повтор отдавал бы ту же запись по кругу.
  const decision =
    asked.grade === 'narrow' && asked.selection.length === 0
      ? { ...asked, grade: 'unit' as const }
      : asked;
  const key = 'value' in g.key ? g.key.value.key : null;
  const checkRunId = deps.newId();
  const claimed = key !== null && !lockTimeout;
  if (claimed) {
    const claim = await deps.queue
      .claimInflight(req.project, key, checkRunId)
      .catch((error: unknown) => ({
        claimed: false as const,
        hold: null,
        reason: message(error),
      }));
    if (!claim.claimed) return { contended: claim.hold, reason: claim.reason };
  }
  // От захвата до аренды: сбой записи очереди (ENOSPC) не оставляет ключ занятым прогоном,
  // которого нет, — иначе каждый следующий запрос ждал бы его до lock-timeout.
  let got: Awaited<ReturnType<typeof lease>>;
  try {
    requested(s, req, entry, unit, key, decision.grade, checkRunId);
    got = await lease(s, req, key, checkRunId, answerBy);
  } catch (error) {
    move(s, req, checkRunId, 'abort', 'queued', 'aborted');
    if (claimed) quietly(() => deps.queue.releaseInflight(req.project, key, checkRunId));
    return { kind: 'defer', until: 'slot', reason: `queue write failed: ${message(error)}` };
  }
  if ('gone' in got || 'budget' in got) {
    // Слота нет: ключ «в полёте» не держится за прогоном, которого не будет, — повторный
    // вопрос встанет в очередь заново.
    move(s, req, checkRunId, 'abort', 'queued', 'aborted');
    if (claimed) quietly(() => deps.queue.releaseInflight(req.project, key, checkRunId));
    return { kind: 'defer', until: 'slot', reason: 'gone' in got ? got.gone : got.budget };
  }
  move(s, req, checkRunId, 'lease', 'queued', 'leased');
  const held: Held = {
    lease: got.lease,
    key: claimed ? key : null,
    checkRunId,
    claimRunId: checkRunId,
  };

  if (req.exec === 'caller') {
    try {
      return await handOut(s, req, g, entry, unit, decision, held);
    } catch (error) {
      // До выдачи argv: аренда и ключ не остаются висеть за прогоном, которого никто не начнёт.
      move(s, req, checkRunId, 'abort', 'leased', 'aborted');
      release(s, req, held);
      return { kind: 'defer', until: 'slot', reason: `hand-out failed: ${message(error)}` };
    }
  }

  try {
    const first = await runOnce(s, req, g, entry, unit, decision.grade, decision.selection, held);
    if (first.recordId !== null && first.verdict.kind === 'fail' && decision.grade !== 'retry') {
      const flaky = await flakyChain(
        s,
        req,
        g,
        entry,
        unit,
        { ...first, recordId: first.recordId },
        held,
      );
      if (flaky) return flaky;
    }
    return {
      kind: 'ran',
      recordId: first.recordId,
      checkRunId,
      verdict: first.verdict,
      exit: first.result.exit,
      failing: first.result.failing,
      ...(first.note ? { note: first.note } : {}),
    };
  } finally {
    release(s, req, held);
  }
}
