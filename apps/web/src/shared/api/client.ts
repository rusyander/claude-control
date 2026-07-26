import axios from 'axios';

/**
 * Клиент локального API. Базовый путь относительный — Vite проксирует /api
 * на сервер, поэтому адрес и порт нигде в коде не зашиты и не мешают
 * будущей сборке под Electron.
 */
export const apiClient = axios.create({
  baseURL: '/api',
  timeout: 60_000,
});

/**
 * Долгие маршруты: клиентский таймаут обязан перекрывать бюджет сервера, иначе
 * запрос рвётся ложной ошибкой таймаута, пока сервер спокойно доводит работу и
 * записывает результат. Общие 60 c коротки для запуска CLI на холодную.
 */
export const LONG_TIMEOUTS = {
  /** assistant-runner: DEFAULT_TIMEOUT 180 c. */
  assistantRun: 200_000,
  /** provider-check: ASSISTANT_TIMEOUT_MS 90 c на шаг ассистента. */
  providerCheck: 120_000,
  /**
   * checkMcpHealth и listMcpServerTools: max(30 c, ceil(mcpNetworkTimeoutMs / 0.67)
   * + 1 c) ≤ ~180 c. Бюджет у них общий — и таймаут клиента обязан быть общим тоже.
   */
  mcpHealth: 200_000,
} as const;

/**
 * Человеческий текст ошибки из тела ответа. Часть маршрутов (история, бэкапы)
 * отдаёт объяснение в поле `error` без `message`, а конверт Fastify — наоборот,
 * держит в `error` служебное имя статуса («Bad Request»). Поэтому порядок
 * такой: сначала `message`, и только при его отсутствии — `error`.
 */
export function messageFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { message, error } = payload as { message?: unknown; error?: unknown };
  for (const candidate of [message, error]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
}

/**
 * Сообщение об ошибке, пригодное для показа пользователю. Сервер присылает
 * человеческий текст в теле ответа — берём его, а не сырой статус axios
 * («Request failed with status code 400» пользователю ничего не объясняет).
 */
export function toErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return messageFromPayload(error.response?.data) ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
