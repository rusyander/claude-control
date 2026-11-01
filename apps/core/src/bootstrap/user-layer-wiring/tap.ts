import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import type { AdapterEvent } from '../../adapters/index.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import {
  HOOK_BLOCK_SIGNAL,
  hookCandidates,
  judgeHookBlock,
  type HookBlockDecision,
  type HookRefusal,
} from '../../observer/hook-block.ts';
import {
  judgeHookLoop,
  targetDigest,
  type HookLoopDecision,
  type HookRefusalKey,
} from '../../observer/hook-loop.ts';
import type { UserLayerTap } from '../session-runtime.ts';

type RefusedEvent = Extract<AdapterEvent, { type: 'hook.refused' }>;

/**
 * Кран слоя человека (G-e, 06:121-122): из потока сессии берёт отказы хуков человека. Каждый
 * отказ — `decision` класса `observer` + сигнал `hook-block` (warn): шаг идёт дальше, человек
 * видит хук. Тот же отказ (хук × инструмент × отпечаток цели) в третий раз за шаг — ещё и
 * `hook-loop` (stop): свёртка кладёт его в `step.stops`, проводник останавливает шаг.
 * Счёт петли пересобирается из журнала (`output.refusal` прошлых решений) один раз на открытую
 * задачу, дальше растёт в памяти: ядро, перезапущенное посреди шага, считает с того же места.
 * Инструмент и цель отказа — из `tool.requested` того же `toolUseId` (в памяти, по сессии).
 */

export interface UserLayerTapDeps {
  /** Опись слоя сессии — для кандидатов безымянного отказа; нет описи — кандидатов нет. */
  inventoryOf?: (task: LiveTask, binding: SessionBinding) => UserLayerInventory | null;
  /** Строки журнала для счёта петли при первом отказе задачи; по умолчанию файл задачи. */
  history?: (task: LiveTask) => readonly JournalLine[];
}

interface RequestedTool {
  name: string;
  input: unknown;
}

/** Что решение `hook-block` несёт в `output.refusal` — ключ счёта петли. */
interface RefusalRecord {
  hook: string | null;
  tool: string | null;
  target: string;
  event: string;
}

/** Предел запомненных вызовов на сессию: поток длинный, отказ приходит сразу за вызовом. */
const REQUESTED_MAX = 500;

function refusalOf(line: JournalLine): HookRefusalKey | null {
  if (line.kind !== 'decision' || !line.stepId) return null;
  const data = (line as JournalLine<'decision'>).data;
  if (data.class !== 'hook-block') return null;
  const out = data.output as { signal?: unknown; refusal?: RefusalRecord } | null;
  if (!out || out.signal !== HOOK_BLOCK_SIGNAL || !out.refusal) return null;
  return {
    stepId: line.stepId,
    hook: out.refusal.hook,
    tool: out.refusal.tool,
    target: out.refusal.target,
  };
}

function journalVerdict(
  task: LiveTask,
  binding: SessionBinding,
  verdict: HookBlockDecision | HookLoopDecision,
  extra: Record<string, unknown>,
): void {
  task.append({
    kind: 'decision',
    actor: 'core',
    sessionId: binding.sessionId,
    stepId: binding.stepId,
    data: {
      decisionId: newId(),
      // Класс решения = его сигнал: у отказа и у петли свой судья (P01).
      class: verdict.signal,
      inputs: [],
      facts: [],
      numbers: {},
      reasons: verdict.reasons,
      output: { ...verdict, ...extra } as never,
    },
  });
  task.append({
    kind: 'signal',
    actor: 'core',
    sessionId: binding.sessionId,
    stepId: binding.stepId,
    data: {
      signal: verdict.signal,
      severity: verdict.severity,
      subject: verdict.subject,
      detail: verdict.detail,
    },
  });
}

export function createUserLayerTap(deps: UserLayerTapDeps = {}): UserLayerTap {
  const requested = new Map<string, Map<string, RequestedTool>>();
  const history = deps.history ?? ((t: LiveTask) => readJournalLines(t.dir, t.taskId).lines);
  /**
   * Прошлые отказы задачи (F17 этапа 8): журнал читается ОДИН раз на открытую задачу, дальше счёт
   * растёт своими отказами — а не перечитывание всего журнала на каждый отказ (O(n) на событие).
   * Задача, открытая заново (перезапуск ядра), — новый объект: её счёт снова из журнала.
   */
  const refusals = new WeakMap<LiveTask, HookRefusalKey[]>();
  const seenOf = (task: LiveTask): HookRefusalKey[] => {
    let got = refusals.get(task);
    if (!got) {
      got = history(task)
        .map(refusalOf)
        .filter((k): k is HookRefusalKey => k !== null);
      refusals.set(task, got);
    }
    return got;
  };

  const remember = (sessionId: string, toolUseId: string, tool: RequestedTool): void => {
    let calls = requested.get(sessionId);
    if (!calls) requested.set(sessionId, (calls = new Map()));
    calls.set(toolUseId, tool);
    if (calls.size > REQUESTED_MAX) {
      const oldest = calls.keys().next().value;
      if (oldest !== undefined) calls.delete(oldest);
    }
  };

  const onRefused = (task: LiveTask, binding: SessionBinding, event: RefusedEvent): void => {
    const call =
      event.toolUseId === null ? undefined : requested.get(binding.sessionId)?.get(event.toolUseId);
    const tool = call?.name ?? null;
    const target = call === undefined ? '' : targetDigest(call.input);
    const candidates =
      event.hook === null
        ? hookCandidates(deps.inventoryOf?.(task, binding)?.hooks ?? [], event.event, tool)
        : [];
    // Прошлые отказы — до записи текущего: счёт петли = прошлые того же шага + этот.
    const seen = seenOf(task);
    const refusal: HookRefusal = {
      hook: event.hook,
      event: event.event,
      tool,
      reason: event.reason,
      candidates,
    };
    const record: RefusalRecord = { hook: event.hook, tool, target, event: event.event };
    journalVerdict(task, binding, judgeHookBlock(refusal), { refusal: record, candidates });
    const current = { stepId: binding.stepId, hook: event.hook, tool, target };
    const loop = judgeHookLoop(seen, current);
    seen.push(current);
    if (loop.fired) journalVerdict(task, binding, loop, {});
  };

  return {
    onEvent(task, binding, event) {
      if (event.type === 'tool.requested')
        remember(binding.sessionId, event.toolUseId, { name: event.name, input: event.input });
      else if (event.type === 'hook.refused') onRefused(task, binding, event);
    },
  };
}
