import {
  parseModelCall,
  toolPlanFor,
  type AskHumanCall,
  type BlockerCall,
  type ModelToolName,
  type ModelToolReply,
  MODEL_TOOL_NAMES,
} from '@agentdeck/contracts/core/model-tools';
import { nextState, STEP_MACHINE } from '@agentdeck/contracts/core/states';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { decideHumanPoint } from '../../policy/human-point/human-point.ts';
import type { HumanPointInput } from '../../policy/human-point/human-point.types.ts';
import type { ModelToolDeps, SessionBinding } from './model-tools.types.ts';
import { stepDone } from './step-done.ts';

/**
 * Сервер `agentdeck` со стороны ядра (03 §Model tools): один вход на пять инструментов. Набор
 * инструментов зависит от вида шага (P73) — вызов инструмента, которого у шага нет, отказан, даже
 * если мост MCP его показал. Публикации, настройки и гранта среди них нет (F23): модель ими не
 * распоряжается ни одним вызовом.
 */

export const TOOL_NOT_IN_PLAN = 'tool-not-in-plan';

/** Отказ «плохие поля» для инструментов, кроме `step_done` (у него свой счёт повторов, P72). */
function invalid(issues: NonNullable<Extract<ModelToolReply, { ok: false }>['issues']>) {
  return { ok: false as const, code: 'invalid', message: 'call failed its schema', issues };
}

/**
 * Ответ без подключённого верификатора (`deps.check` нет — ядро собрано без обвязки зоны C,
 * как в прогонах заглушек фазы 2): той же формы, но без вердикта и с причиной — модель не может
 * принять его за зелёный, а `step_done` не примет запись, которой нет (P08).
 */
export const CHECK_ABSENT = {
  verdict: 'no-verdict',
  reason: 'verifier-absent',
  recordId: null,
  excerpt: '',
  logPath: null,
} as const;

function humanPoint(
  task: LiveTask,
  b: SessionBinding,
  input: HumanPointInput,
  deps: ModelToolDeps,
): ModelToolReply {
  const decision = decideHumanPoint(input, deps.humanPolicy);
  const decided = task.append({
    kind: 'decision',
    actor: 'core',
    stepId: b.stepId,
    sessionId: b.sessionId,
    data: {
      decisionId: newId(),
      class: 'human-point',
      inputs: [],
      facts: [],
      numbers: {},
      reasons: [decision.reason],
      output:
        decision.point === null
          ? { point: null, blocking: false, fork: { ...decision.fork } }
          : { point: decision.point, blocking: decision.blocking },
    },
  });
  if (decision.point === null) {
    // Вне списка: шаг идёт дальше с рекомендацией модели, развилка — в итоговый отчёт.
    return {
      ok: true,
      result: {
        humanPoint: false,
        blocking: false,
        proceedWith: input.recommendation,
        reason: decision.reason,
        decisionSeq: decided.seq,
      },
    };
  }
  const askId = newId();
  task.append({
    kind: 'human.asked',
    actor: 'core',
    stepId: b.stepId,
    sessionId: b.sessionId,
    cause: decided.seq,
    data: {
      askId,
      point: decision.point,
      question: input.question,
      options: input.options,
      defaultAction: decision.blocking ? null : input.recommendation,
    },
  });
  const step = task.state.steps[b.stepId];
  if (decision.blocking && step) {
    const moved = nextState(STEP_MACHINE, step.state, 'ask');
    if (moved.ok) {
      task.append({
        kind: 'step.transition',
        actor: 'core',
        stepId: b.stepId,
        cause: decided.seq,
        data: { stepId: b.stepId, event: 'ask', from: step.state, to: moved.to },
      });
    }
  }
  return {
    ok: true,
    result: {
      humanPoint: true,
      point: decision.point,
      blocking: decision.blocking,
      askId,
      next: decision.blocking ? 'wait for the answer' : `continue with ${input.recommendation}`,
    },
  };
}

function askHuman(task: LiveTask, b: SessionBinding, call: AskHumanCall, deps: ModelToolDeps) {
  return humanPoint(
    task,
    b,
    {
      source: 'ask_human',
      action: call.action ?? null,
      question: call.question,
      options: call.options,
      recommendation: call.recommendation,
      blocking: call.blocking,
    },
    deps,
  );
}

/**
 * Помеха шага: в журнал сигналом всегда. Доступ — пункт 4 (06), его держит человек; остальное
 * (окружение, внешнее, конфликт требований) — не вопрос человеку: шаг кончается `step_done` с
 * исходом `blocked`, а помеха уходит в отчёт.
 */
function blocker(task: LiveTask, b: SessionBinding, call: BlockerCall, deps: ModelToolDeps) {
  task.append({
    kind: 'signal',
    actor: `session:${b.sessionId}`,
    stepId: b.stepId,
    sessionId: b.sessionId,
    data: { signal: 'step-blocker', severity: 'warn', subject: call.kind, detail: call.detail },
  });
  const unblock = 'unblock and continue';
  const finish = 'finish the step as blocked';
  return humanPoint(
    task,
    b,
    {
      source: 'blocker',
      action: call.kind === 'access' ? { kind: 'access-grant', target: call.kind } : null,
      question: `${call.kind}: ${call.detail}`,
      options: [unblock, finish],
      recommendation: finish,
      blocking: call.kind === 'access',
    },
    deps,
  );
}

export const STEP_NOT_RUNNING = 'step-not-running';

/**
 * Вопрос и помеха — только из идущего шага (ревью F-106): шаг, уже ждущий ответа (или кончившийся),
 * второй вопрос не принимает — иначе копились бы `human.asked` при застывшем шаге.
 */
function notRunning(task: LiveTask, b: SessionBinding): ModelToolReply | undefined {
  const state = task.state.steps[b.stepId]?.state;
  if (state === 'running') return undefined;
  return { ok: false, code: STEP_NOT_RUNNING, message: `step is ${state ?? 'unknown'}` };
}

function coreState(task: LiveTask, b: SessionBinding): ModelToolReply {
  const s = task.state;
  const step = s.steps[b.stepId];
  const openAsks = Object.entries(s.asks)
    .filter(([, a]) => a.state === 'open')
    .map(([askId, a]) => ({ askId, point: a.point }));
  return {
    ok: true,
    result: {
      taskId: s.taskId,
      task: s.task,
      unit: { unitId: b.unitId, state: s.units[b.unitId]?.state ?? null },
      step: { stepId: b.stepId, kind: b.stepKind, state: step?.state ?? null },
      openAsks,
    },
  };
}

export function isModelToolName(name: string): name is ModelToolName {
  return (MODEL_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Ответ синхронный у всех инструментов, кроме живой проверки: её прогон ждёт слот и раннер,
 * поэтому с подключённым `deps.check` ответ `check` — обещание (маршрут его дожидается).
 */
export function handleModelTool(
  task: LiveTask,
  b: SessionBinding,
  name: string,
  input: unknown,
  deps: ModelToolDeps & { check?: undefined },
): ModelToolReply;
export function handleModelTool(
  task: LiveTask,
  b: SessionBinding,
  name: string,
  input: unknown,
  deps: ModelToolDeps,
): ModelToolReply | Promise<ModelToolReply>;
export function handleModelTool(
  task: LiveTask,
  b: SessionBinding,
  name: string,
  input: unknown,
  deps: ModelToolDeps,
): ModelToolReply | Promise<ModelToolReply> {
  const plan = toolPlanFor(b.stepKind);
  if (!plan || !isModelToolName(name) || !plan.modelTools.includes(name)) {
    return {
      ok: false,
      code: TOOL_NOT_IN_PLAN,
      message: `${name} is not a tool of step kind ${b.stepKind}`,
    };
  }
  switch (name) {
    case 'step_done':
      return stepDone(task, b, input, deps);
    case 'check': {
      const parsed = parseModelCall('check', input);
      if (!parsed.ok) return invalid(parsed.issues);
      if (!deps.check) return { ok: true, result: CHECK_ABSENT };
      return deps.check(task, b, parsed.value).then(
        (result): ModelToolReply => ({ ok: true, result }),
        (error: unknown): ModelToolReply => ({
          ok: false,
          code: 'check-failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    case 'ask_human': {
      const parsed = parseModelCall('ask_human', input);
      if (!parsed.ok) return invalid(parsed.issues);
      return notRunning(task, b) ?? askHuman(task, b, parsed.value, deps);
    }
    case 'blocker': {
      const parsed = parseModelCall('blocker', input);
      if (!parsed.ok) return invalid(parsed.issues);
      return notRunning(task, b) ?? blocker(task, b, parsed.value, deps);
    }
    case 'core_state': {
      const parsed = parseModelCall('core_state', input);
      return parsed.ok ? coreState(task, b) : invalid(parsed.issues);
    }
  }
}
