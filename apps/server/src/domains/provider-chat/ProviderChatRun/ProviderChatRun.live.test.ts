import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../../../providers/registry.ts';
import { ProviderChatRun, type ProviderChatRunEvent } from './ProviderChatRun.ts';
import type { ProviderChatMessage } from '@agentdeck/contracts';
import type { LiveTurn, LiveTurnOptions, LiveTurnResult } from '../live/types.ts';
import { MAX_PROMPT_CHARS } from '../prompt/prompt.ts';

/**
 * Живой путь прогона (В1): серверный режим CLI идёт первым, его `unavailable`
 * молча уступает одиночному запуску, сообщение посреди ответа доходит до хода.
 * Подменён ход целиком — протоколы ходов проверяет `live/live-turns.test.ts`.
 */

class ScriptedTurn implements LiveTurn {
  readonly steers: string[] = [];
  seen?: LiveTurnOptions;
  stopped = false;
  private finish?: (result: LiveTurnResult) => void;

  private readonly script: (turn: ScriptedTurn) => LiveTurnResult | undefined;

  constructor(script: (turn: ScriptedTurn) => LiveTurnResult | undefined) {
    this.script = script;
  }

  run(
    options: LiveTurnOptions,
    onDelta: (text: string) => void,
    onSteerable?: () => void,
  ): Promise<LiveTurnResult> {
    this.seen = options;
    return new Promise((resolve) => {
      this.finish = resolve;
      const now = this.script(this);
      if (now) return resolve(now);
      onSteerable?.();
      onDelta('печатаю');
    });
  }

  end(result: LiveTurnResult): void {
    this.finish?.(result);
  }

  async steer(text: string): Promise<boolean> {
    this.steers.push(text);
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.end({ kind: 'done', reply: 'печатаю' });
  }
}

/** Одиночный запуск: печатает куски и закрывается. Пустой `chunks` — не звали. */
function oneShot(chunks: string[]) {
  let calls = 0;
  const fn = (() => {
    calls += 1;
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    child.kill = () => child.emit('close', null);
    setTimeout(() => {
      for (const chunk of chunks) (child.stdout as EventEmitter).emit('data', Buffer.from(chunk));
      child.emit('close', 0);
    }, 0);
    return child;
  }) as unknown as LiveTurnOptions['spawnImpl'];
  return { fn, calls: () => calls };
}

describe('ProviderChatRun: живой ход', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-live-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function start(
    turn: ScriptedTurn,
    spawnImpl?: LiveTurnOptions['spawnImpl'],
    history: ProviderChatMessage[] = [
      { id: 'm1', role: 'user', content: 'Вопрос', at: '2026-01-01T00:00:00.000Z' },
    ],
  ) {
    const run = new ProviderChatRun();
    const events: ProviderChatRunEvent[] = [];
    const kinds: unknown[] = [];
    const done = run.start(
      {
        provider: getProvider('codex'),
        history,
        chatId: 'chat',
        appDataDir: dir,
        detect: () => true,
        liveTurn: (kind) => {
          kinds.push(kind);
          return turn;
        },
        ...(spawnImpl ? { spawnImpl } : {}),
      } as Parameters<ProviderChatRun['start']>[0],
      (event) => events.push(event),
    );
    return { run, events, kinds, done };
  }

  it('длинный разговор доезжает до хода целиком: предела argv у запроса нет', async () => {
    const at = '2026-01-01T00:00:00.000Z';
    const turn = new ScriptedTurn(() => ({ kind: 'done', reply: 'ок' }));
    const { done } = start(turn, undefined, [
      { id: 'm1', role: 'user', content: 'Первое условие задачи', at },
      { id: 'm2', role: 'assistant', content: 'x'.repeat(MAX_PROMPT_CHARS + 1_000), at },
      { id: 'm3', role: 'user', content: 'Вопрос', at },
    ]);
    await done;
    expect(turn.seen?.prompt).toContain('Первое условие задачи');
    expect(turn.seen?.prompt).toContain('Вопрос');
  });

  it('ход принимает сообщение посреди ответа и кончается ответом транспорта live', async () => {
    const turn = new ScriptedTurn(() => undefined);
    const { run, events, kinds, done } = start(turn);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kinds).toEqual(['codex-app-server']);
    expect(turn.seen?.prompt).toContain('Вопрос');
    expect(events.map((event) => event.type)).toEqual(['steerable', 'delta']);

    expect(await run.steer('ещё одно')).toBe(true);
    expect(turn.steers).toEqual(['ещё одно']);

    turn.end({ kind: 'done', reply: 'печатаю и учёл' });
    await done;
    expect(events.at(-1)).toEqual({ type: 'done', reply: 'печатаю и учёл', transport: 'live' });
    // Ход кончился — входа больше нет, сообщение пойдёт в очередь.
    expect(await run.steer('опоздал')).toBe(false);
  });

  it('серверный режим не поднялся — ответ одиночным запуском, будто попытки не было', async () => {
    const turn = new ScriptedTurn(() => ({ kind: 'unavailable', why: 'нет подкоманды' }));
    const cli = oneShot([
      '{"type":"item.completed","item":{"type":"agent_message","text":"по-старому"}}\n',
    ]);
    const { events, done } = start(turn, cli.fn);
    await done;
    expect(cli.calls()).toBe(1);
    expect(events.some((event) => event.type === 'steerable')).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('ошибка хода — ошибка человеку, без второго запуска с той же ошибкой', async () => {
    const turn = new ScriptedTurn(() => ({ kind: 'error', error: 'model refused' }));
    const cli = oneShot(['не должен печатать']);
    const { events, done } = start(turn, cli.fn);
    await done;
    expect(cli.calls()).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: 'model refused',
      reason: 'cli_error',
    });
  });

  it('остановка снимает ход, напечатанное остаётся ответом', async () => {
    const turn = new ScriptedTurn(() => undefined);
    const { run, events, done } = start(turn);
    await new Promise((resolve) => setTimeout(resolve, 0));
    run.stop();
    await done;
    expect(turn.stopped).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', reply: 'печатаю', transport: 'live' });
    expect(await run.steer('после стопа')).toBe(false);
  });

  /**
   * «Что получил агент» (TQ-09) нужен и посреди долгого хода: вход пишется,
   * когда ход начат, а не когда он кончился.
   */
  it('вход хода записан, как только ход начат, — до его конца (TQ-09)', async () => {
    const turn = new ScriptedTurn(() => undefined);
    const inputs: string[] = [];
    const done = new ProviderChatRun().start(
      {
        provider: getProvider('codex'),
        history: [{ id: 'm1', role: 'user', content: 'Вопрос', at: '2026-01-01T00:00:00.000Z' }],
        chatId: 'chat',
        appDataDir: dir,
        detect: () => true,
        liveTurn: () => turn,
        systemPrefix: 'УКАЗАНИЕ ПАНЕЛИ',
        onInput: (text: string) => inputs.push(text),
      } as Parameters<ProviderChatRun['start']>[0],
      () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inputs).toEqual([turn.seen?.prompt]);
    expect(inputs[0]).toContain('УКАЗАНИЕ ПАНЕЛИ');

    turn.end({ kind: 'done', reply: 'ответ' });
    await done;
    expect(inputs).toHaveLength(1);
  });

  it('не поднявшийся ход входа не пишет — его пишет одиночный запуск, который ход сменил (TQ-09)', async () => {
    const turn = new ScriptedTurn(() => ({ kind: 'unavailable', why: 'нет подкоманды' }));
    const cli = oneShot([
      '{"type":"item.completed","item":{"type":"agent_message","text":"по-старому"}}\n',
    ]);
    const inputs: string[] = [];
    await new ProviderChatRun().start(
      {
        provider: getProvider('codex'),
        history: [{ id: 'm1', role: 'user', content: 'Вопрос', at: '2026-01-01T00:00:00.000Z' }],
        chatId: 'chat',
        appDataDir: dir,
        detect: () => true,
        liveTurn: () => turn,
        spawnImpl: cli.fn,
        onInput: (text: string) => inputs.push(text),
      } as Parameters<ProviderChatRun['start']>[0],
      () => undefined,
    );
    expect(cli.calls()).toBe(1);
    expect(inputs).toHaveLength(1);
  });

  it('подменённый процесс без подмены хода живой путь не включает', async () => {
    const cli = oneShot([
      '{"type":"item.completed","item":{"type":"agent_message","text":"ответ"}}\n',
    ]);
    const run = new ProviderChatRun();
    const events: ProviderChatRunEvent[] = [];
    await run.start(
      {
        provider: getProvider('codex'),
        history: [{ id: 'm1', role: 'user', content: 'Вопрос', at: '2026-01-01T00:00:00.000Z' }],
        chatId: 'chat',
        appDataDir: dir,
        detect: () => true,
        spawnImpl: cli.fn,
      } as Parameters<ProviderChatRun['start']>[0],
      (event) => events.push(event),
    );
    expect(cli.calls()).toBe(1);
    expect(events.at(-1)?.type).toBe('done');
  });
});
