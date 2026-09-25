import { describe, it, expect, afterEach, vi } from 'vitest';
import { askNotifyPermissionOnGesture, showSystemNotice } from './systemNotify';

/**
 * Системное уведомление скрытой вкладки (находка 77 живого прогона 24.09).
 * Браузер подменён только на границе: класс `Notification`, `document` как
 * настоящий `EventTarget` с видимостью, `localStorage` и `window.focus`.
 */

interface Shown {
  title: string;
  options?: NotificationOptions;
  onclick: (() => void) | null;
  closed: boolean;
}

function fakeNotification(permission: NotificationPermission) {
  const shown: Shown[] = [];
  const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    onclick: (() => void) | null = null;
    closed = false;
    constructor(
      public title: string,
      public options?: NotificationOptions,
    ) {
      shown.push(this as unknown as Shown);
    }
    close(): void {
      this.closed = true;
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  return { shown, requestPermission };
}

function fakeDocument(visibilityState: 'hidden' | 'visible') {
  const doc = Object.assign(new EventTarget(), { visibilityState });
  vi.stubGlobal('document', doc);
  return doc;
}

function fakeStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  return store;
}

const notice = { title: 'AgentDeck', body: 'Проект «x»: агент ждёт ответа', tag: 'run-1' };

describe('showSystemNotice — зовёт только скрытую вкладку и только с разрешением', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('скрытая вкладка с разрешением — уведомление с текстом и тегом прогона', () => {
    const { shown } = fakeNotification('granted');
    fakeDocument('hidden');

    expect(showSystemNotice(notice)).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe('AgentDeck');
    expect(shown[0]?.options).toEqual({ body: notice.body, tag: 'run-1' });
  });

  it('видимая вкладка — не зовёт: там уже тост', () => {
    const { shown } = fakeNotification('granted');
    fakeDocument('visible');

    expect(showSystemNotice(notice)).toBe(false);
    expect(shown).toHaveLength(0);
  });

  it('без разрешения — не зовёт', () => {
    for (const permission of ['default', 'denied'] as const) {
      const { shown } = fakeNotification(permission);
      fakeDocument('hidden');
      expect(showSystemNotice(notice)).toBe(false);
      expect(shown).toHaveLength(0);
    }
  });

  it('браузер без уведомлений — молча нет', () => {
    fakeDocument('hidden');
    vi.stubGlobal('Notification', undefined);
    expect(showSystemNotice(notice)).toBe(false);
  });

  it('клик поднимает вкладку, ведёт в разговор и закрывает уведомление', () => {
    const { shown } = fakeNotification('granted');
    fakeDocument('hidden');
    const focus = vi.fn();
    vi.stubGlobal('window', { focus });
    const onClick = vi.fn();

    showSystemNotice({ ...notice, onClick });
    shown[0]?.onclick?.();

    expect(focus).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(shown[0]?.closed).toBe(true);
  });
});

describe('askNotifyPermissionOnGesture — один раз и только по жесту', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('на загрузке не спрашивает; первый клик спрашивает, второй — уже нет', () => {
    const { requestPermission } = fakeNotification('default');
    const doc = fakeDocument('visible');
    fakeStorage();

    const stop = askNotifyPermissionOnGesture();
    expect(requestPermission).not.toHaveBeenCalled();

    doc.dispatchEvent(new Event('pointerdown'));
    doc.dispatchEvent(new Event('keydown'));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    stop();
  });

  it('клавиша — тоже жест', () => {
    const { requestPermission } = fakeNotification('default');
    const doc = fakeDocument('visible');
    fakeStorage();

    askNotifyPermissionOnGesture();
    doc.dispatchEvent(new Event('keydown'));

    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('уже спрошено в прошлый раз (отклонили крестиком) — не спрашивает снова', () => {
    const { requestPermission } = fakeNotification('default');
    const doc = fakeDocument('visible');
    fakeStorage();

    askNotifyPermissionOnGesture();
    doc.dispatchEvent(new Event('pointerdown'));
    askNotifyPermissionOnGesture();
    doc.dispatchEvent(new Event('pointerdown'));

    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('спрошено в прошлой сессии — жесты даже не слушает', () => {
    const { requestPermission } = fakeNotification('default');
    const doc = fakeDocument('visible');
    fakeStorage().set('agentdeck:notify-permission-asked', '1');
    const listen = vi.spyOn(doc, 'addEventListener');

    askNotifyPermissionOnGesture();
    doc.dispatchEvent(new Event('pointerdown'));

    expect(listen).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('разрешение уже решено — не спрашивает вовсе', () => {
    for (const permission of ['granted', 'denied'] as const) {
      const { requestPermission } = fakeNotification(permission);
      const doc = fakeDocument('visible');
      fakeStorage();
      askNotifyPermissionOnGesture();
      doc.dispatchEvent(new Event('pointerdown'));
      expect(requestPermission).not.toHaveBeenCalled();
    }
  });

  it('снятая подписка не спрашивает', () => {
    const { requestPermission } = fakeNotification('default');
    const doc = fakeDocument('visible');
    fakeStorage();

    askNotifyPermissionOnGesture()();
    doc.dispatchEvent(new Event('pointerdown'));

    expect(requestPermission).not.toHaveBeenCalled();
  });
});
