import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { i18n } from '@shared/config/i18n';
import type { GroupRecheckState } from '../GroupRecheck.types';
import { GroupRecheck } from './GroupRecheck';

/**
 * «Заметка» к «Перепроверить MR» (аудит g5 27.10, H1): ревью владельца шло в чате
 * наблюдателя, не в форже, — заданию перепроверки её было негде взять. Кнопка заметки
 * стоит рядом с перепроверкой, пока та не идёт; поле раскрывается по нажатию
 * (нажатие и отправку гоняет `tools/qa/check-hub-continue-recheck.mjs` в живом UI).
 */

const render = (recheck: Partial<GroupRecheckState> = {}): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GroupRecheck recheck={{ parentChatId: 'parent', index: 2, ...recheck }} />
    </QueryClientProvider>,
  );

describe('«Перепроверить MR»: кнопка заметки', () => {
  it('до проверки и после неё — «Заметка» свёрнута рядом с кнопкой, поля нет', () => {
    for (const html of [render(), render({ checkedAt: '2026-10-27T09:00:00.000Z' })]) {
      expect(html).toContain('data-recheck-note-toggle');
      expect(html).toContain('aria-expanded="false"');
      expect(html).toContain(i18n.t('chat.cascade.hub.recheck.note'));
      expect(html).not.toContain('data-recheck-note=');
      expect(html).not.toContain('data-recheck-note ');
    }
    expect(render()).toContain('data-recheck-group="open"');
    expect(render({ checkedAt: '2026-10-27T09:00:00.000Z' })).toContain(
      'data-recheck-group="checked"',
    );
  });

  it('перепроверка идёт — ни «Заметки», ни поля: добавлять нечему', () => {
    const html = render({ requestedAt: '2026-10-27T09:00:00.000Z' });
    expect(html).toContain('data-recheck-group="pending"');
    expect(html).not.toContain('data-recheck-note');
    expect(html).not.toContain(i18n.t('chat.cascade.hub.recheck.note'));
  });
});
