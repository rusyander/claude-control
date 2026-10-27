import { describe, expect, it, vi } from 'vitest';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { createWatchPause, type WatchPauseDeps } from './watch-pause.ts';

/**
 * Безопасная точка паузы сторожа (F1): что решает обёртка, которую спрашивают оба
 * планировщика. Сигналы — в том виде, как их хранит сторож; конвейер — граница
 * (`pause`), его собственная проверка — в `split-conveyor.watch-pause.test.ts`.
 */

const LINK: ChatLink = { parentChatId: 'родитель', groupIndex: 0, createdAt: '' };
const R4 = {
  signals: [
    {
      id: 'R4-1',
      rule: 'R4',
      severity: 'warn',
      groupIndex: 0,
      chatId: 'chat-0',
      at: '2026-10-27T10:00:00.000Z',
      numbers: { repeats: 3 },
      textKey: 'groupWatch.rule.R4',
    },
  ],
};

function deps(extra: Partial<WatchPauseDeps> = {}) {
  const pause = vi.fn<WatchPauseDeps['pause']>().mockReturnValue(true);
  const log = vi.fn();
  const all: WatchPauseDeps = {
    settings: () => ({ enabled: true, autoPause: true }),
    signals: () => R4,
    humanWaits: () => false,
    pause,
    log,
    ...extra,
  };
  return { all, pause, log };
}

describe('createWatchPause: пауза на конце хода звена', () => {
  it('горит R4 — пауза конвейера с этим правилом', () => {
    const { all, pause } = deps();
    expect(createWatchPause(all)(LINK)).toBe(true);
    expect(pause).toHaveBeenCalledWith(LINK, 'R4');
  });

  it('пауза сторожа выключена — ни сигналы, ни конвейер не читаются', () => {
    // Спрашивают на конце КАЖДОГО хода звена: выключенный рычаг не должен стоить чтения записи.
    const signals = vi.fn(() => R4);
    const { all, pause } = deps({
      settings: () => ({ enabled: true, autoPause: false }),
      signals,
    });
    expect(createWatchPause(all)(LINK)).toBe(false);
    expect(signals).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it('связь не группы (нет родителя или номера) — нет', () => {
    const { all, pause } = deps();
    const pauser = createWatchPause(all);
    expect(pauser({ ...LINK, parentChatId: '' })).toBe(false);
    expect(pauser({ parentChatId: 'родитель', createdAt: '' })).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });

  it('группа ждёт решения D-n — паузы нет: человеку и так есть что решить', () => {
    const { all, pause } = deps({ humanWaits: () => true });
    expect(createWatchPause(all)(LINK)).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });

  it('сигналов нет или конвейер отказал — звено заводится', () => {
    expect(createWatchPause(deps({ signals: () => undefined }).all)(LINK)).toBe(false);
    const refused = deps();
    refused.pause.mockReturnValue(false);
    expect(createWatchPause(refused.all)(LINK)).toBe(false);
  });

  it('сбой чтения не роняет конец хода — false и строка в журнал', () => {
    const { all, log } = deps({
      signals: () => {
        throw new Error('битый файл');
      },
    });
    expect(createWatchPause(all)(LINK)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
