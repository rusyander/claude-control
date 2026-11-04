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
    const view = localRunView(base, false, NOW - 10_000);
    expect(view.server).toEqual({
      model: 'qwen3.6:27b-coding',
      quant: 'UD-Q4_K_XL',
      context: 131_072,
    });
    expect(view.stage).toEqual({ key: 'idle' });
    expect(view.failed).toBeUndefined();
  });

  it('сервер неизвестен — строки сервера нет', () => {
    expect(localRunView({}, false).server).toBeUndefined();
    expect(localRunView(undefined, false).server).toBeUndefined();
  });

  it('ждущее разрешение важнее отказа; отказ рядом строкой', () => {
    const refused: LocalActivity = {
      ...base,
      lastError: { at: NOW - 1_000, status: 500, message: 'boom' },
    };
    expect(localRunView(refused, true, NOW - 10_000)).toMatchObject({
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
    expect(localRunView(failedIdle, false, since)).toMatchObject({
      stage: { key: 'failed' },
      failed: { status: 500, message: 'Jinja Exception: boom' },
    });
    // Отказ прошлого хода к этому не относится.
    const old = { ...failedIdle, lastError: { at: since - 1, status: 500, message: 'x' } };
    expect(localRunView(old, false, since).failed).toBeUndefined();
    expect(localRunView(old, false, since).stage.key).toBe('idle');
  });

  it('ход начался, а запроса к модели ещё не было — «готовит запрос», а не «инструменты»', () => {
    const since = NOW - 3_000;
    const fresh: LocalActivity = { lastRequestAt: since - 60_000 };
    expect(localRunView(fresh, false, since).stage.key).toBe('preparing');
    expect(localRunView({}, false, since).stage.key).toBe('preparing');
    expect(localRunView({ ...fresh, lastRequestAt: since + 1_000 }, false, since).stage.key).toBe(
      'idle',
    );
    // Без начала хода судить не о чем — прежнее «idle»; без снимка — тоже.
    expect(localRunView(fresh, false).stage.key).toBe('idle');
    expect(localRunView(undefined, false, since).stage.key).toBe('idle');
  });
});
