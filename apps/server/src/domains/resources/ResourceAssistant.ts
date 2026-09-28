import type { ClaudeLocation } from '@agentdeck/contracts';
import { listResourceFiles, readResourceFile, isWritable } from './ResourceFiles.ts';
import type { ResourceKind } from './registry.ts';
import { defaultCliCommand } from '../../providers/cli.ts';
import { historyLines, runClaudeOneShot, type AssistTurn } from '../assistant.ts';
import { maskAssistText } from '../assistant-secrets.ts';
import { SECRET_MASK, maskSecretsInText, restoreMaskedSecrets } from '../../lib/secret-mask.ts';
import type { AgentImage } from '../../lib/agent-images.ts';
import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';

/**
 * Помощник конструктора: по описанию задачи собирает или дополняет структуру
 * файлов ресурса целиком.
 *
 * От помощника форм отличается тем, что заполняет не набор полей, а дерево:
 * модель возвращает список файлов с путями и содержимым, а применяются они
 * слиянием — существующее обновляется, новое добавляется, ничего не
 * удаляется само.
 *
 * Запуск — то же лёгкое окно, что у помощника формы (`runClaudeOneShot`): без
 * инструментов, сессии и наших слоёв. Разговор продолжается историей в запросе
 * (её держит окно помощника), а текущее дерево файлов приходит заново каждый ход.
 *
 * Секреты в файлах (U6, 28.09): модель видит содержимое через маску, а ответ
 * пишется на диск сразу — поэтому маска в ответе возвращается секретом файла
 * только в строке, слово в слово равной прочитанной (`restoreMaskedSecrets`).
 * Не сошлось (строка переписана, маска в новом файле) — файл не пишется и
 * называется в `kept`: записать маску значит молча стереть секрет.
 */

/** Помощник структуры пишет файлы целиком — ему дают больше времени, чем форме. */
const STRUCTURE_TIMEOUT_MS = 240_000;

export interface AssistFile {
  path: string;
  content: string;
}

export interface StructureAssistResult {
  reply: string;
  files: AssistFile[];
  /** Файлы, где маску секрета вернуть некуда: не записаны. */
  kept?: string[];
  error?: string;
  messageCode?: ServerMessageCode;
  params?: ServerMessageParams;
}

export async function assistStructure(
  kind: ResourceKind,
  id: string,
  prompt: string,
  location: ClaudeLocation,
  command: string = defaultCliCommand(),
  history: readonly AssistTurn[] = [],
  images: readonly AgentImage[] = [],
): Promise<StructureAssistResult> {
  if (!isWritable(kind)) {
    return {
      reply: '',
      files: [],
      error: 'Этот вид ресурса доступен только для чтения',
      messageCode: 'resource-read-only',
    };
  }

  try {
    const current = readCurrent(kind, id, location);
    const stdout = await runClaudeOneShot(
      buildPrompt(kind, prompt, current, history),
      command,
      images,
      STRUCTURE_TIMEOUT_MS,
    );
    const envelope = JSON.parse(stdout) as { result?: string };
    const parsed = extractJson(envelope.result ?? '');

    if (!parsed) {
      // Модель ответила текстом без разметки — показываем его как реплику,
      // файлов в этот раз нет.
      return { reply: envelope.result ?? '', files: [] };
    }

    const restored = restoreFileSecrets(
      current,
      parsed.files.filter((file) => file.path && typeof file.content === 'string'),
    );
    return {
      reply: parsed.reply,
      files: restored.files,
      ...(restored.kept.length > 0 ? { kept: restored.kept } : {}),
    };
  } catch (error) {
    return { reply: '', files: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** Текстовые файлы ресурса как есть — для задания (через маску) и для возврата секретов. */
function readCurrent(kind: ResourceKind, id: string, location: ClaudeLocation): AssistFile[] {
  return listResourceFiles(kind, id, location)
    .filter((file) => !file.isBinary)
    .map((file) => ({
      path: file.path,
      content: readResourceFile(kind, id, file.path, location).content,
    }));
}

/** Путь от модели и путь дерева: разделитель и ведущее `./` не делают файл другим. */
function samePath(a: string, b: string): boolean {
  const norm = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '');
  return norm(a) === norm(b);
}

/**
 * Файлы ответа → файлы для записи. Без маски — как прислала модель; с маской —
 * секреты прочитанного файла на место масок (строка должна совпасть с
 * прочитанной); иначе файл в `kept` и не пишется.
 */
export function restoreFileSecrets(
  current: readonly AssistFile[],
  files: readonly AssistFile[],
): { files: AssistFile[]; kept: string[] } {
  const out: AssistFile[] = [];
  const kept: string[] = [];
  for (const file of files) {
    if (!file.content.includes(SECRET_MASK)) {
      out.push(file);
      continue;
    }
    const saved = current.find((item) => samePath(item.path, file.path))?.content;
    const content = saved === undefined ? undefined : restoreMaskedSecrets(saved, file.content);
    if (content === undefined) kept.push(file.path);
    else out.push({ path: file.path, content });
  }
  return { files: out, kept };
}

/**
 * Промпт помощнику. В него кладётся текущее дерево с содержимым: без этого
 * модель не знает, что уже есть, и либо дублирует, либо переписывает заново.
 * Содержимое — через маску секретов, и маска ставится ДО обрезки: обрезка по
 * символам разрезала бы секрет, и его начало ушло бы модели.
 */
function buildPrompt(
  kind: ResourceKind,
  userPrompt: string,
  files: readonly AssistFile[],
  history: readonly AssistTurn[],
): string {
  const current = files
    .map((file) => {
      const content = maskSecretsInText(file.content);
      // Длинные файлы обрезаем: модели нужен контекст, а не всё содержимое,
      // и промпт не должен раздуваться на мегабайты.
      const shown = content.length > 4000 ? `${content.slice(0, 4000)}\n…` : content;
      return `### ${file.path}\n${shown}`;
    })
    .join('\n\n');

  const kindName = kind === 'skill' ? 'a skill' : kind === 'script' ? 'a script' : 'a resource';

  return [
    `You help build the structure of ${kindName} for Claude Code.`,
    kind === 'skill'
      ? 'A skill is a folder with SKILL.md (YAML frontmatter with the fields name and description, ' +
        'then the body) and nested files. Important: Claude Code does not read the nested files by ' +
        'itself — SKILL.md must link to them. description must say clearly when to apply the skill.'
      : '',
    '',
    files.length > 0 ? `Current files:\n\n${current}` : 'No files yet.',
    '',
    ...historyLines(history),
    `The user's current task: ${maskAssistText(userPrompt)}`,
    '',
    'Answer STRICTLY with one JSON object, with no explanations around it:',
    '{"reply": "a short account of what you did, in the language of the user\'s task",',
    ' "files": [{"path": "path/from/root", "content": "the full content of the file"}]}',
    '',
    'Put into files only the files that must be created or rewritten in full, with ready ' +
      'content. Do not touch files that need no change. Paths are relative to the resource ' +
      'root, with forward slashes. Write the content of the files in the language of the ' +
      "user's task unless the existing files use another.",
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

function extractJson(text: string): { reply: string; files: AssistFile[] } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      reply?: string;
      files?: AssistFile[];
    };
    return { reply: parsed.reply ?? '', files: Array.isArray(parsed.files) ? parsed.files : [] };
  } catch {
    return null;
  }
}
