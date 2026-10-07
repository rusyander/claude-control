import { describe, expect, it } from 'vitest';
import type { ProviderChatStatus } from '@agentdeck/contracts';
import {
  backgroundSignal,
  canWrite,
  editsState,
  notificationTarget,
  sendMode,
  watchInBackground,
} from './model';

const status = (patch: Partial<ProviderChatStatus>): ProviderChatStatus => ({
  chatId: 'c1',
  isRunning: false,
  partial: '',
  ...patch,
});

describe('notificationTarget', () => {
  it('ключ с приставкой CLI — разговор этого CLI', () => {
    expect(
      notificationTarget({ kind: 'done', chatId: 'codex:c1a2', projectPath: 'C:\\p' }),
    ).toEqual({
      kind: 'foreign',
      providerId: 'codex',
      chatId: 'c1a2',
    });
  });

  it('сессия Claude — его чат с проектом', () => {
    expect(
      notificationTarget({ kind: 'permission', chatId: '0f1e-uuid', projectPath: '/repo' }),
    ).toEqual({ kind: 'claude', chatId: '0f1e-uuid', projectPath: '/repo' });
  });

  it('проверочное уведомление, пустой и чужой ключ — никуда', () => {
    expect(notificationTarget({ kind: 'test', chatId: '' })).toBeUndefined();
    expect(notificationTarget({ kind: 'done' })).toBeUndefined();
    expect(notificationTarget('codex:c1')).toBeUndefined();
    expect(notificationTarget(null)).toBeUndefined();
    // `claude:` — не адрес: у Claude разговор без приставки.
    expect(notificationTarget({ chatId: 'claude:abc' })).toBeUndefined();
  });
});

describe('sendMode', () => {
  it('ответа нет — обычный вопрос', () => {
    expect(sendMode(undefined)).toBe('send');
    expect(sendMode(status({}))).toBe('send');
  });

  it('ход идёт и принимает слово — посреди ответа, иначе очередь', () => {
    expect(sendMode(status({ isRunning: true, steerable: true }))).toBe('steer');
    expect(sendMode(status({ isRunning: true }))).toBe('queue');
  });
});

describe('canWrite', () => {
  it('писать — только в разговор активного CLI', () => {
    expect(canWrite('codex', 'codex')).toBe(true);
    expect(canWrite('qwen', 'codex')).toBe(false);
    expect(canWrite(undefined, 'codex')).toBe(false);
  });
});

describe('backgroundSignal', () => {
  const ask = { id: 'a1', at: '2026-10-06T10:00:00Z' };

  it('ход кончился — «готово»; новая просьба о разрешении — «разрешение»', () => {
    expect(backgroundSignal(status({ isRunning: true }), status({}))).toBe('finished');
    expect(
      backgroundSignal(
        status({ isRunning: true }),
        status({ isRunning: true, permissions: [ask] }),
      ),
    ).toBe('permission');
  });

  it('первый опрос, тишина и уже известная просьба — молчим', () => {
    expect(backgroundSignal(undefined, status({}))).toBeUndefined();
    expect(backgroundSignal(status({}), status({}))).toBeUndefined();
    expect(
      backgroundSignal(
        status({ isRunning: true, permissions: [ask] }),
        status({ isRunning: true, permissions: [ask] }),
      ),
    ).toBeUndefined();
  });
});

describe('watchInBackground', () => {
  const ask = { id: 'a1', at: '2026-10-06T10:00:00Z' };
  const scripted = (...answers: ProviderChatStatus[]) => {
    const calls: number[] = [];
    let index = 0;
    return {
      calls,
      fetchStatus: () => {
        calls.push(index);
        return Promise.resolve(answers[Math.min(index++, answers.length - 1)]);
      },
    };
  };
  // Длинный опрос «держит» ответ: часы сдвигаются на 5 с за каждый запрос.
  const clock = () => {
    let t = 0;
    return () => (t += 5_000);
  };

  it('ход идёт — ждёт сервер и говорит «готово» один раз, потом выходит', async () => {
    const server = scripted(status({ isRunning: true }), status({}));
    const signals: string[] = [];
    await watchInBackground({
      initial: status({ isRunning: true }),
      fetchStatus: server.fetchStatus,
      stillAway: () => true,
      onSignal: (signal) => signals.push(signal),
      now: clock(),
    });
    expect(signals).toEqual(['finished']);
    expect(server.calls).toHaveLength(2);
  });

  it('просьба о разрешении — сигнал, и слежка ждёт дальше до конца хода', async () => {
    const server = scripted(status({ isRunning: true, permissions: [ask] }), status({}));
    const signals: string[] = [];
    await watchInBackground({
      initial: status({ isRunning: true }),
      fetchStatus: server.fetchStatus,
      stillAway: () => true,
      onSignal: (signal) => signals.push(signal),
      now: clock(),
    });
    expect(signals).toEqual(['permission', 'finished']);
  });

  it('хода нет, приложение вернулось, связь пропала — ни одного лишнего запроса', async () => {
    const idle = scripted(status({}));
    await watchInBackground({
      initial: status({}),
      fetchStatus: idle.fetchStatus,
      stillAway: () => true,
      onSignal: () => undefined,
    });
    expect(idle.calls).toHaveLength(0);

    const back = scripted(status({ isRunning: true }));
    await watchInBackground({
      initial: status({ isRunning: true }),
      fetchStatus: back.fetchStatus,
      stillAway: () => false,
      onSignal: () => undefined,
    });
    expect(back.calls).toHaveLength(0);

    let asked = 0;
    await watchInBackground({
      initial: status({ isRunning: true }),
      fetchStatus: () => {
        asked += 1;
        return Promise.reject(new Error('offline'));
      },
      stillAway: () => true,
      onSignal: () => undefined,
    });
    expect(asked).toBe(1);
  });

  it('кэш устарел («хода нет», а ход уже идёт) — одно перечтение, и слежка идёт', async () => {
    const server = scripted(status({}));
    let fresh = 0;
    const signals: string[] = [];
    await watchInBackground({
      initial: status({}),
      fetchNow: () => {
        fresh += 1;
        return Promise.resolve(status({ isRunning: true }));
      },
      fetchStatus: server.fetchStatus,
      stillAway: () => true,
      onSignal: (signal) => signals.push(signal),
      now: clock(),
    });
    expect(fresh).toBe(1);
    expect(signals).toEqual(['finished']);
  });

  it('кэш «хода нет» и перечтение подтверждает тишину — длинного опроса нет', async () => {
    const server = scripted(status({}));
    let fresh = 0;
    await watchInBackground({
      initial: status({}),
      fetchNow: () => {
        fresh += 1;
        return Promise.resolve(status({}));
      },
      fetchStatus: server.fetchStatus,
      stillAway: () => true,
      onSignal: () => undefined,
    });
    expect(fresh).toBe(1);
    expect(server.calls).toHaveLength(0);
  });

  it('сервер без длинного опроса отвечает сразу — между запросами пауза', async () => {
    const server = scripted(status({ isRunning: true }), status({ isRunning: true }), status({}));
    const pauses: number[] = [];
    await watchInBackground({
      initial: status({ isRunning: true }),
      fetchStatus: server.fetchStatus,
      stillAway: () => true,
      onSignal: () => undefined,
      now: () => 0,
      pause: (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      },
    });
    expect(pauses).toEqual([1000, 1000]);
  });
});

describe('editsState', () => {
  it('нет смысла выключенного — переключатель до CLI не доходит, решает сам CLI', () => {
    expect(editsState({}, true)).toBe('cli');
    expect(editsState(undefined, false)).toBe('cli');
  });

  it('включено — без вопроса; выключено — карточка у живого сервера, иначе запись закрыта', () => {
    expect(editsState({ editsWhenOff: 'ask' }, true)).toBe('allowed');
    expect(editsState({ editsWhenOff: 'deny' }, true)).toBe('allowed');
    expect(editsState({ editsWhenOff: 'ask' }, false)).toBe('ask');
    expect(editsState({ editsWhenOff: 'deny' }, undefined)).toBe('denied');
  });
});
