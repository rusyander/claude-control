import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { followTask, openSse } from './sse.ts';

/**
 * Хвост журнала не прочитался после того, как ответ уже перехвачен (ревью F-48): подписка на
 * живую задачу снимается, поток закрывается, исключение не уходит наверх — иначе подписка жила
 * бы вечно, а буфер повтора рос с каждой строкой задачи.
 */

function fakeResponse(): ServerResponse {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    writeHead: () => emitter,
    write: () => true,
    end: () => undefined,
  }) as unknown as ServerResponse;
}

describe('SSE follow', () => {
  it('F-48 a throwing tail read unsubscribes the live listener, unwatches and closes the stream, never throws', () => {
    let listeners = 0;
    let watchers = 0;
    let closes = 0;
    const stream = openSse(fakeResponse(), { onClose: () => (closes += 1) });
    const task = {
      subscribe: (_listener: (line: JournalLine) => void) => {
        listeners += 1;
        return () => {
          listeners -= 1;
        };
      },
    };
    const feed = {
      live: () => task,
      watch: () => {
        watchers += 1;
        return () => {
          watchers -= 1;
        };
      },
      linesAfter: (): Iterable<JournalLine> => {
        throw new Error('EBUSY: journal locked');
      },
    };
    let off: (() => void) | undefined;
    expect(() => {
      off = followTask(stream, feed, 0);
    }).not.toThrow();
    expect({ listeners, watchers, closed: stream.closed, closes }).toEqual({
      listeners: 0,
      watchers: 0,
      closed: true,
      closes: 1,
    });
    off?.();
    expect({ listeners, watchers }).toEqual({ listeners: 0, watchers: 0 });
  });
});
