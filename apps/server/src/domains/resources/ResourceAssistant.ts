import { spawn } from 'node:child_process';
import type { ClaudeLocation } from '@claude-control/contracts';
import { listResourceFiles, readResourceFile, isWritable } from './ResourceFiles.ts';
import type { ResourceKind } from './registry.ts';
import { safeSessionId } from '../../lib/cli-args.ts';
import { defaultCliCommand } from '../../providers/cli.ts';

/**
 * Помощник конструктора: по описанию задачи собирает или дополняет структуру
 * файлов ресурса целиком.
 *
 * От помощника форм отличается тем, что заполняет не набор полей, а дерево:
 * модель возвращает список файлов с путями и содержимым, а применяются они
 * слиянием — существующее обновляется, новое добавляется, ничего не
 * удаляется само.
 */

const isWindows = process.platform === 'win32';

export interface AssistFile {
  path: string;
  content: string;
}

export interface StructureAssistResult {
  reply: string;
  files: AssistFile[];
  sessionId?: string;
  error?: string;
}

export async function assistStructure(
  kind: ResourceKind,
  id: string,
  prompt: string,
  location: ClaudeLocation,
  command: string = defaultCliCommand(),
  sessionId?: string,
): Promise<StructureAssistResult> {
  if (!isWritable(kind)) {
    return { reply: '', files: [], error: 'Этот вид ресурса доступен только для чтения' };
  }

  try {
    const stdout = await runClaude(buildPrompt(kind, id, prompt, location), command, sessionId);
    const envelope = JSON.parse(stdout) as { result?: string; session_id?: string };
    const parsed = extractJson(envelope.result ?? '');

    if (!parsed) {
      // Модель ответила текстом без разметки — показываем его как реплику,
      // файлов в этот раз нет.
      return { reply: envelope.result ?? '', files: [], sessionId: envelope.session_id };
    }

    return {
      reply: parsed.reply,
      files: parsed.files.filter((file) => file.path && typeof file.content === 'string'),
      sessionId: envelope.session_id,
    };
  } catch (error) {
    return { reply: '', files: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Промпт помощнику. В него кладётся текущее дерево с содержимым: без этого
 * модель не знает, что уже есть, и либо дублирует, либо переписывает заново.
 */
function buildPrompt(
  kind: ResourceKind,
  id: string,
  userPrompt: string,
  location: ClaudeLocation,
): string {
  const files = listResourceFiles(kind, id, location);
  const current = files
    .filter((file) => !file.isBinary)
    .map((file) => {
      const { content } = readResourceFile(kind, id, file.path, location);
      // Длинные файлы обрезаем: модели нужен контекст, а не всё содержимое,
      // и промпт не должен раздуваться на мегабайты.
      const shown = content.length > 4000 ? `${content.slice(0, 4000)}\n…` : content;
      return `### ${file.path}\n${shown}`;
    })
    .join('\n\n');

  const kindName = kind === 'skill' ? 'скилла' : kind === 'script' ? 'скрипта' : 'ресурса';

  return [
    `Ты помогаешь собрать структуру ${kindName} для Claude Code.`,
    kind === 'skill'
      ? 'Скилл — это папка с SKILL.md (YAML-frontmatter с полями name и description, затем тело) ' +
        'и вложенными файлами. Важно: Claude Code не читает вложенные файлы сам — на них должны ' +
        'быть ссылки из SKILL.md. description должен ясно описывать, когда скилл применять.'
      : '',
    '',
    files.length > 0 ? `Текущие файлы:\n\n${current}` : 'Файлов пока нет.',
    '',
    `Задача пользователя: ${userPrompt}`,
    '',
    'Ответь СТРОГО одним JSON-объектом без пояснений вокруг:',
    '{"reply": "короткий рассказ, что ты сделал",',
    ' "files": [{"path": "путь/от/корня", "content": "полное содержимое файла"}]}',
    '',
    'В files клади только те файлы, которые нужно создать или переписать целиком, ' +
      'с готовым содержимым. Не трогай файлы, которые менять не нужно. ' +
      'Пути — от корня ресурса, через прямой слэш.',
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

/** Запуск CLI по подписке — так же, как помощник форм. */
function runClaude(prompt: string, command: string, sessionId?: string): Promise<string> {
  const args = ['-p', '--output-format', 'json'];
  const safeId = safeSessionId(sessionId);
  if (safeId) args.push('--resume', safeId);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: isWindows,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Помощник не ответил за отведённое время'));
    }, 240_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.slice(0, 500) || `CLI завершился с кодом ${code}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
