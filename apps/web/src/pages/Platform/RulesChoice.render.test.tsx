import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Platform } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { RulesChoice } from './RulesChoice';

/**
 * Выбор «чьи правила действуют» — кнопки-переключатели в группе (ревью 28.09,
 * F-244). Роль радиогруппы обещала стрелки и один шаг табом на группу, а каждая
 * кнопка была своим шагом и стрелки не работали: экранный диктор объявлял
 * управление, которого нет.
 */

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('выбор правил контура', () => {
  it('группа кнопок-переключателей, нажата текущая', () => {
    const platform = { id: 'qa', rules: { applies: 'contour' } } as unknown as Platform;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <RulesChoice platform={platform} />
      </QueryClientProvider>,
    );

    expect(html).not.toContain('role="radio');
    expect(html).toContain('role="group"');
    expect(html.split('aria-pressed=').length - 1).toBe(3);
    const pressed = [...html.matchAll(/aria-pressed="true"[^>]*data-applies="([a-z]+)"/g)].map(
      (match) => match[1],
    );
    expect(pressed).toEqual(['contour']);
  });
});
