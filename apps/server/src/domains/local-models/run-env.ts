import { LOCAL_COMPACT_RESERVE_TOKENS } from '@agentdeck/contracts/local-models';

/**
 * Окружение прогона Claude Code на локальной модели: настоящее окно сервера и
 * ограничения, без которых контекст переполняется молча.
 *
 * Почему именно эти четыре переменные (бинарь 2.1.286, живой разбор 13.10):
 * - `CLAUDE_CODE_MAX_CONTEXT_TOKENS` — окно незнакомой модели. Без него Claude
 *   Code считает 200 тысяч, а сервер держит 65–131 тысячу и молча обрезает
 *   начало запроса (вместе с системным промптом);
 * - `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — окно, по которому наступает сжатие. Оно
 *   ПЕРЕКРЫВАЕТ `autoCompactWindow` из settings.json человека (там стоит 300000
 *   под облачные модели) — без этой переменной сжатие не наступало бы никогда;
 * - `CLAUDE_CODE_MAX_OUTPUT_TOKENS` — резерв под ответ вычитается из окна, и 32000
 *   по умолчанию съедают половину окна в 65536; 8192 оставляют место истории (порог
 *   сжатия = окно − резерв − 13000: при 65536 это ~44 тыс. вместо ~36 тыс. при 16384,
 *   и после сжатия базового промпта запас остаётся — L1b, замер 13.10);
 * - `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=1` — видеокарта обслуживает один запрос
 *   за раз, параллельные вызовы только копят очередь и ответы в окне.
 *
 * Сроки и пределы вывода (L4b, бинарь 2.1.286, `strings` и разбор кода):
 * - `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`,
 *   `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`, `API_TIMEOUT_MS` — сколько Claude Code ждёт
 *   первый байт и паузу в потоке. Умолчания рассчитаны на облако (первый байт — 3 минуты
 *   у первой стороны); локальная модель до первого байта разбирает весь промпт, и
 *   законный разбор окна в 130 тысяч токенов длиннее. Срок считается от окна и измеренной
 *   скорости разбора (`localRequestBudgetMs`); сам Claude Code ограничивает его 30 минутами;
 * - `CLAUDE_CODE_RETRY_WATCHDOG=1` — повтор отказов «перегрузка» без предела: упавший
 *   сервер поднимает присмотр, и клиенту нужно дожить до этого, а не сдаться через ~3 минуты;
 * - `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` и `MAX_MCP_OUTPUT_TOKENS` — предел ответа одного
 *   инструмента: восьмая часть окна. Чтение большого файла иначе занимало бы половину
 *   окна одним ходом (умолчание 25 тысяч токенов при окне в 65 тысяч).
 *
 * Окно берётся ИЗ ЗАПИСИ о запущенном сервере, а не константой: контекст и тип
 * кеша меняются подбором под карту, а число, зашитое здесь, разошлось бы с ними.
 */

/** Резерв под ответ: меньше облачного, чтобы сжатие оставляло место истории. */
export const LOCAL_MAX_OUTPUT_TOKENS = 8_192;

/** Все переменные, которые ставит `localRunEnv`, — в порядке записи. */
export const LOCAL_RUN_ENV_VARS = [
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
  'CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
  'MAX_MCP_OUTPUT_TOKENS',
] as const;

/** Меньше этого срок первого байта не бывает: холодная загрузка модели с диска тоже в нём. */
export const LOCAL_REQUEST_FLOOR_MS = 300_000;
/** Предел самого Claude Code: больше 30 минут он срок не принимает. */
export const CLAUDE_TIMEOUT_CAP_MS = 1_800_000;
/** Скорость разбора промпта, пока замера нет (как у шлюза, `local-window.ts`). */
const FALLBACK_PROMPT_TPS = 150;
/** Запас на разброс скорости: тот же коэффициент, что у шлюза. */
const BUDGET_SLACK = 1.5;
/** Какая доля окна на ответ одного инструмента. */
export const LOCAL_TOOL_OUTPUT_SHARE = 8;

/**
 * Срок ожидания первого байта и паузы в потоке: полное окно, разобранное на измеренной
 * скорости, с запасом — но не меньше пяти минут и не больше предела Claude Code. Окно
 * берётся целиком, а не по текущему запросу: клиент не знает, насколько длинным будет
 * следующий, а срок короче разбора убивает законный запрос, и ход повторяется с нуля.
 */
export function localRequestBudgetMs(context: number, promptTokensPerSecond?: number): number {
  const speed =
    promptTokensPerSecond && promptTokensPerSecond > 0
      ? promptTokensPerSecond
      : FALLBACK_PROMPT_TPS;
  const processing = Math.ceil((context / speed) * 1_000 * BUDGET_SLACK);
  return Math.min(CLAUDE_TIMEOUT_CAP_MS, Math.max(LOCAL_REQUEST_FLOOR_MS, processing));
}

/**
 * Сколько токенов запроса Claude Code терпит до сжатия истории при окне `context`:
 * окно − резерв под ответ − служебные 13000 (`LOCAL_COMPACT_RESERVE_TOKENS`).
 * Не ниже нуля: на окне меньше резерва запас на MCP не бывает.
 */
export function localCompactAt(context: number): number {
  return Math.max(0, context - LOCAL_MAX_OUTPUT_TOKENS - LOCAL_COMPACT_RESERVE_TOKENS);
}

export function localRunEnv(
  context: number,
  promptTokensPerSecond?: number,
): Record<string, string> {
  const budget = localRequestBudgetMs(context, promptTokensPerSecond);
  const toolOutput = String(Math.max(1_000, Math.floor(context / LOCAL_TOOL_OUTPUT_SHARE)));
  return {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(context),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(context),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(LOCAL_MAX_OUTPUT_TOKENS),
    CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '1',
    CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: String(budget),
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: String(budget),
    CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: String(budget),
    API_TIMEOUT_MS: String(Math.max(600_000, budget + 120_000)),
    CLAUDE_CODE_RETRY_WATCHDOG: '1',
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: toolOutput,
    MAX_MCP_OUTPUT_TOKENS: toolOutput,
  };
}
