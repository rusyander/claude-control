import type { AgentEndHow, BgEndHow, BgKind } from '@agentdeck/contracts/core/agents';
import type { AdapterEvent, BgStartedEvent } from '../adapter.types.ts';

/**
 * Строки задач потока CLI → субагенты и фоновая работа сеанса (этап 11, P146-P148). Источник —
 * только поток: Claude `task_started` → `task_updated` → `task_notification`, Qwen — те же строки
 * для агента и `is_background` во входе вызова оболочки (строк задач у неё нет). Чистый: без
 * часов и IO, одни и те же записи проверяют его в тестах и в живых прогонах.
 *
 * Правила (P148): фоновая оболочка или монитор → `bg.started`, его конец → `bg.ended`; субагент
 * (фоновый или нет) → `agent.spawned` / `agent.ended`; задача не в фоне (обычный вызов Bash) —
 * ничего; тип задачи, ядру незнакомый, — вид `other` с его именем.
 */

/** Строка задачи, как её прочло правило CLI. */
export interface TaskLine {
  phase: 'started' | 'updated' | 'ended';
  taskId: string;
  toolUseId: string | null;
  /** Вид по типу задачи CLI; `other` — тип незнакомый, назван в `typeName`. */
  kind: 'agent' | 'shell' | 'other' | null;
  typeName: string | null;
  /** `null` — CLI не назвал. */
  backgrounded: boolean | null;
  description: string | null;
  subagentType: string | null;
  depth: number | null;
  prompt: string | null;
  status: string | null;
  outputFile: string | null;
  summary: string | null;
  usage: { totalTokens: number; toolUses: number; durationMs: number } | null;
  /** Стена конца (мс), как её назвал CLI. */
  endTime: number | null;
}

/** Факты запуска фонового вызова из текста его `tool_result`. */
export interface LaunchFacts {
  itemId?: string;
  pid?: number;
  outputFile?: string;
}

export interface TaskRule {
  /** Строка `system` — строка задачи этого CLI; `null` — не она. */
  read(line: Record<string, unknown>): TaskLine | null;
  /** Фоновый вызов без строк задач (Qwen `is_background`): его вид; `null` — вызов не фоновый. */
  backgroundCall?(name: string, input: Record<string, unknown>): BgKind | null;
  /** Факты запуска из текста результата фонового вызова. */
  launched?(text: string): LaunchFacts;
  /** Код выхода из итога CLI (`task_notification.summary`). */
  exitCode?(summary: string): number | undefined;
  /**
   * Агент без флага фона в строке и во входе — фоновый (Qwen: «Background agent launched» без
   * `run_in_background`, проба s8). Нет — не фоновый.
   */
  agentsBackgroundByDefault?: true;
}

interface Call {
  name: string;
  input: Record<string, unknown>;
  parent: string | null;
}

interface Tracked {
  toolUseId: string;
  /** `ignored` — задача не в фоне и не агент: строк о ней нет вовсе. */
  role: 'agent' | 'bg' | 'ignored';
  itemId: string;
  /** Строка `bg.started` ждёт результата вызова — в нём файл вывода. */
  held: BgStartedEvent | null;
  status: string | null;
  endTime: number | null;
  ended: boolean;
}

/** Предел помнящихся вызовов и задач на сессию: потерянные не копятся вечно. */
const MEMORY_MAX = 500;

const TERMINAL = new Set(['completed', 'failed', 'killed', 'stopped']);

const AGENT_HOW: Readonly<Record<string, AgentEndHow>> = {
  completed: 'completed',
  failed: 'failed',
  killed: 'killed',
  stopped: 'stopped',
};
const BG_HOW: Readonly<Record<string, BgEndHow>> = {
  completed: 'exit',
  failed: 'failed',
  killed: 'killed',
  stopped: 'stopped',
};

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

const PHASES: Readonly<Record<string, TaskLine['phase']>> = {
  task_started: 'started',
  task_updated: 'updated',
  task_notification: 'ended',
};

/**
 * Строка задачи формата SDK по её полям (Claude — на верхнем уровне строки, Qwen — в `data`).
 * `kindOf` — вид по типу задачи этого CLI; итог CLI без всех трёх чисел — `null` (неизвестно).
 */
export function sdkTaskLine(
  subtype: unknown,
  fields: Record<string, unknown>,
  kindOf: (fields: Record<string, unknown>) => Pick<TaskLine, 'kind' | 'typeName'>,
): TaskLine | null {
  const phase = typeof subtype === 'string' ? PHASES[subtype] : undefined;
  const taskId = str(fields.task_id);
  if (!phase || !taskId) return null;
  const patch = isObj(fields.patch) ? fields.patch : {};
  const u = isObj(fields.usage) ? fields.usage : null;
  const totals = u ? [count(u.total_tokens), count(u.tool_uses), count(u.duration_ms)] : [];
  const [totalTokens, toolUses, durationMs] = totals;
  return {
    phase,
    taskId,
    toolUseId: str(fields.tool_use_id),
    ...kindOf(fields),
    backgrounded: typeof fields.is_backgrounded === 'boolean' ? fields.is_backgrounded : null,
    description: str(fields.description),
    subagentType: str(fields.subagent_type),
    depth: Number.isInteger(fields.spawn_depth) ? count(fields.spawn_depth) : null,
    prompt: str(fields.prompt),
    status: str(fields.status) ?? str(patch.status),
    outputFile: str(fields.output_file),
    summary: str(fields.summary),
    usage:
      totalTokens != null && toolUses != null && durationMs != null
        ? { totalTokens, toolUses, durationMs }
        : null,
    endTime: count(patch.end_time) ?? count(fields.end_time),
  };
}

/** Текст блока `tool_result`: строка или части `{type:'text'}` через перевод строки. */
export function resultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) =>
      typeof part === 'object' &&
      part !== null &&
      (part as Record<string, unknown>).type === 'text' &&
      typeof (part as Record<string, unknown>).text === 'string'
        ? [(part as Record<string, unknown>).text as string]
        : [],
    )
    .join('\n');
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value);
  if (map.size > MEMORY_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** Вид фоновой работы: монитор — по имени вызова, оболочка — по типу задачи. */
function bgKindOf(line: TaskLine, call: Call | undefined): BgKind {
  if (call?.name.toLowerCase() === 'monitor') return 'monitor';
  return line.kind === 'shell' ? 'background-shell' : 'other';
}

export class TaskTracker {
  private readonly rule: TaskRule;
  private readonly calls = new Map<string, Call>();
  private readonly tasks = new Map<string, Tracked>();
  /** Фоновые вызовы без строк задач, уже изданные: повтор результата строки не даёт. */
  private readonly direct = new Set<string>();

  constructor(rule: TaskRule) {
    this.rule = rule;
  }

  /** Вызов модели: имя, вход и родитель нужны строке задачи, которая придёт за ним. */
  call(toolUseId: string, name: string, input: unknown, parent: string | null): void {
    const body =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    remember(this.calls, toolUseId, { name, input: body, parent });
  }

  /** Строка `system` потока; не строка задачи — пусто. */
  line(raw: Record<string, unknown>): AdapterEvent[] {
    const line = this.rule.read(raw);
    if (!line) return [];
    if (line.phase === 'started') return this.started(line);
    const task = this.tasks.get(line.taskId);
    if (!task || task.ended) return [];
    if (line.status) task.status = line.status;
    if (line.endTime !== null) task.endTime = line.endTime;
    if (line.phase === 'updated') return [];
    return this.end(task, line);
  }

  /**
   * Результат вызова: выпускает ждущую `bg.started` или фоновый вызов без строк задач. `at` —
   * стена строки результата (CLI её назвал): начало фона из истории не берёт стену прикрепления.
   */
  result(
    toolUseId: string,
    text: string,
    isError: boolean,
    at: number | null = null,
  ): AdapterEvent[] {
    for (const task of this.tasks.values()) {
      if (task.toolUseId === toolUseId && task.held) return this.release(task, text, null, at);
    }
    const call = this.calls.get(toolUseId);
    if (!call || isError || this.direct.has(toolUseId)) return [];
    const kind = this.rule.backgroundCall?.(call.name, call.input) ?? null;
    if (!kind) return [];
    this.direct.add(toolUseId);
    const facts = this.rule.launched?.(text) ?? {};
    return [
      {
        type: 'bg.started',
        itemId: facts.itemId ?? toolUseId,
        cliTaskId: null,
        toolUseId,
        parentToolUseId: call.parent,
        kind,
        excerpt: str(call.input.command) ?? str(call.input.description) ?? call.name,
        ...(facts.outputFile ? { outputFile: facts.outputFile } : {}),
        ...(facts.pid !== undefined ? { pid: facts.pid } : {}),
        ...(at !== null ? { startedAt: at } : {}),
      },
    ];
  }

  /**
   * Конец сеанса: ждущие `bg.started` выпускаются (работа началась), задачи с известным концом
   * (`task_updated` без `task_notification`) кончаются. Задача без названного конца остаётся
   * идущей — её судит уборка за владельцем (`bg-orphan`), а не догадка здесь.
   */
  flush(): AdapterEvent[] {
    const out: AdapterEvent[] = [];
    for (const task of this.tasks.values()) {
      if (task.ended) continue;
      if (task.held) out.push(...this.release(task, '', null, task.endTime));
      if (task.status && TERMINAL.has(task.status)) {
        out.push(...this.end(task, null));
      }
    }
    return out;
  }

  private started(line: TaskLine): AdapterEvent[] {
    if (this.tasks.has(line.taskId) || !line.toolUseId) return [];
    const call = this.calls.get(line.toolUseId);
    const input = call?.input ?? {};
    const track = (role: Tracked['role'], held: BgStartedEvent | null = null): void =>
      remember(this.tasks, line.taskId, {
        toolUseId: line.toolUseId!,
        role,
        itemId: line.taskId,
        held,
        status: null,
        endTime: null,
        ended: false,
      });
    // Флаг строки; CLI старше его не пишет — тогда флаг входа вызова (`run_in_background`).
    const flagged =
      line.backgrounded ??
      (typeof input.run_in_background === 'boolean' ? input.run_in_background : null);
    const background = flagged ?? this.rule.agentsBackgroundByDefault === true;
    if (line.kind === 'agent' || (line.kind !== 'shell' && flagged !== true)) {
      // Субагент — всегда узел; незнакомый тип не в фоне — тоже узел, вид `other` с именем.
      const agent = line.kind === 'agent';
      track('agent');
      return [
        {
          type: 'agent.spawned',
          cliTaskId: line.taskId,
          toolUseId: line.toolUseId,
          parentToolUseId: call?.parent ?? null,
          kind: agent ? 'subagent' : 'other',
          subagentType: agent
            ? (line.subagentType ?? str(input.subagent_type))
            : (line.typeName ?? 'unknown'),
          model: str(input.model),
          effort: str(input.effort),
          background,
          depth: line.depth,
          brief: line.prompt ?? str(input.prompt) ?? line.description,
        },
      ];
    }
    // Не в фоне (обычный вызов оболочки): узла нет, его конец тоже ничего не пишет.
    if (flagged !== true) {
      track('ignored');
      return [];
    }
    const kind = bgKindOf(line, call);
    const what = str(input.command) ?? line.description ?? call?.name ?? '';
    track('bg', {
      type: 'bg.started',
      itemId: line.taskId,
      cliTaskId: line.taskId,
      toolUseId: line.toolUseId,
      parentToolUseId: call?.parent ?? null,
      kind,
      excerpt: kind === 'other' ? `${line.typeName ?? 'unknown'}: ${what}` : what,
    });
    // Строка держится до результата вызова: в нём путь файла вывода (Claude пишет его текстом).
    return [];
  }

  /** `at` — стена начала: строки результата или конца задачи (тогда начало не позже конца). */
  private release(
    task: Tracked,
    text: string,
    outputFile: string | null | undefined,
    at: number | null,
  ): AdapterEvent[] {
    const held = task.held!;
    task.held = null;
    const facts = text ? (this.rule.launched?.(text) ?? {}) : {};
    const file = outputFile ?? facts.outputFile;
    return [
      {
        ...held,
        ...(file ? { outputFile: file } : {}),
        ...(facts.pid !== undefined ? { pid: facts.pid } : {}),
        ...(at !== null ? { startedAt: at } : {}),
      },
    ];
  }

  private end(task: Tracked, line: TaskLine | null): AdapterEvent[] {
    task.ended = true;
    if (task.role === 'ignored') return [];
    const status = task.status ?? '';
    const summary = line?.summary ?? null;
    if (task.role === 'agent') {
      return [
        {
          type: 'agent.ended',
          cliTaskId: task.itemId,
          toolUseId: task.toolUseId,
          how: AGENT_HOW[status] ?? 'lost',
          usage: line?.usage ?? null,
          summary,
        },
      ];
    }
    const out: AdapterEvent[] = task.held
      ? this.release(task, '', line?.outputFile, task.endTime)
      : [];
    const exitCode = summary ? this.rule.exitCode?.(summary) : undefined;
    out.push({
      type: 'bg.ended',
      itemId: task.itemId,
      how: BG_HOW[status] ?? 'lost',
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(task.endTime !== null ? { endedAt: task.endTime } : {}),
      ...(summary ? { summary } : {}),
    });
    return out;
  }
}
