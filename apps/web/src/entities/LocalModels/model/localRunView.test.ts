import { describe, expect, it } from 'vitest';
import type { LocalActivity } from '@agentdeck/contracts/local-models';
import { localRunView, SILENT_AFTER_MS, STALL_MEMORY_MS } from './localRunView';

const NOW = 1_800_000_000_000;
const base: LocalActivity = {
  phase: 'prompt',
  model: 'qwen3.6:27b-coding',
  quant: 'UD-Q4_K_XL',
  context: 131_072,
  inFlight: 1,
  promptTokens: 80_000,
  filled: 20_000,
  decoded: 0,
  silentMs: 1_000,
  stallMs: 120_000,
};

describe('строка состояния локальной модели (L6)', () => {
  it('разбор промпта: сколько из скольких и доля; сервер — модель, квантование, окно', () => {
    const view = localRunView(base, false, NOW);
    expect(view.server).toEqual({
      model: 'qwen3.6:27b-coding',
      quant: 'UD-Q4_K_XL',
      context: 131_072,
    });
    expect(view.stage).toEqual({ key: 'prompt', filled: 20_000, total: 80_000, share: 0.25 });
    expect(view.silent).toBeUndefined();
  });

  it('оценка шлюза меньше заполнения — доли нет, только число', () => {
    expect(localRunView({ ...base, filled: 90_000 }, false, NOW).stage).toEqual({
      key: 'prompt',
      filled: 90_000,
    });
  });

  it('ждущее разрешение важнее этапа сервера', () => {
    expect(localRunView(base, true, NOW).stage).toEqual({ key: 'permission' });
  });

  it('тишина с порога: секунды и сколько осталось до повтора; на загрузке модели — нет', () => {
    const silent = localRunView({ ...base, silentMs: SILENT_AFTER_MS + 10_000 }, false, NOW);
    expect(silent.silent).toEqual({ seconds: 30, left: 90 });
    expect(
      localRunView({ ...base, phase: 'loading', silentMs: 60_000 }, false, NOW).silent,
    ).toBeUndefined();
    expect(
      localRunView({ ...base, silentMs: SILENT_AFTER_MS - 1 }, false, NOW).silent,
    ).toBeUndefined();
  });

  it('запроса в пути нет — агент у инструментов; недавний обрыв помнится две минуты', () => {
    const idle: LocalActivity = {
      phase: 'idle',
      inFlight: 0,
      lastStall: { at: NOW - 1_000, seconds: 120 },
    };
    expect(localRunView(idle, false, NOW)).toMatchObject({
      stage: { key: 'idle' },
      stalled: { seconds: 120 },
    });
    expect(localRunView(idle, false, NOW + STALL_MEMORY_MS).stalled).toBeUndefined();
  });

  it('отказ сервера в этом ходе — этап «отказ» с кодом и текстом, а не «выполняет инструменты»', () => {
    const since = NOW - 60_000;
    const failedIdle: LocalActivity = {
      phase: 'idle',
      inFlight: 0,
      lastRequestAt: NOW - 5_000,
      lastError: { at: NOW - 4_000, status: 500, message: 'Jinja Exception: boom' },
    };
    expect(localRunView(failedIdle, false, NOW, since)).toMatchObject({
      stage: { key: 'failed' },
      failed: { status: 500, message: 'Jinja Exception: boom' },
    });
    // Клиент повторяет: запрос снова в пути — этап сервера, отказ строкой рядом.
    const retry = localRunView({ ...base, lastError: failedIdle.lastError }, false, NOW, since);
    expect(retry.stage.key).toBe('prompt');
    expect(retry.failed?.status).toBe(500);
    // Отказ прошлого хода к этому не относится.
    const old = { ...failedIdle, lastError: { at: since - 1, status: 500, message: 'x' } };
    expect(localRunView(old, false, NOW, since).failed).toBeUndefined();
    expect(localRunView(old, false, NOW, since).stage.key).toBe('idle');
  });

  it('ход начался, а запроса к модели ещё не было — «готовит запрос», а не «инструменты»', () => {
    const since = NOW - 3_000;
    const fresh: LocalActivity = { phase: 'idle', inFlight: 0, lastRequestAt: since - 60_000 };
    expect(localRunView(fresh, false, NOW, since).stage.key).toBe('preparing');
    expect(localRunView({ phase: 'idle', inFlight: 0 }, false, NOW, since).stage.key).toBe(
      'preparing',
    );
    expect(
      localRunView({ ...fresh, lastRequestAt: since + 1_000 }, false, NOW, since).stage.key,
    ).toBe('idle');
    // Без начала хода судить не о чем — прежнее «idle».
    expect(localRunView(fresh, false, NOW).stage.key).toBe('idle');
  });

  it('генерация — токены ответа', () => {
    expect(localRunView({ ...base, phase: 'generating', decoded: 345 }, false, NOW).stage).toEqual({
      key: 'generating',
      decoded: 345,
    });
  });
});
