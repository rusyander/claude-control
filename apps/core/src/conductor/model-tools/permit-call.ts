import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { decidePermit } from '../../policy/permit/permit.ts';
import { judgePermitCall, raisePermitPoint } from '../human/permit-point.ts';
import type { PermitCallDeps, SessionBinding } from './model-tools.types.ts';

/**
 * Ответ на вопрос CLI о праве (`agentdeck-permit`, 06 §Session permissions, R:S3-09). Мост
 * MCP только спрашивает — решает `policy/permit` здесь, в ядре. Вопрос законен лишь как ответ
 * на запрос инструмента, который модель уже сделала и который ещё не исполнен; всё прочее —
 * подделка полномочий: отказ и `signal forged-authority` (P41). Вопрос модели к самому
 * серверу права — тоже подделка: в списке инструментов модели его нет (`--disallowedTools`
 * переходника), и вызов в обход — попытка выдать себе разрешение.
 */

export const FORGED_AUTHORITY = 'forged-authority';

export type PermitCallOutcome =
  | { kind: 'forged'; reason: string; reply: unknown }
  | { kind: 'decided'; allow: boolean; reply: unknown };

export async function answerPermitCall(
  task: LiveTask,
  b: SessionBinding,
  raw: unknown,
  deps: PermitCallDeps,
): Promise<PermitCallOutcome> {
  const forged = (subject: string, reason: string): PermitCallOutcome => {
    task.append({
      kind: 'signal',
      actor: `session:${b.sessionId}`,
      stepId: b.stepId,
      sessionId: b.sessionId,
      data: { signal: FORGED_AUTHORITY, severity: 'stop', subject, detail: reason },
    });
    return {
      kind: 'forged',
      reason,
      reply: deps.codec.render({ allow: false, message: `Refused: ${reason}.` }),
    };
  };

  const read = deps.codec.read(raw);
  if (!read) return forged('permit', 'permission call names no tool call');
  const claim = await deps.gate.claim(b.sessionId, read.toolUseId, read.call.tool, deps.settleMs);
  if (!claim.pending) return forged(`permit:${read.toolUseId}`, claim.reason);

  const ask = deps.mapPermission(read.call);
  const { decision, ledger } = judgePermitCall(task, b, ask, deps.context, (ctx) =>
    decidePermit(ask, ctx, b.stepKind),
  );
  const decided = task.append({
    kind: 'decision',
    actor: 'core',
    stepId: b.stepId,
    sessionId: b.sessionId,
    data: {
      decisionId: newId(),
      class: 'permit',
      inputs: [],
      facts: [],
      numbers: {},
      reasons: [decision.reason],
      // id вызова CLI — тот же, что у строки хука того же вызова: наблюдатель не считает отказ дважды.
      output: {
        ...decision,
        action: ask.action,
        target: ask.target,
        tool: ask.tool,
        toolUseId: read.toolUseId,
      },
    },
  });
  if (decision.allow && decision.signal) {
    task.append({
      kind: 'signal',
      actor: 'core',
      stepId: b.stepId,
      sessionId: b.sessionId,
      cause: decided.seq,
      data: {
        signal: decision.signal,
        severity: 'warn',
        subject: ask.target,
        detail: decision.reason,
      },
    });
  }
  // Отказ с пунктом человека — не только отказ: шаг ждёт ответа (P130), один вопрос на запрос.
  raisePermitPoint(task, b, ask, decision, ledger, deps.context.copyRoot);
  const reply = decision.allow
    ? deps.codec.render({ allow: true, input: read.call.input })
    : deps.codec.render({ allow: false, message: `Denied by the platform: ${decision.reason}.` });
  return { kind: 'decided', allow: decision.allow, reply };
}
