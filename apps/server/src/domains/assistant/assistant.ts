import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';
import { SECRET_MASK } from '@agentdeck/dlp/secret-mask';
import type { AgentImage } from '../../lib/agent-images/agent-images.ts';
import type { AppStore } from '../../lib/app-store/app-store.ts';
import { maskAssistText, maskFormFields, restoreFormSecrets } from '../assistant-secrets.ts';
import { askOneShot } from '../core-ask/one-shot.ts';
import type { AskCarry, CoreAskPort } from '../core-ask/core-ask.types.ts';

/**
 * Помощник по заполнению форм. Ход — вопрос ядра «ask» активным CLI (этап 10, F2b): ядро
 * запускает его своей дорогой (маршрут, контур, DLP, журнал), подписка CLI та же.
 *
 * Модель просят вернуть строгий JSON с полями формы и коротким пояснением —
 * так ответ можно применить к форме, а не пересказывать пользователю текстом.
 *
 * ЛЁГКОЕ ОКНО (решение владельца D4, 28.09). Помощнику не нужно ничего, кроме
 * задания: всё, что он знает о форме, — в тексте. Поэтому вопрос без
 * инструментов и без слоёв человека (правила, хуки, скиллы, MCP) во временном
 * каталоге ядра. Разговор продолжается историей В ЗАПРОСЕ, а не продолжением
 * сессии CLI: прежний запуск копил транскрипт на каждый вопрос к форме.
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
 * Ответ модели окну помощника: текст либо отказ/сбой — с кодом, если причину
 * назвала панель или ядро (`core-ask/one-shot.ts`).
 */
export type HelperOutcome =
  | { ok: true; text: string }
  | { ok: false; error: string; messageCode?: ServerMessageCode; params?: ServerMessageParams };

/**
 * Кто отвечает окну: промпт (уже под маской) и картинки → текст модели. Отвечает
 * вопрос ядра (`coreHelperAsk`); здесь только то, что окно делает с ответом.
 * Функцией — проверки подают свою, без ядра.
 */
export type HelperAsk = (
  prompt: string,
  images: readonly AgentImage[],
  timeoutMs: number,
) => Promise<HelperOutcome>;

/**
 * Окно помощника через ядро (этап 10, F2b): вопрос «ask» без инструментов маршрутом активного
 * CLI и профиля «Ассистент панели» (`core-ask/one-shot.ts`). Своего процесса `claude -p` у
 * окна больше нет: ядро запускает CLI во временном каталоге задачи, без слоёв человека.
 */
export function coreHelperAsk(
  port: CoreAskPort,
  store: AppStore,
  appDataDir: string,
  /** Набор панели чужому CLI (`helperCarryOf`, G13) — как прежнее окно, Claude без набора. */
  carry?: AskCarry,
): HelperAsk {
  return async (prompt, images, timeoutMs) => {
    const result = await askOneShot(port, store, appDataDir, {
      title: 'panel helper',
      messages: [{ role: 'user', content: prompt, images }],
      timeoutMs,
      ...(carry ? { carry } : {}),
    });
    if (result.ok) return { ok: true, text: result.reply };
    return {
      ok: false,
      error: result.error,
      ...(result.messageCode ? { messageCode: result.messageCode } : {}),
      ...(result.params ? { params: result.params } : {}),
    };
  };
}

export async function askAssistant(
  request: AssistRequest,
  ask: HelperAsk,
): Promise<AssistResponse> {
  try {
    const fields = request.fields ?? {};
    const masked = maskFormFields(fields);
    const answer = await ask(buildPrompt(request, masked), request.images ?? [], ASSIST_TIMEOUT_MS);
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
