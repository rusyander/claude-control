import { spawn } from 'node:child_process';
import { safeSessionId } from '../lib/cli-args.ts';

/**
 * Помощник по заполнению форм. Работает через сам Claude Code в неинтерактивном
 * режиме (`claude -p`), поэтому использует уже настроенную подписку: никаких
 * отдельных ключей заводить не нужно.
 *
 * Модель просят вернуть строгий JSON с полями формы и коротким пояснением —
 * так ответ можно применить к форме, а не пересказывать пользователю текстом.
 */

export interface AssistRequest {
  /** Что заполняем: правило, скилл, хук, сервер, право, переменная, группа. */
  kind: string;
  /** Сообщение пользователя. */
  message: string;
  /** Текущее содержимое формы — чтобы дополнять, а не затирать. */
  fields: Record<string, unknown>;
  /** Описание полей: имя → что это, чтобы модель не выдумывала структуру. */
  schema: Record<string, string>;
  /** Идентификатор прошлого ответа: продолжает диалог вместо нового. */
  sessionId?: string;
}

export interface AssistResponse {
  reply: string;
  fields: Record<string, unknown>;
  sessionId?: string;
  /** Текст ошибки, если вызов не удался. */
  error?: string;
}

const isWindows = process.platform === 'win32';

function buildPrompt(request: AssistRequest): string {
  return [
    `Ты помогаешь заполнить форму «${request.kind}» в приложении управления настройками Claude Code.`,
    '',
    'Поля формы и их назначение:',
    ...Object.entries(request.schema).map(([key, hint]) => `- ${key}: ${hint}`),
    '',
    'Текущее содержимое формы (JSON):',
    JSON.stringify(request.fields, null, 2),
    '',
    `Запрос пользователя: ${request.message}`,
    '',
    'Верни ТОЛЬКО JSON без markdown-обёртки, строго такой структуры:',
    '{"reply": "короткое пояснение на русском, что ты заполнил или изменил",',
    ' "fields": {"имя_поля": "значение", ...}}',
    '',
    'В fields клади только те поля, которые нужно изменить, с готовыми значениями.',
    'Не добавляй полей, которых нет в списке выше. Не объясняй ничего вне JSON.',
  ].join('\n');
}

/**
 * Выдёргивает JSON из ответа: модель иногда оборачивает его в ```json,
 * несмотря на просьбу этого не делать.
 */
function extractJson(text: string): { reply: string; fields: Record<string, unknown> } | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      reply?: string;
      fields?: Record<string, unknown>;
    };
    return { reply: parsed.reply ?? '', fields: parsed.fields ?? {} };
  } catch {
    return null;
  }
}

/**
 * Запускает CLI и отдаёт промпт через стандартный ввод. Аргументом его
 * передавать нельзя: многострочный текст с кавычками рвётся оболочкой,
 * и до модели доходит обрывок.
 */
function runClaude(prompt: string, sessionId?: string): Promise<string> {
  const args = ['-p', '--output-format', 'json'];
  const safeId = safeSessionId(sessionId);
  if (safeId) args.push('--resume', safeId);

  return new Promise((resolve, reject) => {
    const child = spawn(isWindows ? 'claude.cmd' : 'claude', args, {
      shell: isWindows,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Помощник не ответил за отведённое время'));
    }, 180_000);

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

export async function askAssistant(request: AssistRequest): Promise<AssistResponse> {
  try {
    const stdout = await runClaude(buildPrompt(request), request.sessionId);
    const envelope = JSON.parse(stdout) as { result?: string; session_id?: string };
    const parsed = extractJson(envelope.result ?? '');

    if (!parsed) {
      // Модель ответила текстом вместо JSON — показываем ответ как есть,
      // поля не трогаем: лучше ничего не менять, чем испортить форму.
      return { reply: envelope.result ?? '', fields: {}, sessionId: envelope.session_id };
    }

    return { ...parsed, sessionId: envelope.session_id };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { reply: '', fields: {}, error: detail };
  }
}
