import { describe, it, expect } from 'vitest';
import { createEventHub } from './event-hub.ts';

describe('event hub', () => {
  it('кадр changed не изменился: веб и телефон разбирают именно эти ключи в этом порядке', () => {
    const hub = createEventHub();
    const frames: string[] = [];
    hub.subscribe((payload) => frames.push(payload));
    hub.broadcast(['rules'], '/x/rule.md');
    expect(frames).toHaveLength(1);
    expect(Object.keys(JSON.parse(frames[0] ?? '{}') as object)).toEqual([
      'type',
      'domains',
      'path',
      'at',
    ]);
    expect(frames[0]).toMatch(
      /^\{"type":"changed","domains":\["rules"\],"path":"\/x\/rule\.md","at":"[^"]+"\}$/,
    );
  });

  it('кадры агента идут тем же потоком; отписка работает', () => {
    const hub = createEventHub();
    const frames: Array<Record<string, unknown>> = [];
    const off = hub.subscribe((payload) =>
      frames.push(JSON.parse(payload) as Record<string, unknown>),
    );
    expect(hub.size()).toBe(1);
    hub.emit({ type: 'agent-open-page', page: { route: '/chat' } });
    off();
    hub.emit({ type: 'agent-decided', id: 'x', outcome: 'done' });
    expect(hub.size()).toBe(0);
    expect(frames).toEqual([
      expect.objectContaining({
        type: 'agent-open-page',
        page: { route: '/chat' },
        at: expect.any(String),
      }),
    ]);
  });
});
