import type { Fact } from '@agentdeck/contracts/core/facts';
import {
  parseStepDone,
  type FieldIssue,
  type ModelToolReply,
  type StepDoneCall,
} from '@agentdeck/contracts/core/model-tools';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import {
  applyExtraction,
  evidenceProblem,
  requirementsInputOf,
  type EvidenceNow,
  type JudgedInput,
} from '../requirements/index.ts';
import type { ModelToolDeps, SessionBinding } from './model-tools.types.ts';

/**
 * `step_done` (03 §Model tools, P72 P08 P92, G3 G4 G22). Ошибки полей отдаются ОДИН раз: повторный
 * неверный вызов того же шага (схема или доказательство) получает отказ без списка и считается
 * отказом (сигнал в журнале — по нему наблюдатель видит «тот же отказ дважды»). Счёт — из журнала,
 * а не из памяти ядра: перезапуск ядра не дарит модели второй список.
 *
 * Асинхронный (G22): «покрыто» стоит только на записи, чей ключ равен ключу проверки на текущем
 * дереве копии, чьё замыкание пересекает файлы, изменённые единицей, и не статической (P92).
 * Требование цитируется id ядра: неизвестный id — ошибка поля (G3).
 *
 * Принятое заявление пишется целиком одной строкой `step.claimed`, которая сама переводит шаг
 * в проверку фактов после шага (02 §Conductor loop); следом — извлечение шага (id выдаёт ядро),
 * их модель получает в ответе.
 */

export const STEP_DONE_INVALID = 'step-done-invalid';
export const STEP_DONE_REFUSED = 'step-done-refused';

/**
 * Шаг уже остановлен сигналом (`steps[id].stops`, строка `signal` с `stop-step`), но ещё в
 * `running`: дирижёр сначала снимает дерево сессии, и это секунды — модель успевала сдать
 * `step_done`, шаг уходил в `checking`, а стенд видел «заявлено» вместо остановки (этап 8, живой
 * прогон claude `waste-fail-repeat`). Заявление после остановки отказано с её причиной.
 */
export const STEP_STOPPED = 'step-stopped';

function stoppedBy(task: LiveTask, stepId: string): string | null {
  const stops = task.state.steps[stepId]?.stops ?? [];
  return stops.length > 0 ? `step stopped: ${stops.join('; ')}` : null;
}

function priorInvalid(task: LiveTask, stepId: string): number {
  return readJournalLines(task.dir, task.taskId).lines.filter(
    (l) =>
      l.kind === 'signal' &&
      l.stepId === stepId &&
      (l.data as { signal: string }).signal === STEP_DONE_INVALID,
  ).length;
}

function refuse(task: LiveTask, b: SessionBinding, code: string, message: string): ModelToolReply {
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
  return { ok: false, code, message };
}

/** Доказательство не принято: тот же сигнал отказа, что у чужого шага, плюс поля с причинами. */
function evidenceRefusal(task: LiveTask, b: SessionBinding, issues: FieldIssue[]): ModelToolReply {
  refuse(task, b, 'evidence-rejected', issues.map((i) => `${i.path} ${i.message}`).join('; '));
  return {
    ok: false,
    code: 'evidence-rejected',
    message:
      'covered requirements must cite current, relevant green check records of this task; see the field errors',
    issues,
  };
}

/** Неверный вызов — раз со списком полей, потом счётный отказ без списка (P72). */
function invalidCall(
  task: LiveTask,
  b: SessionBinding,
  code: 'invalid',
  issues: FieldIssue[],
): ModelToolReply {
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
      detail: `refusal ${prior + 1}: ${issues.map((i) => `${i.path || '(call)'} ${i.code}`).join(', ')}`,
    },
  });
  if (prior === 0) {
    return {
      ok: false,
      code,
      message: 'step_done is invalid; the field errors below are given once',
      issues,
    };
  }
  return {
    ok: false,
    code: 'invalid-repeat',
    message: `step_done invalid again (refusal ${prior + 1}); the field errors were given on the first call`,
  };
}

const NO_READER = 'no key reader: the verifier is not wired, freshness of a record is unproven';

/** Ошибки полей по требованиям: неизвестный id, сверка своего же извлечения, доказательства. */
async function claimIssues(
  task: LiveTask,
  b: SessionBinding,
  call: StepDoneCall,
  view: JudgedInput,
  deps: ModelToolDeps,
): Promise<FieldIssue[]> {
  const issues: FieldIssue[] = [];
  const known = new Set(view.requirements.map((r) => r.id));
  if (call.extracted && call.requirementsReview)
    issues.push({
      path: 'requirementsReview',
      code: 'invalid-field',
      message: 'a step cannot review its own extraction: the next plan or review step does',
    });
  let changed: Promise<Fact<string[]>> | null = null;
  for (const [i, req] of call.requirements.entries()) {
    if (!known.has(req.id)) {
      issues.push({
        path: `requirements.${i}.id`,
        code: 'invalid-field',
        message: `unknown-requirement: ${req.id} is not a requirement id of this task (cite the id, never the number)`,
      });
      continue;
    }
    if (req.state !== 'covered') continue;
    for (const [j, recordId] of req.evidence.entries()) {
      const record = deps.records(recordId, task.taskId);
      let now: Fact<EvidenceNow> = { unknown: NO_READER };
      if (deps.evidence && 'value' in record) {
        now = await deps.evidence.now(task, b, record.value);
        changed ??= deps.evidence.changed(task, b);
      }
      const problem = evidenceProblem(
        { record, now, changed: changed ? await changed : { unknown: NO_READER } },
        task.taskId,
      );
      if (problem)
        issues.push({
          path: `requirements.${i}.evidence.${j}`,
          code: 'invalid-field',
          message: `${problem.code}: ${recordId}: ${problem.detail}`,
        });
    }
  }
  return issues;
}

export async function stepDone(
  task: LiveTask,
  b: SessionBinding,
  input: unknown,
  deps: ModelToolDeps,
): Promise<ModelToolReply> {
  const parsed = parseStepDone(input, b.stepKind);
  if (!parsed.ok) return invalidCall(task, b, 'invalid', parsed.issues);
  const call = parsed.value;
  if (call.stepId !== b.stepId) {
    return refuse(task, b, 'foreign-step', 'stepId is not the step of this session');
  }
  const step = task.state.steps[b.stepId];
  if (!step || step.state !== 'running') {
    return refuse(task, b, 'step-not-running', `step is ${step?.state ?? 'unknown'}`);
  }
  const stopped = stoppedBy(task, b.stepId);
  if (stopped) return refuse(task, b, STEP_STOPPED, stopped);
  const view = requirementsInputOf(readJournalLines(task.dir, task.taskId).lines);
  const issues = await claimIssues(task, b, call, view, deps);
  // Пока шли чтения, шаг мог уйти (второй вызов, остановка): заявление — только к шагу в работе.
  const still = task.state.steps[b.stepId];
  if (!still || still.state !== 'running') {
    return refuse(task, b, 'step-not-running', `step is ${still?.state ?? 'unknown'}`);
  }
  const stoppedSince = stoppedBy(task, b.stepId);
  if (stoppedSince) return refuse(task, b, STEP_STOPPED, stoppedSince);
  // Ошибка вызова (неизвестный id, сверка своего извлечения) — счётный отказ P72. Отказ только по
  // доказательству — суд ложного «готово» (P08): сигнал `step-done-refused`, список полей каждый
  // раз — записи между вызовами меняются, и прошлый список уже не про этот вызов.
  const callIssues = issues.filter((i) => !i.path.includes('.evidence.'));
  if (callIssues.length) return invalidCall(task, b, 'invalid', issues);
  if (issues.length) return evidenceRefusal(task, b, issues);
  // Одна строка-решение (fsync до ответа модели): заявление и переход в проверку разом.
  const claimed = task.append({
    kind: 'step.claimed',
    actor: `session:${b.sessionId}`,
    stepId: b.stepId,
    sessionId: b.sessionId,
    data: { stepId: b.stepId, sessionId: b.sessionId, claim: call },
  });
  const minted = applyExtraction(task, b.stepId, call);
  return {
    ok: true,
    result: {
      accepted: true,
      seq: claimed.seq,
      next: 'post-step facts check',
      ...(minted.length > 0
        ? { requirements: minted.map((r) => ({ id: r.id, ordinal: r.ordinal, text: r.text })) }
        : {}),
    },
  };
}
