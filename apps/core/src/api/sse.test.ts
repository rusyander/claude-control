import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { lastEventId, openSse } from './sse.ts';

/**
 * 07 §API: поток событий задачи. Подписка ставится до чтения хвоста, поэтому одно и то же
 * событие может прийти и из хвоста, и живым — дубль по `seq` поток отсеивает сам. Ответ
 * HTTP подменён записывающим объектом: граница — сокет, а не логика потока.
 */

function fakeResponse(): { res: ServerResponse; written: string[]; ended: () => boolean } {
  const emitter = new EventEmitter();
  const written: string[] = [];
  let ended = false;
  const res = Object.assign(emitter, {
    writeHead: () => res,
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: () => {
      ended = true;
    },
  }) as unknown as ServerResponse;
  return { res, written, ended: () => ended };
}

const line = (seq: number): JournalLine => ({ seq, kind: 'error' }) as unknown as JournalLine;

describe('SSE stream', () => {
  it('a seq already sent (or older) is never sent twice; close stops sending and runs onClose once', () => {
    const { res, written, ended } = fakeResponse();
    let closes = 0;
    const stream = openSse(res, { onClose: () => (closes += 1) });
    for (const seq of [3, 4, 4, 2, 5, 3]) stream.send(line(seq));
    const ids = written.flatMap((w) => /^id: (\d+)$/m.exec(w)?.[1] ?? []).map(Number);
    expect(ids).toEqual([3, 4, 5]);
    expect(stream.sent).toBe(3);
    stream.close();
    (res as unknown as EventEmitter).emit('close');
    stream.send(line(6));
    expect(stream.sent).toBe(3);
    expect(closes).toBe(1);
    expect(ended()).toBe(true);
  });

  it('Last-Event-ID: header wins over the query, garbage and negatives mean "from the start"', () => {
    expect(lastEventId('7', { lastEventId: '3' })).toBe(7);
    expect(lastEventId(['5', '9'], undefined)).toBe(5);
    expect(lastEventId(undefined, { lastEventId: '3' })).toBe(3);
    for (const bad of ['x', '-2', '1.5', '']) expect(lastEventId(bad, undefined)).toBe(0);
    // 07 §API `?from=<seq>` — включительно; заголовок и `lastEventId` главнее (ревью m2).
    expect(lastEventId(undefined, { from: '5' })).toBe(4);
    expect(lastEventId(undefined, { from: '1' })).toBe(0);
    expect(lastEventId('7', { from: '2' })).toBe(7);
    expect(lastEventId(undefined, { lastEventId: '3', from: '9' })).toBe(3);
  });
});
