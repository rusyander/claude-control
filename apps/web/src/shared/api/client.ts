import axios from 'axios';
import { serverMessageFromPayload } from '@shared/config/i18n';
import { WATCH_SEEN_HEADER } from '@agentdeck/contracts';
import {
  isWatchCaptureEnabled,
  looksLikeWrongShape,
  reportApiFailure,
  reportContractMismatch,
} from '@shared/lib/watch-capture';

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
 * Фоновому наблюдателю (если он включён): отказ, которого сервер не видел
 * (обрыв сети, 5xx прокси; видел — в ответе его заголовок), и ответ не того
 * вида — HTML вместо JSON. Отказ остаётся отказом, ответ — ответом: перехватчик
 * только смотрит и передаёт дальше. Отменённый запрос (ушли со страницы) — не сбой.
 */
apiClient.interceptors.response.use(
  (response) => {
    const contentType = String(response.headers?.['content-type'] ?? '');
    if (isWatchCaptureEnabled() && looksLikeWrongShape(response.data, contentType)) {
      reportContractMismatch({
        method: response.config?.method,
        url: response.config?.url,
        status: response.status,
        contentType,
        body: response.data,
      });
    }
    return response;
  },
  (error: unknown) => {
    if (axios.isAxiosError(error) && !axios.isCancel(error)) {
      reportApiFailure({
        method: error.config?.method,
        url: error.config?.url,
        status: error.response?.status,
        message: messageFromPayload(error.response?.data) ?? error.message,
        seenByServer: Boolean(error.response?.headers?.[WATCH_SEEN_HEADER]),
      });
    }
    return Promise.reject(error);
  },
);

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
  /**
   * Вопрос агенту контура: у сервера бюджет 125 c (`domains/platform/agents.ts`,
   * AGENT_TIMEOUT_MS), потому что сам контур ведёт прогон агента до ~115 c и
   * потоком его не отдаёт — заголовки приезжают в конце. На общих 60 c браузер
   * рвал бы каждый ответ длиннее минуты ложным таймаутом, пока контур спокойно
   * доводит прогон и списывает его с ключа.
   */
  agentAsk: 140_000,
  /**
   * Активация контура: проба (PROBE_TIMEOUT_MS 15 c) и пробный запрос через свой
   * же шлюз (SMOKE_TIMEOUT_MS 30 c) идут ПОДРЯД — 45 c бюджета сервера. Общих
   * 60 c хватало бы впритык, а оборванная браузером активация выглядела бы как
   * неудавшаяся при удавшейся: транзакция к тому моменту уже записана.
   */
  platformActivate: 70_000,
  /**
   * Картинка (Т9): у сервера бюджет 180 c (`domains/media/images.ts`,
   * IMAGE_TIMEOUT_MS) — рисование идёт минутами, и ответ приезжает целиком в
   * конце. Оборванный браузером запрос выглядел бы как неудача при удаче:
   * картинку контур уже нарисовал и деньги ключа списал.
   */
  mediaImage: 190_000,
  /**
   * Презентация (Т10): у сервера бюджет 120 c (`domains/media/presentations.ts`,
   * DECK_TIMEOUT_MS) — это обычный ответ модели, а не рисование, но ответ длинный
   * и приезжает целиком. Плюс сборка файлов панелью: PPTX собирается уже после
   * ответа, и общий потолок обязан покрывать и её.
   */
  mediaDeck: 140_000,
  /**
   * Печать PDF колоды: у сервера 90 c (`deck/pdf.ts`, PRINT_TIMEOUT_MS) на запуск
   * браузера и печать. Ссылку на файл браузер тянет сам, а здесь потолок нужен
   * тому же адресу, когда за PDF идёт наш запрос.
   */
  mediaDeckPdf: 100_000,
} as const;

/**
 * Человеческий текст ошибки из тела ответа. Часть маршрутов (история, бэкапы)
 * отдаёт объяснение в поле `error` без `message`, а конверт Fastify — наоборот,
 * держит в `error` служебное имя статуса («Bad Request»). Поэтому порядок
 * такой: сначала `message`, и только при его отсутствии — `error`.
 */
export function messageFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  // Код текста — первым: русская строка сервера остаётся запасной (решение
  // владельца: сервер по-английски не пишет, переводит клиент).
  const translated = serverMessageFromPayload(payload);
  if (translated) return translated;
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

/**
 * Отказ 409 — «занято»: сервер отверг запрос не из-за его формы, а потому что
 * состояние ушло вперёд (прогон уже идёт, группу держит чужой прогон). Экран,
 * получивший такой отказ, устарел и должен перечитать состояние.
 */
export function isConflict(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 409;
}
