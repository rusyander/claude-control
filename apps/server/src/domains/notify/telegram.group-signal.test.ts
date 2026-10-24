import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelegramSettings, WebhookSettings } from '@agentdeck/contracts';
import {
  compose,
  composeGroupSignal,
  createTelegramNotifier,
  noticeEvent,
  telegramApiBase,
  type GroupSignalNotice,
} from './telegram.ts';
import { composeWebhook, createWebhookNotifier } from './webhook.ts';

describe('composeGroupSignal — строка сигнала сторожа в Telegram', () => {
  it('правило, числа словами, стадия по-русски и проект', () => {
    expect(
      composeGroupSignal({
        kind: 'groupSignal',
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
        kind: 'groupSignal',
        rule: 'R1',
        severity: 'alert',
        numbers: { idleMin: 21, extra: 2 },
        stage: 'custom',
      }),
    ).toBe('⛔ R1 группа молчит (без событий 21 мин, extra 2; стадия «custom»)');
  });

  it('правило без названия и без чисел — только значок и код', () => {
    expect(
      composeGroupSignal({ kind: 'groupSignal', rule: 'R12', severity: 'info', numbers: {} }),
    ).toBe('ℹ️ R12');
  });

  it('предупреждения утечек R13, R15, R17 — с названием и числами словами', () => {
    const line = (rule: GroupSignalNotice['rule'], numbers: Record<string, number>) =>
      composeGroupSignal({ kind: 'groupSignal', rule, severity: 'warn', numbers });
    expect(line('R13', { spawns: 8, subW: 21.5 })).toBe(
      '⚠️ R13 веер субагентов (спавнов: 8, расход субагентов 21.5 W)',
    );
    expect(line('R15', { timeoutMin: 10, timeouts: 2 })).toBe(
      '⚠️ R15 вызов упёрся в свой срок (срок 10 мин, упоров в срок: 2)',
    );
    expect(line('R17', { waitMin: 25, ahead: 1 })).toBe(
      '⚠️ R17 долгое ожидание очереди тяжёлых шагов (ждёт 25 мин, впереди в очереди: 1)',
    );
  });

  it('R22–R33, что уходят наружу, — с названием и числами словами, без сырых ключей', () => {
    const line = (rule: GroupSignalNotice['rule'], numbers: Record<string, number>) =>
      composeGroupSignal({ kind: 'groupSignal', rule, severity: 'warn', numbers });
    expect(line('R22', { idleMin: 25 })).toBe('⚠️ R22 группа стоит без хода (без событий 25 мин)');
    expect(line('R23', { groups: 3, spanMin: 40 })).toBe(
      '⚠️ R23 одна беда в нескольких группах (групп: 3, за 40 мин)',
    );
    expect(line('R24', { fails: 3 })).toBe(
      '⚠️ R24 тот же вызов падает той же ошибкой (падений: 3)',
    );
    expect(line('R26', { kills: 2 })).toBe('⚠️ R26 останавливает чужие процессы (остановок: 2)');
    expect(line('R27', { waitMin: 30 })).toBe('⚠️ R27 вопрос текстом ждёт ответа (ждёт 30 мин)');
    expect(line('R28', { nudges: 3 })).toBe(
      '⚠️ R28 напоминания о доставке впустую (напоминаний: 3)',
    );
    expect(line('R29', { calls: 2 })).toBe('⚠️ R29 инструмента нет в сессии (вызовов: 2)');
    expect(line('R30', { failures: 6, spanMin: 15 })).toBe(
      '⚠️ R30 внешний сервис не отвечает (сбоев: 6, за 15 мин)',
    );
    expect(line('R31', { writes: 3 })).toBe(
      '⚠️ R31 правки вне своей копии (действий вне копии: 3)',
    );
    expect(line('R33', {})).toBe('⚠️ R33 вердикт ревью без блока');
  });

  it('R34–R36 — с названием и числами словами', () => {
    const line = (rule: GroupSignalNotice['rule'], numbers: Record<string, number>) =>
      composeGroupSignal({ kind: 'groupSignal', rule, severity: 'warn', numbers });
    expect(line('R34', { writeK: 66, prevK: 157, lostW: 0.42 })).toBe(
      '⚠️ R34 новый разговор поверх тёплого (переписано 66k токенов, окно было 157k, потеря ≈0.42 W)',
    );
    expect(line('R35', { files: 2 })).toBe('⚠️ R35 переделка закоммиченного (файлов: 2)');
    expect(line('R36', { ports: 1 })).toBe('⚠️ R36 сервер звена пережил паузу (портов: 1)');
  });

  it('afterMin у R25 — после отказа, у R20 — по-прежнему после паузы', () => {
    const line = (rule: GroupSignalNotice['rule']) =>
      composeGroupSignal({
        kind: 'groupSignal',
        rule,
        severity: 'alert',
        numbers: { afterMin: 4 },
      });
    expect(line('R25')).toBe(
      '⛔ R25 отбитое действие сделано другим путём (через 4 мин после отказа)',
    );
    expect(line('R20')).toBe('⛔ R20 группа действует на паузе (через 4 мин после паузы)');
  });
});

/** F-37: сигнал сторожа — обычное событие подписки, у Telegram и у вебхука одно и то же. */
describe('сигнал сторожа как событие подписки groupSignal', () => {
  const notice: GroupSignalNotice = {
    kind: 'groupSignal',
    rule: 'R1',
    severity: 'alert',
    numbers: { idleMin: 21 },
    projectPath: '/work/my-app',
  };
  const telegramSettings = (events: TelegramSettings['events']): TelegramSettings =>
    ({ enabled: true, chatId: '42', events }) as TelegramSettings;
  const webhookSettings = (events: WebhookSettings['events']): WebhookSettings =>
    ({ enabled: true, url: 'https://hooks.example.com/x', events }) as WebhookSettings;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('событие и текст — свои, а не «тест упал»', () => {
    expect(noticeEvent(notice)).toBe('groupSignal');
    expect(compose(notice)).toBe('⛔ R1 группа молчит (без событий 21 мин) — my-app');
    expect(composeWebhook(notice)).toMatchObject({
      event: 'groupSignal',
      text: '⛔ R1 группа молчит (без событий 21 мин) — my-app',
      project: 'my-app',
    });
  });

  it('Telegram шлёт только при подписке на groupSignal', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    createTelegramNotifier({
      settings: () => telegramSettings(['runDone', 'testFailed']),
      token: () => 't',
    })(notice);
    expect(fetchMock).not.toHaveBeenCalled();
    createTelegramNotifier({
      settings: () => telegramSettings(['groupSignal']),
      token: () => 't',
    })(notice);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(String(init.body)).toContain('R1 группа молчит');
  });

  it('неудачная отправка без своего onError — предупреждение в журнал, токена в нём нет', async () => {
    const token = '123456:SECRET-token';
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(`{"ok":false,"description":"bot${token} kicked"}`, {
            status: 403,
          }),
        ),
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createTelegramNotifier({
        settings: () => telegramSettings(['groupSignal']),
        token: () => token,
      })(notice);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      const line = warn.mock.calls[0]?.map(String).join(' ') ?? '';
      expect(line).toContain('[notify] telegram send failed');
      expect(line).not.toContain('SECRET');
    } finally {
      warn.mockRestore();
    }
  });

  it('вебхук получает сигнал по своей подписке', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    createWebhookNotifier({
      settings: () => webhookSettings(['runDone']),
      secret: () => undefined,
    })(notice);
    expect(fetchMock).not.toHaveBeenCalled();
    createWebhookNotifier({
      settings: () => webhookSettings(['groupSignal']),
      secret: () => undefined,
    })(notice);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

/** F-59: адрес Bot API из переменной — только https или http на loopback (токен — часть адреса). */
describe('telegramApiBase', () => {
  it('без переменной и с чужим http — настоящий сервер', () => {
    expect(telegramApiBase(undefined)).toBe('https://api.telegram.org');
    expect(telegramApiBase('http://evil.example.com')).toBe('https://api.telegram.org');
    expect(telegramApiBase('не адрес')).toBe('https://api.telegram.org');
    expect(telegramApiBase('ftp://127.0.0.1')).toBe('https://api.telegram.org');
  });

  it('https и http на loopback — как заданы, без хвостового слеша', () => {
    expect(telegramApiBase('https://tg.example.com/')).toBe('https://tg.example.com');
    expect(telegramApiBase('http://127.0.0.1:9999/')).toBe('http://127.0.0.1:9999');
    expect(telegramApiBase('http://localhost:9999')).toBe('http://localhost:9999');
    expect(telegramApiBase('http://[::1]:9999')).toBe('http://[::1]:9999');
  });
});
