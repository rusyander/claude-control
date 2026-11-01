import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import type { TelegramCardViewProps } from './TelegramCard.types';
import { TelegramCardView } from './TelegramCardView';
import { TelegramAdvanced } from '../TelegramAdvanced/TelegramAdvanced';

/**
 * Карточка Telegram после «мешанины» (владелец 25.10.2026): до подключения —
 * два шага и ничего больше; после — состояние одним словом, «Вы: имя», три
 * группы «Когда звать» (кнопки ответа всегда, минуты в строке «Агент ждёт
 * тебя»), одно «Сохранить» и строка итога, если половина не записалась.
 */

const noop = (): void => undefined;
const draft = {
  chatId: '777',
  ownerId: '777',
  waits: true,
  afterMinutes: '3',
  finished: true,
  doneAfterMinutes: '5',
  broken: true,
  budget: false,
};

function props(over: Partial<TelegramCardViewProps> = {}): TelegramCardViewProps {
  return {
    connected: true,
    enabled: true,
    health: { tone: 'ok', bot: '@deck_bot' },
    ownerLabel: 'Анна (@anna)',
    draft,
    onChange: noop,
    onMaster: noop,
    masterBusy: false,
    canSave: false,
    saving: false,
    onSave: noop,
    onTest: noop,
    testing: false,
    setup: { token: '', onToken: noop, onCheck: noop, checking: false },
    connect: <div data-slot="connect" />,
    reconnecting: false,
    onReconnect: noop,
    advanced: <div data-slot="advanced" />,
    helpLink: <a href="/help?topic=integrations">?</a>,
    ...over,
  };
}

const render = (over: Partial<TelegramCardViewProps> = {}) =>
  renderToStaticMarkup(<TelegramCardView {...props(over)} />);

describe('карточка Telegram', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('не подключено — «не подключён», два шага, ни выключателя, ни групп', () => {
    const html = render({ connected: false });
    expect(html).toContain('data-telegram-card="setup"');
    expect(html).toContain('не подключён');
    expect(html).toContain('1. Бот');
    expect(html).toContain('Проверить');
    expect(html).toContain('2. Вы');
    expect(html).toContain('data-slot="connect"');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('Когда звать');
    expect(html).not.toContain('Отправить пробное');
  });

  it('подключено — «работает · @бот», «Вы: имя», три группы, пробное и «Сохранить»', () => {
    const html = render();
    expect(html).toContain('data-telegram-card="connected"');
    expect(html).toContain('работает · @deck_bot');
    expect(html).toMatch(/Вы:(?:<[^>]+>|\s)*Анна \(@anna\)/);
    expect(html).not.toContain('Кому пишет');
    expect(html).toContain('Переподключить');
    // Минуты — в строке «Агент ждёт тебя», отдельной галочки кнопок нет.
    expect(html).toMatch(
      /Агент ждёт тебя — вопрос или разрешение · если не ответил в панели за(?:(?!<label).)*value="3"/,
    );
    expect(html).not.toContain('с кнопками ответа');
    expect(html).toContain('Задача закрыта или агент ждёт решения — если работал дольше');
    expect(html).toContain(
      'Что-то сломалось — агент упал, тесты красные, группа зависла или пошла по кругу',
    );
    expect(html).not.toContain('сторож');
    expect(html).toContain('Отправить пробное');
    expect(html).toContain('Сохранить');
    expect(html).toContain('data-slot="advanced"');
    expect(html).not.toContain('1. Бот');
    // «Сохранить» гаснет, пока нечего сохранять.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Сохранить/);
  });

  it('ошибка — причина словами; минуты гаснут без «Агент ждёт тебя»', () => {
    const html = render({
      health: { tone: 'error', reason: { kind: 'answers', state: 'webhook' } },
      draft: { ...draft, waits: false },
    });
    expect(html).toContain('data-telegram-health="error"');
    expect(html).toContain('ошибка: у бота стоит вебхук');
    expect(html).toMatch(/value="3"[^>]*disabled|disabled[^>]*value="3"/);
    expect(render({ health: { tone: 'off' } })).toContain('выключен');
  });

  it('половина не записалась — сказано, какая', () => {
    const html = render({
      canSave: true,
      saveLine: { ok: false, text: 'Уведомления сохранены, ответы с кнопками — нет: 403' },
    });
    expect(html).toContain('data-telegram-save="failed"');
    expect(html).toContain('Уведомления сохранены, ответы с кнопками — нет: 403');
  });

  it('«Дополнительно»: без «Убирать отвеченное», бюджет с подсказкой, «Переподключить бота»', () => {
    const html = renderToStaticMarkup(
      <TelegramAdvanced
        draft={draft}
        onChange={noop}
        token=""
        onToken={noop}
        onForget={noop}
        onCheck={noop}
        checking={false}
        onRestart={noop}
        restarting={false}
      />,
    );
    expect(html).not.toContain('Убирать отвеченное');
    expect(html).not.toContain('Чат уведомлений');
    expect(html).not.toContain('Чьи ответы принимать');
    expect(html).toContain('Бюджет контура на исходе');
    expect(html).toContain('data-telegram-budget-hint');
    expect(html).toContain('Переподключить бота');
    expect(html).not.toContain('опрос ответов');
  });
});
