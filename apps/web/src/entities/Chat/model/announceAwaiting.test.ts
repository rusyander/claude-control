import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatSummary } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { clearToasts, getToasts } from '@shared/lib/toast';
import { announceAwaiting } from './announceAwaiting';

/**
 * Находка 77 живого прогона 24.09: группа разделения спросила человека, пока он
 * сидел в другой вкладке, — ни звука, ни уведомления. Браузер подменён только
 * на границе: класс `Notification` и `document` с видимостью; тосты — настоящий
 * стор.
 */

interface Shown {
  title: string;
  options?: NotificationOptions;
  onclick: (() => void) | null;
}

function fakeNotification(): Shown[] {
  const shown: Shown[] = [];
  class FakeNotification {
    static permission: NotificationPermission = 'granted';
    onclick: (() => void) | null = null;
    constructor(
      public title: string,
      public options?: NotificationOptions,
    ) {
      shown.push(this as unknown as Shown);
    }
    close(): void {}
  }
  vi.stubGlobal('Notification', FakeNotification);
  return shown;
}

function chat(id: string, projectPath: string): ChatSummary {
  return {
    id,
    title: id,
    project: 'proj',
    projectPath,
    isSandbox: false,
    messageCount: 2,
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:05.000Z',
  };
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('announceAwaiting — вопрос группы зовёт и скрытую вкладку', () => {
  it('скрытая вкладка: уведомление системы по каждому чату, клик ведёт в проект', () => {
    const shown = fakeNotification();
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    vi.stubGlobal('window', { focus: vi.fn() });
    const reveal = vi.fn();

    announceAwaiting([chat('g1', 'C:/work/app-g1'), chat('g2', 'C:/work/app-g2')], {
      t: i18n.t,
      reveal,
    });

    expect(shown.map((item) => item.options?.tag)).toEqual(['awaiting:g1', 'awaiting:g2']);
    expect(shown[0]?.title).toBe('AgentDeck');
    expect(shown[0]?.options?.body).toContain('app-g1');
    shown[1]?.onclick?.();
    expect(reveal).toHaveBeenCalledWith('C:/work/app-g2', 'app-g2');
    expect(getToasts()).toHaveLength(2);
  });

  it('видимая вкладка: только тост, уведомление системы — лишний второй сигнал', () => {
    const shown = fakeNotification();
    vi.stubGlobal('document', { visibilityState: 'visible' });

    announceAwaiting([chat('g1', 'C:/work/app-g1')], { t: i18n.t, reveal: vi.fn() });

    expect(shown).toEqual([]);
    expect(getToasts().map((item) => item.message)).toEqual([
      i18n.t('projects.notifyWaiting', { name: 'app-g1' }),
    ]);
  });
});
