import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LocalServerInfo } from '@agentdeck/contracts/local-models';
import { i18n } from '@shared/config/i18n';
import { ServerNotes } from './ServerNotes';

/**
 * Сообщения карточки сервера по ходу ночного прогона (L4b): упал и поднят, подъём не
 * удался, потолок исчерпан, настройка ждёт конца прогона. Показывается то, что ответил сервер.
 */

const base = { keepLoaded: false, keepAwake: true, idleSeconds: 600 } as LocalServerInfo;
const AT = new Date(2026, 9, 14, 3, 7).getTime();

function render(server: Partial<LocalServerInfo>): string {
  return renderToStaticMarkup(<ServerNotes server={{ ...base, ...server }} />);
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('сообщения о сервере моделей', () => {
  it('без сообщений и без ожидания карточка молчит', () => {
    expect(render({})).toBe('');
  });

  it('поднят заново: время и число подъёмов из ответа сервера', () => {
    const html = render({ notice: { kind: 'restarted', at: AT, restarts: 2 } });
    expect(html).toContain('поднят заново');
    expect(html).toContain('03:07');
    expect(html).toContain('Подъёмов за последние 10 минут: 2');
  });

  it('подъём не удался: причина названа', () => {
    const html = render({
      notice: { kind: 'failed', at: AT, restarts: 1, reason: 'CUDA out of memory' },
    });
    expect(html).toContain('подъём в 03:07 не удался: CUDA out of memory');
  });

  it('потолок исчерпан: сказано, что панель пробует реже, и когда в следующий раз', () => {
    const html = render({
      notice: {
        kind: 'gave-up',
        at: AT,
        restarts: 5,
        reason: 'порт занят',
        nextTryAt: AT + 10 * 60_000,
      },
    });
    expect(html).toContain('не поднимается');
    expect(html).toContain('порт занят');
    expect(html).toContain('раз в 10 минут');
    expect(html).toContain('следующая — в 03:17');
    expect(html).toContain('попыток 5');
  });

  it('настройка ждёт конца прогона — так и написано', () => {
    expect(render({ restartPending: true })).toContain(
      i18n.t('localModels.pending.note').slice(0, 30),
    );
  });

  it('перезапуск после прогона не удался — причина названа, ожидания уже нет', () => {
    const html = render({ restartError: 'не хватило видеопамяти' });
    expect(html).toContain('не перезапустился');
    expect(html).toContain('не хватило видеопамяти');
    expect(html).not.toContain(i18n.t('localModels.pending.note').slice(0, 30));
  });
});
