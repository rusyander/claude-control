import type { ChatProgress, ProgressTask, ProgressAgent } from '@claude-control/contracts';
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
  let updatedAt: string | undefined;

  for (const record of records) {
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    if (record.timestamp) updatedAt = record.timestamp;

    for (const block of content) {
      if (block.type === 'tool_use') applyToolUse(block, agents, (next) => (tasks = next));
      if (block.type === 'tool_result') applyToolResult(block, agents);
    }
  }

  return { tasks, agents: [...agents.values()], updatedAt };
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
