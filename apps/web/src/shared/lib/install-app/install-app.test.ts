import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Модуль слушает `beforeinstallprompt` с первого импорта, поэтому каждый тест
 * подкладывает своё окно и импортирует модуль заново: среда тестов — node, окна
 * в ней нет.
 */
type Fake = EventTarget & { matchMedia: (query: string) => { matches: boolean } };

let standalone = false;
let fake: Fake;

function installPrompt(outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.prompt = vi.fn(async () => {});
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

async function load() {
  vi.resetModules();
  return import('./install-app');
}

beforeEach(() => {
  standalone = false;
  fake = Object.assign(new EventTarget(), {
    matchMedia: () => ({ matches: standalone }),
  });
  vi.stubGlobal('window', fake);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('установка панели как приложения', () => {
  it('без предложения браузера — недоступно, кнопки нет', async () => {
    const app = await load();
    expect(app.installAppState()).toBe('unavailable');
    expect(await app.promptInstall()).toBe(false);
  });

  it('предложение браузера пойманное заранее — доступно; после prompt событие израсходовано', async () => {
    const app = await load();
    const event = installPrompt('accepted');
    fake.dispatchEvent(event);
    // Своя плашка браузера подавлена: установка — только по кнопке.
    expect(event.defaultPrevented).toBe(true);
    expect(app.installAppState()).toBe('available');

    expect(await app.promptInstall()).toBe(true);
    expect(event.prompt).toHaveBeenCalledTimes(1);
    // Второй prompt() браузер отклонил бы — кнопка уходит сразу.
    expect(app.installAppState()).toBe('unavailable');
    expect(await app.promptInstall()).toBe(false);
  });

  it('отказ в диалоге — false', async () => {
    const app = await load();
    fake.dispatchEvent(installPrompt('dismissed'));
    expect(await app.promptInstall()).toBe(false);
  });

  it('открыта в своём окне или только что установлена — «установлено»', async () => {
    standalone = true;
    const app = await load();
    expect(app.installAppState()).toBe('installed');

    standalone = false;
    const fresh = await load();
    fake.dispatchEvent(installPrompt('accepted'));
    fake.dispatchEvent(new Event('appinstalled'));
    expect(fresh.installAppState()).toBe('installed');
  });
});
