import {
  parseStepDone,
  type ModelToolReply,
  type StepDoneCall,
} from '@agentdeck/contracts/core/model-tools';
import type { LiveTask } from '../../journal/resume.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ModelToolDeps, RecordFacts, SessionBinding } from './model-tools.types.ts';

/**
 * `step_done` (03 §Model tools, P72 P08). Ошибки полей отдаются ОДИН раз: повторный неверный
 * вызов того же шага получает отказ без списка и считается отказом (сигнал в журнале — по нему
 * наблюдатель видит «тот же отказ дважды»). Счёт — из журнала, а не из памяти ядра: перезапуск
 * ядра не дарит модели второй список.
 *
 * Принятое заявление пишется целиком одной строкой `step.claimed`, которая сама переводит шаг
 * в проверку фактов после шага (02 §Conductor loop); свёртка читает заявление из неё. Требование «покрыто» только записями
 * проверок: нет записи, она красная, без вердикта или не читается — отказ всего заявления.
 */

export const STEP_DONE_INVALID = 'step-done-invalid';
export const STEP_DONE_REFUSED = 'step-done-refused';

function priorInvalid(task: LiveTask, stepId: string): number {
  return readJournalLines(task.dir, task.taskId).lines.filter(
    (l) =>
      l.kind === 'signal' &&
      l.stepId === stepId &&
      (l.data as { signal: string }).signal === STEP_DONE_INVALID,
  ).length;
}

function refuse(
  task: LiveTask,
  b: SessionBinding,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ModelToolReply {
  task.append({
    kind: 'signal',
    actor: `session:${b.sessionId}`,
    stepId: b.stepId,
    sessionId: b.sessionId,
    data: {
      signal: STEP_DONE_REFUSED,
      severity: 'warn',
      subject: b.stepId,
      detail: `${code}: ${message}`,
    },
  });
  return { ok: false, code, message, ...extra };
}

type EvidenceProblem = { requirement: string; recordId: string; problem: string };

/**
 * Почему запись не доказывает требование этой задачи: вердикт, затем привязка — запись другой
 * задачи (или без задачи), исполненная не ядром (сеанс, спул, чужой CLI — 02:61) или по argv вне
 * реестра (`captured:` — производная запись дорог захвата).
 */
function problemOf(fact: Fact<RecordFacts>, taskId: string): string | null {
  if ('absent' in fact) return 'missing';
  if ('unknown' in fact) return `unreadable: ${fact.unknown}`;
  const rec = fact.value;
  if (rec.verdict === 'fail') return 'red';
  if (rec.verdict === 'no-verdict') return 'no-verdict';
  if (rec.taskId !== taskId) return 'foreign task: the record was not written by this task';
  if (rec.origin !== 'core') return `not a core run (origin ${rec.origin}): feedback, not evidence`;
  if (rec.checkId.startsWith(DERIVED_PREFIX))
    return `not a registry check (${rec.checkId}): call check by checkId`;
  return null;
}

const DERIVED_PREFIX = 'captured:';

function evidenceProblems(
  call: StepDoneCall,
  taskId: string,
  deps: ModelToolDeps,
): EvidenceProblem[] {
  const problems: EvidenceProblem[] = [];
  for (const req of call.requirements) {
    if (req.state !== 'covered') continue;
    for (const recordId of req.evidence) {
      const problem = problemOf(deps.records(recordId, taskId), taskId);
      if (problem) problems.push({ requirement: req.id, recordId, problem });
    }
  }
  return problems;
}

export function stepDone(
  task: LiveTask,
  b: SessionBinding,
  input: unknown,
  deps: ModelToolDeps,
): ModelToolReply {
  const parsed = parseStepDone(input, b.stepKind);
  if (!parsed.ok) {
    const prior = priorInvalid(task, b.stepId);
    task.append({
      kind: 'signal',
      actor: `session:${b.sessionId}`,
      stepId: b.stepId,
      sessionId: b.sessionId,
      data: {
        signal: STEP_DONE_INVALID,
        severity: prior === 0 ? 'info' : 'warn',
        subject: b.stepId,
        detail: `refusal ${prior + 1}: ${parsed.issues.map((i) => `${i.path || '(call)'} ${i.code}`).join(', ')}`,
      },
    });
    if (prior === 0) {
      return {
        ok: false,
        code: 'invalid',
        message: 'step_done failed its schema; the field errors below are given once',
        issues: parsed.issues,
      };
    }
    return {
      ok: false,
      code: 'invalid-repeat',
      message: `step_done invalid again (refusal ${prior + 1}); the field errors were given on the first call`,
    };
  }
  const call = parsed.value;
  if (call.stepId !== b.stepId) {
    return refuse(task, b, 'foreign-step', 'stepId is not the step of this session');
  }
  const step = task.state.steps[b.stepId];
  if (!step || step.state !== 'running') {
    return refuse(task, b, 'step-not-running', `step is ${step?.state ?? 'unknown'}`);
  }
  const problems = evidenceProblems(call, task.taskId, deps);
  if (problems.length) {
    return refuse(
      task,
      b,
      'evidence-rejected',
      'covered requirements must cite green check records',
      {
        issues: problems.map((p) => ({
          path: `requirements.${p.requirement}`,
          code: 'invalid-field',
          message: `${p.recordId}: ${p.problem}`,
        })),
      },
    );
  }
  // Одна строка-решение (fsync до ответа модели): заявление и переход в проверку разом.
  const claimed = task.append({
    kind: 'step.claimed',
    actor: `session:${b.sessionId}`,
    stepId: b.stepId,
    sessionId: b.sessionId,
    data: { stepId: b.stepId, sessionId: b.sessionId, claim: call },
  });
  return { ok: true, result: { accepted: true, seq: claimed.seq, next: 'post-step facts check' } };
}
