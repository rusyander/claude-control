import type {
  ChatProgress,
  ProgressTask,
  ProgressAgent,
  ProgressShell,
  ProgressActiveTool,
} from '@agentdeck/contracts';
import {
  findTranscript,
  readTranscriptRecords,
  type TranscriptRecord,
  type TranscriptBlock,
} from './ChatHistory.ts';

/**
 * Прогресс агента по его собственному следу в транскрипте.
 *
 * Ничего своего панель здесь не заводит: чекпоинты — это последний вызов
 * `TodoWrite` (агент сам ведёт этот список и переписывает его целиком), дерево —
 * вызовы `Task`, то есть запущенные им субагенты, вместе с их результатом.
 * Отсюда и read-only: план принадлежит агенту, панель его только показывает.
 *
 * Почему из транскрипта, а не из живого потока: транскрипт переживает и
 * перезагрузку страницы, и конец прогона — открыв вчерашний разговор, видно, чем
 * он кончился. Живой поток дал бы то же самое только в одной вкладке и только
 * пока она открыта.
 */

/** Сколько символов ответа субагента показывать: это заглядывание, не чтение. */
const RESULT_LIMIT = 600;

export function readChatProgress(projectsDir: string, chatId: string): ChatProgress {
  const path = findTranscript(projectsDir, chatId);
  if (!path) return { tasks: [], agents: [] };

  return buildProgress(readTranscriptRecords(path));
}

export function buildProgress(records: TranscriptRecord[]): ChatProgress {
  let tasks: ProgressTask[] = [];
  const agents = new Map<string, ProgressAgent>();
  const shells = new Shells();
  let updatedAt: string | undefined;

  for (const record of records) {
    const content = record.message?.content;
    if (record.timestamp) updatedAt = record.timestamp;
    // Итог фоновой команды приходит отдельной репликой-уведомлением, строкой.
    if (typeof content === 'string') {
      shells.notice(content);
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'tool_use') {
        applyToolUse(block, agents, (next) => (tasks = next));
        shells.use(block, record.timestamp);
      }
      if (block.type === 'tool_result') {
        applyToolResult(block, agents);
        shells.result(block, resultText(block));
      }
      if (block.type === 'text' && record.type === 'user' && typeof block.text === 'string')
        shells.notice(block.text);
    }
  }

  const listed = shells.list();
  return {
    tasks,
    agents: [...agents.values()],
    ...(listed.length > 0 ? { shells: listed } : {}),
    ...(shells.active ? { activeTool: shells.active } : {}),
    updatedAt,
  };
}

/** Сколько фоновых команд держать в панели: хвост, а не история разговора. */
const SHELL_LIMIT = 8;

/** Что агент увёл в фон и чем это кончилось, плюс вызов, который идёт сейчас. */
class Shells {
  private readonly byUse = new Map<string, ProgressShell>();
  /** id фоновой задачи CLI → id вызова, который её завёл. */
  private readonly byTask = new Map<string, string>();
  private readonly pending = new Map<string, ProgressActiveTool>();
  private readonly commands = new Map<string, string>();

  use(block: TranscriptBlock, at: string | undefined): void {
    if (!block.id || !block.name) return;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const summary = toolSummary(input);
    this.pending.set(block.id, { name: block.name, summary, ...(at ? { startedAt: at } : {}) });
    if (block.name !== 'Bash') return;
    // В строке фона нужна сама команда: описание «Install deps» не скажет,
    // что именно висит двадцать минут.
    const command = typeof input.command === 'string' ? firstLine(input.command) : summary;
    this.commands.set(block.id, command);
    if (input.run_in_background === true) {
      this.byUse.set(block.id, {
        id: block.id,
        command,
        ...(at ? { startedAt: at } : {}),
        status: 'running',
      });
    }
  }

  result(block: TranscriptBlock, text: string): void {
    const id = block.tool_use_id;
    if (!id) return;
    const started = this.pending.get(id);
    this.pending.delete(id);
    // Вызов, уведённый в фон, ответил распиской с id задачи: сам он кончился, а
    // команда живёт дальше — и по таймауту тоже, хотя агент фон не просил.
    const task = /(?:background with ID|background \(ID):\s*([\w-]+)/i.exec(text)?.[1];
    if (!task) return;
    this.byTask.set(task, id);
    if (!this.byUse.has(id)) {
      this.byUse.set(id, {
        id,
        command: this.commands.get(id) ?? '',
        ...(started?.startedAt ? { startedAt: started.startedAt } : {}),
        status: 'running',
      });
    }
  }

  /** `<task-notification>` — итог фоновой задачи, пришедший репликой. */
  notice(text: string): void {
    if (!text.includes('<task-notification>')) return;
    const task = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]?.trim();
    const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim();
    const id = task ? this.byTask.get(task) : undefined;
    const shell = id ? this.byUse.get(id) : undefined;
    if (!id || !shell) return;
    this.byUse.set(id, { ...shell, status: shellStatus(status) });
  }

  list(): ProgressShell[] {
    return [...this.byUse.values()].slice(-SHELL_LIMIT);
  }

  /** Последний вызов без результата. Параллельных бывает несколько — важен свежий. */
  get active(): ProgressActiveTool | undefined {
    return [...this.pending.values()].at(-1);
  }
}

function shellStatus(status: string | undefined): ProgressShell['status'] {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  return 'stopped';
}

/** Чем вызван инструмент — одной строкой: команда, путь, шаблон или описание. */
function toolSummary(input: Record<string, unknown>): string {
  for (const key of ['description', 'command', 'file_path', 'pattern', 'path', 'url', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return firstLine(value);
  }
  return '';
}

function applyToolUse(
  block: TranscriptBlock,
  agents: Map<string, ProgressAgent>,
  setTasks: (tasks: ProgressTask[]) => void,
): void {
  if (block.name === 'TodoWrite') {
    const todos = (block.input as { todos?: unknown })?.todos;
    if (Array.isArray(todos)) setTasks(todos.map(toTask).filter(isTask));
    return;
  }

  // Субагент. Имя инструмента в разных сборках CLI отличается (`Task`, `Agent`),
  // а признак один и тот же — тип субагента во входе; по нему и опознаём.
  const input = (block.input ?? {}) as {
    subagent_type?: unknown;
    description?: unknown;
    prompt?: unknown;
  };
  const isSubagent = block.name === 'Task' || block.name === 'Agent';
  if (!isSubagent || !block.id) return;

  agents.set(block.id, {
    id: block.id,
    kind: typeof input.subagent_type === 'string' ? input.subagent_type : 'agent',
    description: firstLine(
      typeof input.description === 'string'
        ? input.description
        : typeof input.prompt === 'string'
          ? input.prompt
          : '',
    ),
    status: 'running',
  });
}

/**
 * Результат вызова закрывает ветку дерева: субагент отработал или упал.
 *
 * Кроме одного случая: фоновый субагент отвечает сразу, но отвечает не работой,
 * а распиской «принято, работаю» со служебным идентификатором внутри. Пометить
 * такую ветку готовой значило бы соврать — она остаётся работающей, а расписка
 * в панель не попадает.
 */
function applyToolResult(block: TranscriptBlock, agents: Map<string, ProgressAgent>): void {
  const id = block.tool_use_id;
  if (!id) return;
  const agent = agents.get(id);
  if (!agent) return;

  const text = resultText(block);
  if (isLaunchAcknowledgement(text)) return;

  agents.set(id, {
    ...agent,
    status: block.is_error ? 'failed' : 'done',
    result: publicResult(text) || undefined,
  });
}

/** Расписка о запуске фонового субагента — не результат работы. */
function isLaunchAcknowledgement(text: string): boolean {
  return /^Async agent launched/i.test(text);
}

/**
 * Что из ответа субагента можно показать. Строки со служебными идентификаторами
 * выбрасываем: они предназначены агенту, а не человеку, и в панели читаются как
 * мусор.
 */
function publicResult(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/agentId:/i.test(line))
    .join('\n')
    .trim()
    .slice(0, RESULT_LIMIT);
}

/** Текст результата: CLI отдаёт его то строкой, то списком блоков. */
function resultText(block: TranscriptBlock): string {
  if (typeof block.content === 'string') return block.content.trim();
  if (Array.isArray(block.content)) {
    return block.content
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
  }
  return typeof block.text === 'string' ? block.text.trim() : '';
}

function toTask(raw: unknown): ProgressTask | undefined {
  const todo = (raw ?? {}) as { content?: unknown; status?: unknown };
  const text = typeof todo.content === 'string' ? todo.content.trim() : '';
  if (!text) return undefined;

  const status =
    todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending';
  return { text, status };
}

function isTask(task: ProgressTask | undefined): task is ProgressTask {
  return task !== undefined;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim().slice(0, 200) ?? '';
}
