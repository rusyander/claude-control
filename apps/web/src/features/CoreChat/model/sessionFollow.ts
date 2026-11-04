import {
  SESSION_STREAM_SSE_EVENT,
  sessionEventKeys,
  type SessionStreamEvent,
} from '@agentdeck/contracts/core/session-stream';
import { createSseParser } from '@entities/CoreTask';

/**
 * Поток вида сеанса чата ядра (`GET /api/core/tasks/:id/sessions/:sid/stream?follow=1`): кадр
 * `page` на каждую порцию, `id:` — байтовый курсор `next`. Свой читатель, а не `followCoreEvents`:
 * тот отсеивает событие с номером не больше прежнего, а здесь новый кадр законно несёт тот же
 * курсор (ход человека ушёл, ответа ещё нет). Обрыв — повтор с `Last-Event-ID` = курсор; первый
 * кадр после повтора отдаёт события с курсора заново, и уже показанные (ход на границе) отсеиваются
 * ключом `sessionEventKeys` — ход не теряется и не двоится. `done: true` — сеанс кончился и
 * дочитан: поток закрыт, повтора нет.
 */

export interface SessionPage {
  events: SessionStreamEvent[];
  next: number;
  done: boolean;
}

export interface FollowSessionOptions {
  url: string;
  signal: AbortSignal;
  onEvents(events: SessionStreamEvent[], done: boolean): void;
  onRefusal?(status: number, body: string): void;
  onDrop?(reason: string, delayMs: number): void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  backoffMs?: (attempt: number) => number;
}

const defaultBackoff = (attempt: number) => Math.min(15_000, 400 * 2 ** Math.min(attempt, 6));

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });

/** Адрес потока: `follow=1` доходит до ядра через прокладку (заголовок `Accept` она не несёт). */
export function sessionStreamUrl(taskId: string, sessionId: string): string {
  return `/api/core/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}/stream?follow=1`;
}

/**
 * Отсев повтора на стыке подключений: из первой страницы нового подключения убираются события,
 * уже показанные с этого курсора (ключи считаются по тем же событиям с курсора — порядок строки
 * при повторе тот же).
 */
export function freshAfterReconnect(
  shownFromCursor: readonly SessionStreamEvent[],
  page: readonly SessionStreamEvent[],
): SessionStreamEvent[] {
  const shown = new Set(sessionEventKeys(shownFromCursor));
  const keys = sessionEventKeys(page);
  return page.filter((_, i) => !shown.has(keys[i] as string));
}

/** Ведёт поток до `done` или отмены; ответ — последний курсор. */
export async function followSession(options: FollowSessionOptions): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? abortableSleep;
  const backoff = options.backoffMs ?? defaultBackoff;
  let cursor = 0;
  // События с офсетом не меньше курсора, уже отданные наружу: их повтор после обрыва отсеивается.
  let atCursor: SessionStreamEvent[] = [];
  let attempt = 0;
  while (!options.signal.aborted) {
    let reason = 'stream ended';
    try {
      const headers: Record<string, string> = { accept: 'text/event-stream' };
      if (cursor > 0 || atCursor.length > 0) headers['last-event-id'] = String(cursor);
      const res = await fetchImpl(options.url, { headers, signal: options.signal });
      if (res.status !== 200 || !res.body) {
        options.onRefusal?.(res.status, await res.text().catch(() => ''));
        return cursor;
      }
      const parser = createSseParser();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let first = true;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.push(value)) {
          if (frame.event === 'error') {
            reason = `stream error: ${frame.data}`;
            continue;
          }
          if (frame.event !== SESSION_STREAM_SSE_EVENT) continue;
          const page = JSON.parse(frame.data) as SessionPage;
          const events = first ? freshAfterReconnect(atCursor, page.events) : page.events;
          first = false;
          attempt = 0;
          if (page.next !== cursor) atCursor = [];
          cursor = page.next;
          atCursor = [...atCursor, ...events.filter((e) => e.offset >= cursor)];
          if (events.length > 0 || page.done) options.onEvents(events, page.done);
          if (page.done) return cursor;
        }
      }
    } catch (error) {
      if (options.signal.aborted) break;
      reason = error instanceof Error ? error.message : String(error);
    }
    const delay = backoff(attempt);
    attempt += 1;
    options.onDrop?.(reason, delay);
    await sleep(delay, options.signal);
  }
  return cursor;
}
