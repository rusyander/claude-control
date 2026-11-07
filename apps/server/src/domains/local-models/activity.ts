import { z } from 'zod';
import type { PlatformGatewayEvent } from '@agentdeck/contracts';
import {
  HOP_STALL_CPU_MS,
  HOP_STALL_GPU_MS,
  hopActivitySchema,
  type HopActivity,
} from '@agentdeck/contracts/core/hops';
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
 * Этапы хода (загрузка, разбор промпта, ответ по опросу `/health` и `/slots`) с этапа 11 ведёт
 * лента звена ядра — сервер моделей опрашивает хост звеньев, и только пока запрос в полёте;
 * панель её лишь читает (`withHopActivity`). Ядро ленты не дало — чат судит по отказу и по
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
  /**
   * Что за сервер: модель, квантование, окно, устройство. Нет записи — сервера нет; устройство
   * задаёт предел тишины (`stallMs`).
   */
  server: () => { model: string; quant?: string; context: number; device?: string } | undefined;
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
          // Предел тишины — тот же, что у ленты звена ядра (один источник в контракте).
          stallMs: server.device === 'cpu' ? HOP_STALL_CPU_MS : HOP_STALL_GPU_MS,
        }
      : {}),
    ...localOutcomeOf(deps.events()),
  };
}

const hopRoutesSchema = z.array(hopActivitySchema);

/**
 * Ход по ленте звена ядра (этап 11, W2-5; `GET /api/core/local/activity` → `{routes}`). Из
 * локальных маршрутов берётся тот, где запрос в полёте и движение свежее всех; в полёте никого —
 * последний двигавшийся. Застой пересчитывается по пределу ЭТОГО сервера: звено устройства не
 * знает и судит по видеокарте, а процессор законно молчит дольше.
 *
 * Тело ядра не той формы (ядро прежней версии, отказ) — хода нет, остаётся `base`.
 */
export function withHopActivity(base: LocalActivity, body: unknown, now: number): LocalActivity {
  const raw = body && typeof body === 'object' ? (body as { routes?: unknown }).routes : undefined;
  const parsed = hopRoutesSchema.safeParse(raw);
  if (!parsed.success) return base;
  const latest = (list: HopActivity[]): HopActivity | undefined =>
    list.reduce<HopActivity | undefined>(
      (best, item) => (!best || item.lastMoveAt > best.lastMoveAt ? item : best),
      undefined,
    );
  const hop = latest(parsed.data.filter((item) => item.inFlight > 0)) ?? latest(parsed.data);
  if (!hop) return base;
  const stallMs = base.stallMs ?? HOP_STALL_GPU_MS;
  const moving = hop.phase === 'queued' || hop.phase === 'prompt' || hop.phase === 'generating';
  return {
    ...base,
    phase: hop.phase,
    inFlight: hop.inFlight,
    ...(hop.startedAt !== undefined ? { startedAt: hop.startedAt } : {}),
    ...(hop.prompt ? { prompt: hop.prompt } : {}),
    ...(hop.decoded !== undefined ? { decoded: hop.decoded } : {}),
    lastMoveAt: hop.lastMoveAt,
    stalled: hop.inFlight > 0 && moving && now - hop.lastMoveAt >= stallMs,
    stallMs,
  };
}
