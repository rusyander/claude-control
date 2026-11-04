import type { PlatformGatewayEvent } from '@agentdeck/contracts';
import type { LocalActivity } from '@agentdeck/contracts/local-models';
import { LOCAL_PLATFORM_ID } from '@agentdeck/contracts/platform-layers';

/**
 * Что чат видит о локальной модели (`GET /api/local-models/activity`, L6): какой сервер стоит и
 * чем кончился последний запрос к нему.
 *
 * Запросы чата к локальной модели идут через шлюз ядра (этап 10): панель их больше не ведёт и
 * сама сервер во время хода не опрашивает. Отказ сервера моделей ядро пишет в свою книгу
 * контуров (`traceOf` шлюза → событие контура `local-ollama` с кодом и текстом), панель читает
 * её через `CoreContours.live()`. Отсюда — память отказа (L6, 15.10): плашка чата показывала
 * «агент выполняет инструменты», пока каждый запрос падал 500, а Claude Code молча повторял.
 * Последнее событие контура — отказ: чат видит код и текст; удачный ответ после него стирает.
 *
 * Этапов хода (загрузка, разбор промпта, ответ по опросу `/health` и `/slots`) нет: их видел
 * только шлюз панели, у ядра ленты активности звена пока нет (этап 11). Чат судит по отказу и по
 * времени последнего запроса.
 */

/** Предел текста отказа: ошибка шаблона llama.cpp — экран с выдержкой из исходника. */
const ERROR_TEXT_MAX = 300;

/** Последний запрос к локальной модели и его отказ — по событиям книги контуров ядра. */
export function localOutcomeOf(
  events: readonly PlatformGatewayEvent[] | undefined,
): Pick<LocalActivity, 'lastRequestAt' | 'lastError'> {
  let last: PlatformGatewayEvent | undefined;
  let lastAt = -Infinity;
  for (const event of events ?? []) {
    if (event.platformId !== LOCAL_PLATFORM_ID) continue;
    const at = Date.parse(event.at);
    if (Number.isFinite(at) && at >= lastAt) {
      last = event;
      lastAt = at;
    }
  }
  if (!last) return {};
  // 503 — сервер ещё грузит модель («Loading model»): этап, а не отказ, клиент повторит.
  // 499 — ушёл сам клиент: сервер тут ни при чём.
  const refused = last.status >= 400 && last.status !== 503 && last.status !== 499;
  const message = (last.error ?? '').trim() || `HTTP ${last.status}`;
  return {
    lastRequestAt: lastAt,
    ...(refused
      ? {
          lastError: { at: lastAt, status: last.status, message: message.slice(0, ERROR_TEXT_MAX) },
        }
      : {}),
  };
}

export interface ActivityDeps {
  /** Что за сервер: модель, квантование, окно. Нет записи — сервера нет. */
  server: () => { model: string; quant?: string; context: number } | undefined;
  /** События книги контуров ядра (последний снимок); ядро молчит — `undefined`. */
  events: () => readonly PlatformGatewayEvent[] | undefined;
}

export function localActivityOf(deps: ActivityDeps): LocalActivity {
  const server = deps.server();
  return {
    ...(server
      ? {
          model: server.model,
          ...(server.quant ? { quant: server.quant } : {}),
          context: server.context,
        }
      : {}),
    ...localOutcomeOf(deps.events()),
  };
}
