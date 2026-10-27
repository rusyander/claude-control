import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TelegramConnectView } from '@agentdeck/contracts/telegram-answers';
import { i18n } from '@shared/config/i18n';
import { TelegramConnectBlock } from './TelegramConnect';
import { TelegramLastSendLine } from '../TelegramLastSendLine/TelegramLastSendLine';

/**
 * Подключение по /start на карточке Telegram: кнопка, ожидание со ссылкой на
 * бота, «это вы?» с подтверждением, истечение, отказ с причиной; и строка
 * последней отправки уведомления.
 */

const noop = (): void => undefined;
const render = (view: TelegramConnectView, hasToken = true) =>
  renderToStaticMarkup(
    <TelegramConnectBlock
      view={view}
      hasToken={hasToken}
      busy={false}
      onOpen={noop}
      onConfirm={noop}
      onCancel={noop}
    />,
  );

describe('подключение бота по /start', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('окно не открыто — «Подключить»; без токена кнопка погашена и сказано почему', () => {
    const html = render({ state: 'idle' });
    expect(html).toContain('Подключить');
    expect(html).not.toContain('disabled');
    const empty = render({ state: 'idle' }, false);
    expect(empty).toContain('disabled');
    expect(empty).toContain('Сначала сохраните токен бота');
  });

  it('ждём /start — ссылка на бота и время конца окна', () => {
    const html = render({
      state: 'waiting',
      bot: 'deck_bot',
      link: 'https://t.me/deck_bot',
      expiresAt: '2026-10-25T10:05:00.000Z',
    });
    expect(html).toContain('data-telegram-connect="waiting"');
    expect(html).toContain('href="https://t.me/deck_bot"');
    expect(html).toContain('Ждём /start до');
  });

  it('кандидат — «имя (@ник), id — это вы?» с подтверждением и отменой', () => {
    const html = render({
      state: 'candidate',
      candidate: { id: '777', firstName: 'Анна', username: 'anna' },
    });
    expect(html).toContain('Анна (@anna), id 777 — это вы?');
    expect(html).toContain('Да, это я');
    expect(html).toContain('Нет, отменить');
  });

  it('истекло — «открыть заново»; отказ — причина словами и подробность Telegram', () => {
    expect(render({ state: 'expired' })).toContain('Пять минут прошли');
    const failed = render({ state: 'failed', reason: 'same-bot' });
    expect(failed).toContain('Этого бота слушает агент');
    expect(render({ state: 'failed', reason: 'network', detail: 'HTTP 502' })).toContain(
      'Telegram не ответил — попробуйте ещё раз. — HTTP 502',
    );
  });

  it('подтверждено — кто подключён', () => {
    const html = render({ state: 'confirmed', candidate: { id: '777', firstName: 'Анна' } });
    expect(html).toContain('Подключено: Анна, id 777');
  });

  it('последняя отправка: доставлено или ошибка с причиной', () => {
    const ok = renderToStaticMarkup(
      <TelegramLastSendLine lastSend={{ at: '2026-10-25T10:00:00.000Z', ok: true }} />,
    );
    expect(ok).toContain('data-telegram-last-send="ok"');
    expect(ok).toContain('— доставлено');
    const failed = renderToStaticMarkup(
      <TelegramLastSendLine
        lastSend={{ at: '2026-10-25T10:00:00.000Z', ok: false, error: '403: bot was blocked' }}
      />,
    );
    expect(failed).toContain('ошибка: 403: bot was blocked');
  });
});
