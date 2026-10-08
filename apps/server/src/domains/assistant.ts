import type { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnCliProcess } from '../lib/cli-spawn.ts';
import { killChildTree } from '../lib/process-tree.ts';
import { defaultCliCommand } from '../providers/cli.ts';
import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';
import { coded } from '../lib/server-text.ts';
import { SECRET_MASK } from '../lib/secret-mask.ts';
import {
  readStreamJsonResult,
  STREAM_JSON_INPUT_ARGS,
  streamJsonUserLine,
  type AgentImage,
} from '../lib/agent-images.ts';
import { lightWindowLayers } from './platform/layers.ts';
import { maskAssistText, maskFormFields, restoreFormSecrets } from './assistant-secrets.ts';

/**
 * Помощник по заполнению форм. Работает через сам Claude Code в неинтерактивном
 * режиме (`claude -p`), поэтому использует уже настроенную подписку: никаких
 * отдельных ключей заводить не нужно.
 *
 * Модель просят вернуть строгий JSON с полями формы и коротким пояснением —
 * так ответ можно применить к форме, а не пересказывать пользователю текстом.
 *
 * ЛЁГКОЕ ОКНО (решение владельца D4, 28.09). Помощнику не нужно ничего, кроме
 * задания: всё, что он знает о форме, — в тексте. Поэтому запуск без
 * инструментов, без сохранения сессии и без наших слоёв (правила, хуки, скиллы,
 * MCP человека) — теми же флагами, что у агента панели (`lightWindowLayers`), в
 * пустом временном каталоге. Разговор продолжается историей В ЗАПРОСЕ, а не
 * `--resume`: прежний запуск копил транскрипт на каждый вопрос к форме (130
 * файлов в `projects/…apps-server/` к 28.09) вместе с полями формы.
 */

/** Реплика прежнего разговора в окне помощника — её держит клиент. */
export interface AssistTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistRequest {
  /** Что заполняем: правило, скилл, хук, сервер, право, переменная, группа. */
  kind: string;
  /** Сообщение пользователя. */
  message: string;
  /** Текущее содержимое формы — чтобы дополнять, а не затирать. */
  fields: Record<string, unknown>;
  /** Описание полей: имя → что это, чтобы модель не выдумывала структуру. */
  schema: Record<string, string>;
  /** Прежние реплики окна, по порядку: сессии у помощника нет. */
  history?: readonly AssistTurn[];
  /** Картинки сообщения — уже проверенные маршрутом (`readAgentImages`). */
  images?: readonly AgentImage[];
}

export interface AssistResponse {
  reply: string;
  fields: Record<string, unknown>;
  /**
   * Поля, где модель переписала маску секрета так, что вернуть секрет нельзя:
   * их нет в `fields`, форма оставляет их как были и называет человеку.
   */
  kept?: string[];
  /** Текст ошибки, если вызов не удался. */
  error?: string;
  /** Код причины, если её назвала панель (отказ маршрута провайдера). */
  messageCode?: ServerMessageCode;
  params?: ServerMessageParams;
}

/** Сколько последних реплик истории уходит модели и сколько знаков в каждой. */
const HISTORY_TURNS = 20;
const HISTORY_TEXT_MAX = 4000;

/**
 * История для задания: последние реплики, секреты — маской. Общая для помощника
 * формы и помощника структуры.
 */
export function historyLines(history: readonly AssistTurn[] | undefined): string[] {
  const turns = (history ?? []).slice(-HISTORY_TURNS);
  if (turns.length === 0) return [];
  return [
    'Conversation so far in this window (oldest first):',
    ...turns.map((turn) => {
      const text = maskAssistText(turn.text).trim();
      const shown = text.length > HISTORY_TEXT_MAX ? `${text.slice(0, HISTORY_TEXT_MAX)}…` : text;
      return `${turn.role === 'assistant' ? 'Assistant' : 'Human'}: ${shown}`;
    }),
    '',
  ];
}

function buildPrompt(request: AssistRequest, maskedFields: Record<string, unknown>): string {
  return [
    `You help fill in the form "${request.kind}" in an app that manages Claude Code settings.`,
    'You have no tools: everything you know about the form is in this message.',
    '',
    'Form fields, their purpose and the kind of value each takes:',
    ...Object.entries(request.schema).map(([key, hint]) => `- ${key}: ${hint}`),
    '',
    `Current content of the form (JSON). ${SECRET_MASK} stands for a hidden secret value:`,
    JSON.stringify(maskedFields, null, 2),
    '',
    ...historyLines(request.history),
    `The user's current request: ${maskAssistText(request.message)}`,
    '',
    'Return ONLY one JSON object without a markdown wrapper, of this structure:',
    '{"reply": "a short explanation of what you filled in or changed, in the language of the user\'s request",',
    ' "fields": {"<field>": <value>, ...}}',
    'For example: {"reply": "Filled in the name, the tools and the timeout.",',
    ' "fields": {"name": "lint-on-save", "matchers": ["Edit", "Write"], "timeout": 30}}',
    '',
    'Rules for "fields":',
    '- Put in only the fields that must change, with ready values, and only fields from the list above.',
    '- Every value follows its field\'s "Value:" line exactly: a JSON array where it says array ' +
      '(never a comma-separated string), a JSON number where it says number (never a string), ' +
      'true or false for a flag, null only where the line allows it, and for allowed values only ' +
      'the quoted value itself, never its label in brackets.',
    '- If the user asks only for suggestions, options, ideas, an opinion or an explanation, or says ' +
      'not to change or fill anything, return "fields": {} and put the suggestions into "reply". ' +
      'Fill fields only when the user asks to fill, set, change, add or create something.',
    `- Never put a secret value into fields. Where a text you rewrite contains ${SECRET_MASK}, keep ` +
      'those parts exactly as shown. If the user wants a secret set, leave it out and say in ' +
      '"reply" that they type it into the form themselves.',
    '- Explain nothing outside the JSON.',
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
    const fields =
      parsed.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields)
        ? parsed.fields
        : {};
    return { reply: typeof parsed.reply === 'string' ? parsed.reply : '', fields };
  } catch {
    return null;
  }
}

/** Сколько ждать помощника формы. */
const ASSIST_TIMEOUT_MS = 180_000;

/**
 * Хвост лёгкого окна — общий для помощника формы, помощника структуры и
 * служебных вызовов модели через раннер (группы, окно ассистента): без
 * сохранения сессии, без наших слоёв, без инструментов. `--tools ""` —
 * последним: пустое значение вариадического флага съело бы следующий голый
 * аргумент (как у агента панели), поэтому хвост всегда в конце argv.
 */
export function lightWindowArgs(): string[] {
  return ['--no-session-persistence', ...lightWindowLayers().args, '--tools', ''];
}

/**
 * Рабочий каталог лёгкого окна — пустая временная папка: CLI ищет `CLAUDE.md`
 * вверх от него, и каталог сервера принёс бы правила репозитория. `cleanup`
 * не бросает: пустая папка без секретов — не повод ронять ответ.
 */
export function lightWindowDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cc-assistant-'));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Не удалилась (держит антивирус) — останется во временной папке ОС.
      }
    },
  };
}

/** Аргументы помощника формы: JSON-конверт (или поток с картинками) + лёгкое окно. */
export function oneShotArgs(streaming: boolean): string[] {
  return [
    '-p',
    ...(streaming ? STREAM_JSON_INPUT_ARGS : ['--output-format', 'json']),
    ...lightWindowArgs(),
  ];
}

/**
 * Запускает CLI и отдаёт промпт через стандартный ввод. Аргументом его
 * передавать нельзя: многострочный текст с кавычками рвётся оболочкой,
 * и до модели доходит обрывок. Ответ — конверт `--output-format json` в обоих
 * режимах. Общий для помощника формы и помощника структуры ресурса: вторая
 * копия уже разошлась с этой (не ловила EPIPE на stdin).
 *
 * Запуск — `spawnCliProcess` (настоящий `.exe` без оболочки, иначе квотирование
 * `shellArgs`): прежний `spawn(…, { shell: true })` на Windows склеивал argv
 * пробелами, и пустое значение `--tools ""` исчезло бы, а флаг съел бы
 * следующий. Рабочий каталог — пустая временная папка: CLI ищет `CLAUDE.md`
 * вверх от него, и каталог сервера принёс бы правила репозитория.
 */
export function runClaudeOneShot(
  prompt: string,
  command: string,
  images: readonly AgentImage[] = [],
  timeoutMs: number = ASSIST_TIMEOUT_MS,
  spawnImpl?: typeof nodeSpawn,
  /** Добавка к окружению сервера — переключатель «Claude Code на локальной модели». */
  env: Record<string, string> = {},
): Promise<string> {
  // С картинками — потоковый ввод (картинка едет блоком `image`), и итог
  // приходит событием `result` потокового вывода, а не одним JSON.
  const streaming = images.length > 0;
  const { dir, cleanup } = lightWindowDir();

  const spawned = spawnCliProcess(command, oneShotArgs(streaming), {
    cwd: dir,
    ...(spawnImpl ? { spawnImpl } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  });
  if (spawned.error) {
    cleanup();
    return Promise.reject(spawned.error);
  }
  const child = spawned.child;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      // Дерево, а не сам процесс: под `cmd.exe` обычный kill оставил бы CLI жить.
      killChildTree(child);
      cleanup();
      reject(coded(new Error('Помощник не ответил за отведённое время'), 'assistant-timeout'));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      if (code === 0) resolve(streaming ? envelopeOf(stdout) : stdout);
      else
        reject(
          new Error(failureText(stderr, stdout, streaming) || `CLI завершился с кодом ${code}`),
        );
    });

    // Обработчик ОБЯЗАТЕЛЕН: CLI закрывается сразу (сломан, не залогинен), а
    // промпт со схемой и всей формой обычно длиннее буфера канала, и
    // недописанный поток отдаёт EPIPE (на Windows EOF) отдельным `error`.
    // Необработанное событие потока роняет весь сервер — здесь же это лишь
    // «ввод не долетел»: исход прогона решают код выхода и stderr ниже.
    child.stdin.on('error', () => undefined);
    child.stdin.write(streaming ? streamJsonUserLine(prompt, images) : prompt);
    child.stdin.end();
  });
}

/**
 * Причина сбоя для человека. Claude Code кладёт её не в stderr, а в `result`
 * своего ответа: без входа stderr пуст, а в stdout — «Not logged in · Please
 * run /login». Голое «код 1» не говорит человеку, что делать.
 */
function failureText(stderr: string, stdout: string, streaming: boolean): string {
  if (stderr.trim()) return stderr.trim().slice(0, 500);
  if (streaming) return (readStreamJsonResult(stdout)?.text ?? '').trim().slice(0, 500);
  const last = stdout.trim().split('\n').pop() ?? '';
  try {
    const envelope = JSON.parse(last) as { result?: unknown };
    return typeof envelope.result === 'string' ? envelope.result.trim().slice(0, 500) : '';
  } catch {
    return last.trim().slice(0, 500);
  }
}

/** Итог потокового вывода в форме конверта `--output-format json`. */
function envelopeOf(stdout: string): string {
  const result = readStreamJsonResult(stdout);
  return JSON.stringify({
    result: result?.text ?? '',
    is_error: result?.isError ?? true,
  });
}

/**
 * Ответ модели окну помощника: текст либо отказ/сбой — с кодом, если причину
 * назвала панель (маршрут провайдера, `assistant-route.ts`).
 */
export type HelperOutcome =
  | { ok: true; text: string }
  | { ok: false; error: string; messageCode?: ServerMessageCode; params?: ServerMessageParams };

/**
 * Кто отвечает окну: промпт (уже под маской) и картинки → текст модели. Решает
 * маршрут активного провайдера (`assistant-route.ts → helperAsk`); здесь только
 * то, что окно делает с ответом. Функцией, а не маршрутом: модуль маршрута сам
 * зовёт этот файл, и обратный импорт замкнул бы круг.
 */
export type HelperAsk = (
  prompt: string,
  images: readonly AgentImage[],
  timeoutMs: number,
) => Promise<HelperOutcome>;

/** Прежний путь окна — процесс `claude` по подписке, ответ из конверта JSON. */
export function claudeAsk(
  command: string,
  spawnImpl?: typeof nodeSpawn,
  env: Record<string, string> = {},
): HelperAsk {
  return async (prompt, images, timeoutMs) => {
    const stdout = await runClaudeOneShot(prompt, command, images, timeoutMs, spawnImpl, env);
    const envelope = JSON.parse(stdout) as { result?: string };
    return { ok: true, text: envelope.result ?? '' };
  };
}

/** Строка — команда `claude` (прежняя подпись), функция — маршрут провайдера. */
export function helperAskOf(ask: string | HelperAsk): HelperAsk {
  return typeof ask === 'string' ? claudeAsk(ask) : ask;
}

export async function askAssistant(
  request: AssistRequest,
  ask: string | HelperAsk = defaultCliCommand(),
): Promise<AssistResponse> {
  try {
    const fields = request.fields ?? {};
    const masked = maskFormFields(fields);
    const answer = await helperAskOf(ask)(
      buildPrompt(request, masked),
      request.images ?? [],
      ASSIST_TIMEOUT_MS,
    );
    if (!answer.ok) {
      // Отказ маршрута (контур, провайдер без запуска) — с кодом: клиент назовёт
      // причину на своём языке, а не общим «помощник не ответил».
      return {
        reply: '',
        fields: {},
        error: answer.error,
        ...(answer.messageCode ? { messageCode: answer.messageCode } : {}),
        ...(answer.params ? { params: answer.params } : {}),
      };
    }
    const parsed = extractJson(answer.text);

    if (!parsed) {
      // Модель ответила текстом вместо JSON — показываем ответ как есть,
      // поля не трогаем: лучше ничего не менять, чем испортить форму.
      return { reply: answer.text, fields: {} };
    }

    const restored = restoreFormSecrets(fields, masked, parsed.fields);
    return {
      reply: parsed.reply,
      fields: restored.fields,
      ...(restored.kept.length > 0 ? { kept: restored.kept } : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { reply: '', fields: {}, error: detail };
  }
}
