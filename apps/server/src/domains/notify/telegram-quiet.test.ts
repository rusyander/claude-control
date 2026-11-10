import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramSettings } from '@agentdeck/contracts';
import { createTelegramNotifier, type TelegramHeldLines } from './telegram.ts';
import type { HeldLine } from './telegram-notices/telegram-notices.types.ts';

/**
 * Тихие часы уведомителя прогонов (этап 12, P194): внутри окна сообщение ложится в общий файл
 * удержанного и не уходит; права и вопросы держатся, только если `quiet.asks`; в конце окна — одна
 * сводка на чат; удержанное до перезапуска уходит вскоре после старта. Подделан только Bot API.
 */

const BOT = '7654321:AAH-SUPER-SECRET-TOKEN-VALUE';
const NIGHT = new Date(2026, 10, 9, 2, 0).getTime();
const MORNING = new Date(2026, 10, 9, 9, 0).getTime();

function stubSend() {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response('{"ok":true,"result":{"message_id":9}}', { status: 200 });
    }),
  );
  return bodies;
}

function memoryHeld(initial: HeldLine[] = []): TelegramHeldLines & { lines: HeldLine[] } {
  const box = { lines: [...initial] };
  return {
    get lines() {
      return box.lines;
    },
    heldLines: () => [...box.lines],
    setHeldLines: (lines) => {
      box.lines = [...lines];
    },
  };
}

const settings = (asks = false): TelegramSettings => ({
  enabled: true,
  chatId: '4242',
  events: ['testFailed', 'permission'],
  quiet: { from: '23:00', to: '08:00', asks },
});

beforeEach(() => {
  vi.stubEnv('WEB_PORT', '8888');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('тихие часы уведомителя прогонов', () => {
  it('ночью красные тесты ложатся в сводку, право проходит; утром — одна сводка, удержанное снято', async () => {
    const bodies = stubSend();
    const held = memoryHeld();
    const clock = { now: NIGHT };
    const timers: { run: () => void; ms: number }[] = [];
    const notify = createTelegramNotifier({
      settings: () => settings(false),
      token: () => BOT,
      held,
      now: () => clock.now,
      schedule: (run, ms) => timers.push({ run, ms }),
    });
    notify({ kind: 'testFailed', chatId: 'run-1', failed: 2, total: 5 });
    notify({ kind: 'permission', chatId: 'run-1', toolName: 'Bash' });
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(String(bodies[0]!.text)).toContain('Bash');
    expect(held.lines).toHaveLength(1);
    expect(held.lines[0]!.text).toContain('2 из 5');
    // Таймер — к концу окна (08:00 + 1 с).
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(MORNING - 60 * 60_000 - NIGHT + 1_000);
    clock.now = MORNING;
    timers[0]!.run();
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    expect(String(bodies[1]!.text)).toMatch(/^<b>🌙 Пока было тихо \(1\):<\/b>/);
    expect(String(bodies[1]!.text)).toContain('2 из 5');
    expect(held.lines).toEqual([]);
  });

  it('«держать и вопросы» — право ночью тоже в сводку; днём всё уходит сразу', async () => {
    const bodies = stubSend();
    const held = memoryHeld();
    const clock = { now: NIGHT };
    const notify = createTelegramNotifier({
      settings: () => settings(true),
      token: () => BOT,
      held,
      now: () => clock.now,
      schedule: () => undefined,
    });
    notify({ kind: 'permission', chatId: 'run-1', toolName: 'Bash' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies).toHaveLength(0);
    expect(held.lines).toHaveLength(1);
    clock.now = MORNING;
    notify({ kind: 'testFailed', chatId: 'run-1', failed: 1 });
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(held.lines).toHaveLength(1);
  });

  it('удержанное до перезапуска — сводка вскоре после старта; окно ещё идёт — ждёт его конца', async () => {
    const bodies = stubSend();
    const line: HeldLine = { chatId: '4242', text: '<b>⛔ Тесты</b>', at: NIGHT };
    const timers: { run: () => void; ms: number }[] = [];
    const clock = { now: MORNING };
    const held = memoryHeld([line]);
    createTelegramNotifier({
      settings: () => settings(false),
      token: () => BOT,
      held,
      now: () => clock.now,
      schedule: (run, ms) => timers.push({ run, ms }),
    });
    expect(timers.map((one) => one.ms)).toEqual([1_000]);
    timers[0]!.run();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(held.lines).toEqual([]);

    const night = memoryHeld([line]);
    const nightTimers: { run: () => void; ms: number }[] = [];
    createTelegramNotifier({
      settings: () => settings(false),
      token: () => BOT,
      held: night,
      now: () => NIGHT,
      schedule: (run, ms) => nightTimers.push({ run, ms }),
    });
    nightTimers[0]!.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies).toHaveLength(1);
    expect(night.lines).toHaveLength(1);
    expect(nightTimers).toHaveLength(2);
  });
});
