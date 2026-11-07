import { describe, expect, it } from 'vitest';
import type { LocalActivity } from '@agentdeck/contracts/local-models';
import { localRunView } from './localRunView';

const NOW = 1_800_000_000_000;
const base: LocalActivity = {
  model: 'qwen3.6:27b-coding',
  quant: 'UD-Q4_K_XL',
  context: 131_072,
  lastRequestAt: NOW - 2_000,
};

describe('строка состояния локальной модели (L6)', () => {
  it('сервер — модель, квантование, окно; запрос этого хода прошёл — «idle»', () => {
    const view = localRunView(base, false, NOW, NOW - 10_000);
    expect(view.server).toEqual({
      model: 'qwen3.6:27b-coding',
      quant: 'UD-Q4_K_XL',
      context: 131_072,
    });
    expect(view.stage).toEqual({ key: 'idle' });
    expect(view.failed).toBeUndefined();
  });

  it('сервер неизвестен — строки сервера нет', () => {
    expect(localRunView({}, false, NOW).server).toBeUndefined();
    expect(localRunView(undefined, false, NOW).server).toBeUndefined();
  });

  it('ждущее разрешение важнее отказа; отказ рядом строкой', () => {
    const refused: LocalActivity = {
      ...base,
      lastError: { at: NOW - 1_000, status: 500, message: 'boom' },
    };
    expect(localRunView(refused, true, NOW, NOW - 10_000)).toMatchObject({
      stage: { key: 'permission' },
      failed: { status: 500, message: 'boom' },
    });
  });

  it('отказ сервера в этом ходе — этап «отказ» с кодом и текстом, а не «выполняет инструменты»', () => {
    const since = NOW - 60_000;
    const failedIdle: LocalActivity = {
      lastRequestAt: NOW - 5_000,
      lastError: { at: NOW - 4_000, status: 500, message: 'Jinja Exception: boom' },
    };
    expect(localRunView(failedIdle, false, NOW, since)).toMatchObject({
      stage: { key: 'failed' },
      failed: { status: 500, message: 'Jinja Exception: boom' },
    });
    // Отказ прошлого хода к этому не относится.
    const old = { ...failedIdle, lastError: { at: since - 1, status: 500, message: 'x' } };
    expect(localRunView(old, false, NOW, since).failed).toBeUndefined();
    expect(localRunView(old, false, NOW, since).stage.key).toBe('idle');
  });

  it('ход начался, а запроса к модели ещё не было — «готовит запрос», а не «инструменты»', () => {
    const since = NOW - 3_000;
    const fresh: LocalActivity = { lastRequestAt: since - 60_000 };
    expect(localRunView(fresh, false, NOW, since).stage.key).toBe('preparing');
    expect(localRunView({}, false, NOW, since).stage.key).toBe('preparing');
    expect(
      localRunView({ ...fresh, lastRequestAt: since + 1_000 }, false, NOW, since).stage.key,
    ).toBe('idle');
    // Без начала хода судить не о чем — прежнее «idle»; без снимка — тоже.
    expect(localRunView(fresh, false, NOW).stage.key).toBe('idle');
    expect(localRunView(undefined, false, NOW, since).stage.key).toBe('idle');
  });
});

describe('этапы хода по ленте звена ядра (этап 11, W2-5)', () => {
  const flying = (over: Partial<LocalActivity>): LocalActivity => ({
    ...base,
    inFlight: 1,
    startedAt: NOW - 30_000,
    lastMoveAt: NOW - 1_000,
    stalled: false,
    stallMs: 120_000,
    ...over,
  });

  it('загрузка, подъём и очередь — каждый своим этапом', () => {
    expect(localRunView(flying({ phase: 'starting' }), false, NOW).stage).toEqual({
      key: 'starting',
    });
    expect(localRunView(flying({ phase: 'loading' }), false, NOW).stage).toEqual({
      key: 'loading',
    });
    expect(localRunView(flying({ phase: 'queued' }), false, NOW).stage).toEqual({
      key: 'queued',
    });
  });

  it('разбор промпта: прочитано из всего и доля; подсчёт меньше прочитанного — без «из»', () => {
    const prompt = flying({ phase: 'prompt', prompt: { filled: 2048, total: 4096 }, decoded: 0 });
    expect(localRunView(prompt, false, NOW).stage).toEqual({
      key: 'prompt',
      filled: 2048,
      total: 4096,
      share: 0.5,
    });
    const wrong = flying({ phase: 'prompt', prompt: { filled: 3000, total: 100 } });
    expect(localRunView(wrong, false, NOW).stage).toEqual({ key: 'prompt', filled: 3000 });
  });

  it('ответ: сколько токенов написано', () => {
    const generating = flying({ phase: 'generating', decoded: 120 });
    expect(localRunView(generating, false, NOW).stage).toEqual({
      key: 'generating',
      decoded: 120,
    });
  });

  it('тишина дольше 20 с — «молчит» с остатком до застоя; загрузка тишиной не считается', () => {
    const quiet = flying({ phase: 'prompt', prompt: { filled: 10 }, lastMoveAt: NOW - 45_000 });
    expect(localRunView(quiet, false, NOW).silent).toEqual({ seconds: 45, left: 75 });
    const loading = flying({ phase: 'loading', lastMoveAt: NOW - 45_000 });
    expect(localRunView(loading, false, NOW).silent).toBeUndefined();
    expect(localRunView(flying({ phase: 'prompt' }), false, NOW).silent).toBeUndefined();
  });

  it('застой — «движения нет», вместо «молчит»', () => {
    const stuck = flying({ phase: 'prompt', lastMoveAt: NOW - 130_000, stalled: true });
    const view = localRunView(stuck, false, NOW);
    expect(view.stalled).toEqual({ seconds: 130 });
    expect(view.silent).toBeUndefined();
    // Флаг застоя у загрузки — не застой: модель грузится законно долго.
    const loading = flying({ phase: 'loading', lastMoveAt: NOW - 130_000, stalled: true });
    expect(localRunView(loading, false, NOW)).toMatchObject({ stage: { key: 'loading' } });
    expect(localRunView(loading, false, NOW).stalled).toBeUndefined();
  });

  it('этап idle или ничего в полёте — прежние правила отказа и подготовки', () => {
    const done = flying({ phase: 'idle', inFlight: 0 });
    expect(localRunView(done, false, NOW, NOW - 10_000).stage.key).toBe('idle');
    // Этап без запроса в полёте (запрос закрылся между опросами) — ход не идёт.
    const closed = flying({ phase: 'generating', decoded: 5, inFlight: 0 });
    expect(localRunView(closed, false, NOW, NOW - 10_000).stage.key).toBe('idle');
    const permission = flying({ phase: 'prompt', prompt: { filled: 1 } });
    expect(localRunView(permission, true, NOW).stage.key).toBe('permission');
  });
});
