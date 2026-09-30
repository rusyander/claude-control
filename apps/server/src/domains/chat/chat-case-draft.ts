import { isAbsolute, relative } from 'node:path';
import type { ProjectTestCase, ProjectTestDraft, ProjectTestStep } from '@agentdeck/contracts';
import { humanText, type ContentBlock, type Record } from './ChatRecords.ts';
import { isHumanPrompt } from './chat-inbox.ts';

/**
 * Кейс из живого разговора (действие «Сделать кейс» в чате). Транскрипт уже
 * содержит сценарий, который человек только что прошёл руками вместе с агентом:
 * его реплики — что он просил, вызовы инструментов — что для этого делалось.
 * Из них собирается ЧЕРНОВИК блока «Тесты», а не кейс: библиотеку меняет только
 * приёмка человеком, как у любой генерации (решение владельца 30.09).
 *
 * В шаги идёт то, что меняет или проверяет: команды, правки файлов, внешние
 * вызовы. Чтение и поиск (`Read`, `Grep`, `Glob`) — путь агента к решению, а не
 * шаг сценария, и в кейсе были бы шумом.
 */

/** Группа, куда черновик предлагает кейс; человек может перенести его при приёмке. */
export const CHAT_CASES_GROUP = 'chat';

/** Шагов больше — это уже не сценарий, а пересказ разговора. */
const MAX_STEPS = 40;
const MAX_ACTION = 300;
const MAX_EXPECTED = 200;
const MAX_CODE_PATHS = 20;

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function resultText(block: ContentBlock): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

/** Путь файла от корня проекта, с прямыми слэшами; вне проекта — как есть. */
function projectRelative(path: string, projectPath: string): string {
  const inside = isAbsolute(path) ? relative(projectPath, path) : path;
  const clean = inside.replace(/\\/g, '/');
  return clean.startsWith('../') || clean === '' ? path.replace(/\\/g, '/') : clean;
}

/** Шаг по вызову инструмента; `undefined` — вызов не шаг сценария. */
function stepOf(
  block: ContentBlock,
  projectPath: string,
): { action: string; file?: string } | undefined {
  const input = (block.input ?? {}) as { [key: string]: unknown };
  const name = block.name ?? '';
  if (name === 'Bash' && typeof input.command === 'string') {
    return { action: `Выполнить: ${oneLine(input.command, MAX_ACTION)}` };
  }
  const path = [input.file_path, input.notebook_path].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  if (EDIT_TOOLS.has(name) && path) {
    const file = projectRelative(path, projectPath);
    return { action: `Изменить файл ${file}`, file };
  }
  if (name === 'WebFetch' && typeof input.url === 'string') {
    return { action: `Открыть ${oneLine(input.url, MAX_ACTION)}` };
  }
  if (name === 'Skill' && typeof input.skill === 'string') {
    return { action: `Навык ${oneLine(input.skill, 80)}` };
  }
  if (name.startsWith('mcp__')) return { action: `Вызвать ${name}` };
  return undefined;
}

export interface ChatCaseDraftInput {
  chatId: string;
  projectPath: string;
  now: string;
  /** Заголовок чата — запасной заголовок кейса. */
  chatTitle?: string;
}

/** Кейс из транскрипта: шаги, ожидаемый итог, затронутые файлы. Шагов нет — `undefined`. */
export function caseFromChat(
  records: readonly Record[],
  input: ChatCaseDraftInput,
): ProjectTestCase | undefined {
  const steps: ProjectTestStep[] = [];
  const byTool = new Map<string, number>();
  const files: string[] = [];
  let title = '';
  let lastAnswer = '';

  for (const record of records) {
    if (record.isSidechain || record.isMeta || record.isCompactSummary) continue;
    const content = record.message?.content;
    if (record.type === 'user' && isHumanPrompt(content)) {
      const text = humanText(record);
      if (text) {
        title ||= oneLine(text.split('\n')[0] ?? text, 90);
        steps.push({ action: oneLine(text, MAX_ACTION) });
      }
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (record.type === 'assistant' && block.type === 'text' && block.text?.trim()) {
        lastAnswer = block.text;
      }
      if (record.type === 'assistant' && block.type === 'tool_use') {
        const step = stepOf(block, input.projectPath);
        if (!step) continue;
        // Серия правок одного файла — один шаг: агент правит кусками.
        const previous = steps.at(-1);
        if (step.file && previous?.action === step.action) continue;
        if (step.file && !files.includes(step.file)) files.push(step.file);
        steps.push({ action: step.action });
        if (block.id) byTool.set(block.id, steps.length - 1);
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        const at = byTool.get(block.tool_use_id);
        const step = at === undefined ? undefined : steps[at];
        const text = resultText(block).trim();
        // Ожидание — первая строка удачного ответа: что команда должна сказать.
        if (step && text && !block.is_error && !step.action.startsWith('Изменить файл')) {
          step.expected = oneLine(text.split('\n')[0] ?? text, MAX_EXPECTED);
        }
      }
    }
  }
  if (steps.length === 0) return undefined;

  const kept = steps.slice(0, MAX_STEPS);
  const expected = lastAnswer ? oneLine(lastAnswer.split(/\n\s*\n/)[0] ?? lastAnswer, 400) : '';
  return {
    id: `chat-${
      input.chatId
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 12) || 'case'
    }`,
    type: 'case',
    title:
      title || oneLine(input.chatTitle ?? '', 90) || `Сценарий из чата ${input.chatId.slice(0, 8)}`,
    purpose: `Сценарий, пройденный в чате ${input.chatId}${
      steps.length > MAX_STEPS ? ` (первые ${MAX_STEPS} шагов из ${steps.length})` : ''
    }`,
    steps: kept,
    ...(expected ? { expected } : {}),
    ...(files.length > 0 ? { codePaths: files.slice(0, MAX_CODE_PATHS) } : {}),
    tags: ['from-chat'],
    readiness: 'draft',
    status: 'unknown',
    source: 'agent',
    updatedAt: input.now,
  } as ProjectTestCase;
}

/** Черновик блока «Тесты» с одним кейсом из разговора. */
export function chatCaseDraft(
  records: readonly Record[],
  input: ChatCaseDraftInput & { groupId?: string },
): ProjectTestDraft | undefined {
  const testCase = caseFromChat(records, input);
  if (!testCase) return undefined;
  const stamp = Date.parse(input.now);
  const runId = `${testCase.id}-${(Number.isFinite(stamp) ? stamp : Date.now()).toString(36)}`;
  const groupId = input.groupId ?? CHAT_CASES_GROUP;
  return {
    version: 1,
    runId,
    source: 'chat',
    createdAt: input.now,
    items: [
      {
        op: 'add',
        groupId,
        caseId: testCase.id,
        testCase,
        reason: `Из разговора ${input.chatId}`,
        state: 'pending',
      },
    ],
    file: '',
    status: 'pending',
  };
}
