import { describe, it, expect } from 'vitest';
import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';
import { TurnFeed, seqFrame } from './turn-feed.ts';

/** Кадры хода для клиента, вернувшегося после обрыва (F-101 D3). */
const text = (value: string) => ({ kind: 'text', text: value }) as PanelAgentRunEvent;

describe('TurnFeed', () => {
  it('отдаёт кадры после номера и шлёт новые подписчикам до конца хода', () => {
    const feed = new TurnFeed();
    feed.push(text('a'));
    feed.push(text('b'));
    expect(feed.since(1)?.map((frame) => frame.seq)).toEqual([2]);
    const got: unknown[] = [];
    const off = feed.subscribe((frame) => got.push(frame === 'end' ? 'end' : frame.seq));
    feed.push(text('c'));
    feed.end();
    off();
    expect(got).toEqual([3, 'end']);
    expect(feed.ended).toBe(true);
    expect(feed.subscribers).toBe(0);
  });

  it('вытесненное начало — undefined: склеить без дыры нельзя', () => {
    const feed = new TurnFeed(2);
    for (const value of ['a', 'b', 'c', 'd']) feed.push(text(value));
    expect(feed.since(0)).toBeUndefined();
    expect(feed.since(2)?.map((frame) => frame.seq)).toEqual([3, 4]);
  });

  it('кадр с номером начинается с data: — прежние читатели его понимают', () => {
    expect(seqFrame({ seq: 7, event: text('x') })).toBe(
      'data: {"kind":"text","text":"x"}\nid: 7\n\n',
    );
  });
});
