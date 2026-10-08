import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { ChatProgressSheet } from './ChatProgressSheet';

/**
 * Живой прогон 29.09: ход кончился вопросом человеку, а полоса «План агента»
 * показывала «В фоне» с таймером — ожидание ответа читалось как «работает».
 */
describe('ChatProgressSheet — ждёт ответа', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  const progress = {
    tasks: [{ text: 'C2', status: 'in_progress' as const }],
    agents: [],
    shells: [{ id: 'v', command: 'npx vite --port 9123', status: 'running' as const }],
    processAlive: true,
  };

  it('ход кончился вопросом — «Ждёт вашего ответа» первым значком', () => {
    const html = renderToStaticMarkup(<ChatProgressSheet progress={progress} awaiting />);
    const awaitingAt = html.indexOf('Ждёт вашего ответа');
    expect(awaitingAt).toBeGreaterThan(-1);
    expect(awaitingAt).toBeLessThan(html.indexOf('Сделано'));
  });

  it('пока ход идёт — значка нет: вопроса ещё не задали', () => {
    const html = renderToStaticMarkup(<ChatProgressSheet progress={progress} awaiting isRunning />);
    expect(html).not.toContain('Ждёт вашего ответа');
  });

  it('плана нет, а вопрос есть — полоса всё равно видна', () => {
    const html = renderToStaticMarkup(
      <ChatProgressSheet progress={{ tasks: [], agents: [] }} awaiting />,
    );
    expect(html).toContain('Ждёт вашего ответа');
  });
});
