import { describe, expect, it, vi } from 'vitest';
import { composeGroupSignal, createGroupSignalTelegram } from './telegram.ts';

describe('composeGroupSignal — строка сигнала сторожа в Telegram', () => {
  it('правило, числа словами, стадия по-русски и проект', () => {
    expect(
      composeGroupSignal({
        rule: 'R4',
        severity: 'warn',
        numbers: { runs: 3 },
        stage: 'work',
        projectPath: '/work/my-app',
      }),
    ).toBe('⚠️ R4 одна проверка по кругу (запусков без правки: 3; стадия «работа») — my-app');
  });

  it('тревога, неизвестный ключ числа и чужая стадия — как есть', () => {
    expect(
      composeGroupSignal({
        rule: 'R1',
        severity: 'alert',
        numbers: { idleMin: 21, extra: 2 },
        stage: 'custom',
      }),
    ).toBe('⛔ R1 группа молчит (без событий 21 мин, extra 2; стадия «custom»)');
  });

  it('правило без названия и без чисел — только значок и код', () => {
    expect(composeGroupSignal({ rule: 'R12', severity: 'info', numbers: {} })).toBe('ℹ️ R12');
  });
});

describe('createGroupSignalTelegram', () => {
  it('молчит без включённой настройки, чата или токена; сбой отправки — в onError', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const onError = vi.fn();
      const notice = { rule: 'R1' as const, severity: 'alert' as const, numbers: { idleMin: 21 } };
      createGroupSignalTelegram({
        settings: () => ({ enabled: false, chatId: '1' }) as never,
        token: () => 't',
        onError,
      })(notice);
      createGroupSignalTelegram({
        settings: () => ({ enabled: true, chatId: '' }) as never,
        token: () => 't',
        onError,
      })(notice);
      createGroupSignalTelegram({
        settings: () => ({ enabled: true, chatId: '1' }) as never,
        token: () => undefined,
        onError,
      })(notice);
      expect(fetchMock).not.toHaveBeenCalled();
      createGroupSignalTelegram({
        settings: () => ({ enabled: true, chatId: '1' }) as never,
        token: () => 't',
        onError,
      })(notice);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
