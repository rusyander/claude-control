import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from './instance';
import { serverFieldText } from './serverFieldText';
import { serverMessageFromPayload } from './serverMessageFromPayload';

/**
 * Причины, которые сервер после переезда защиты данных и звеньев контура в ядро пишет по коду
 * (core-s10 G12): тела ниже — ровно те, что отдают маршруты в серверных тестах
 * (`dlp-routes.integration`, `images.test`, `provider-permissions.kimi.test`). Карточка защиты
 * данных и страница прав Kimi зовут `serverFieldText`, отказ картинки — общий разбор тела ошибки.
 */
describe('коды причин ядра на языке интерфейса', () => {
  afterEach(async () => {
    await i18n.changeLanguage('ru');
  });

  /** Карточка «Защита данных»: ядра нет — причина ядра вложена кодом. */
  const dlpStatus = {
    running: false,
    address: 'http://127.0.0.1:5179',
    upstream: '',
    error:
      'Защиту данных держит ядро, а оно не отвечает: ядро не найдено (no loopback core in procs.json)',
    messageCode: 'dlp-core-down',
    params: {
      reason: {
        messageCode: 'dlp-core-missing',
        params: { reason: 'no loopback core in procs.json' },
      },
    },
    requests: 0,
    masked: 0,
    blocked: 0,
  };

  it('карточка защиты данных: русский и английский текст причины', async () => {
    await i18n.changeLanguage('ru');
    expect(serverFieldText(dlpStatus, 'error')).toBe(
      'Защиту данных держит ядро, а оно не отвечает: ядро не найдено (no loopback core in procs.json)',
    );
    await i18n.changeLanguage('en');
    expect(serverFieldText(dlpStatus, 'error')).toBe(
      'Data protection is held by the core, and it does not answer: the core was not found (no loopback core in procs.json)',
    );
  });

  it('порт у ядра занят: отказ запуска 409', async () => {
    const refusal = {
      error: 'dlp_start_failed',
      message: 'порт 5179 занят (нет ответа слушателя)',
      messageCode: 'dlp-core-port-busy',
      params: { port: 5179, reason: { messageCode: 'dlp-core-listener-silent' } },
    };
    await i18n.changeLanguage('en');
    expect(serverMessageFromPayload(refusal)).toBe(
      'port 5179 is busy (no answer from the listener)',
    );
    await i18n.changeLanguage('ru');
    expect(serverMessageFromPayload(refusal)).toBe('порт 5179 занят (нет ответа слушателя)');
  });

  it('отказ картинки: дороги нет, ядра нет, звено не дало адрес, потолок ожидания', async () => {
    const blocked = {
      message: 'x',
      messageCode: 'media-image-blocked-no-route',
      reason: 'no-route',
    };
    const noCore = { message: 'x', messageCode: 'media-core-not-connected' };
    const link = {
      message: 'x',
      messageCode: 'media-contour-link-failed',
      params: {
        contour: 'Company · dev',
        reason: { messageCode: 'core-link-missing', params: { reason: 'token: empty' } },
      },
    };
    const timeout = {
      message: 'x',
      messageCode: 'media-upstream-timeout-image',
      params: { seconds: 120 },
    };

    await i18n.changeLanguage('ru');
    expect(serverMessageFromPayload(blocked)).toBe(
      'Рисовать некому: ни активного контура, ни своего эндпоинта.',
    );
    expect(serverMessageFromPayload(noCore)).toBe(
      'Запрос в контур идёт через звено ядра, а ядро панели не подключено.',
    );
    expect(serverMessageFromPayload(link)).toBe(
      'Звено ядра не дало адрес контура «Company · dev»: Ядро не найдено: token: empty',
    );
    expect(serverMessageFromPayload(timeout)).toBe(
      'Картинка не пришла за 120 с — панель не ждёт дольше',
    );

    await i18n.changeLanguage('en');
    expect(serverMessageFromPayload(blocked)).toBe(
      'Nobody to draw: no active contour and no endpoint of your own.',
    );
    expect(serverMessageFromPayload(noCore)).toBe(
      "The request to the contour goes through a core hop, and the panel's core is not connected.",
    );
    expect(serverMessageFromPayload(link)).toBe(
      'The core hop gave no address for contour «Company · dev»: The core was not found: token: empty',
    );
    expect(serverMessageFromPayload(timeout)).toBe(
      'The image did not arrive within 120 s — the panel does not wait longer',
    );
  });

  it('права Kimi: значение режима вне набора названо на языке интерфейса', async () => {
    const info = {
      error: 'x',
      messageCode: 'kimi-mode-stale',
      params: { key: 'default_permission_mode', mode: 'plan', allowed: 'manual, auto, yolo' },
    };
    await i18n.changeLanguage('en');
    expect(serverFieldText(info, 'error')).toBe(
      'Kimi Code does not accept default_permission_mode = "plan" (allowed: manual, auto, yolo) and silently drops it at launch, running in manual. The section is read-only: fix the value in the file (kimi doctor config shows the error), and editing opens again.',
    );
    await i18n.changeLanguage('ru');
    expect(serverFieldText(info, 'error')).toMatch(
      /^default_permission_mode = "plan" Kimi Code не принимает \(допустимо: manual, auto, yolo\)/,
    );
  });
});
