import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import type { ChildStageGroup } from '../ChildStages.types';
import { HubSummary } from './HubSummary';

/**
 * Сводка хаба (L37): три корзины — идут, ждут вас, стоят — и время с начала.
 * Пустых корзин и времени нет — строки нет вовсе. Фишки сигналов сторожа и
 * итога подогрева кэша сняты вместе с конвейером разделения (этап 10, G14).
 */
const NOW = Date.parse('2026-10-22T10:00:00.000Z');

const row = (over: Partial<ChildStageGroup> = {}): ChildStageGroup => ({
  chatId: 'c0',
  title: 'Работа',
  stages: ['work'],
  isRunning: false,
  ...over,
});

/** Счётчики сводки: корзина → текст без тегов. */
function counts(html: string): Record<string, string> {
  return Object.fromEntries(
    [...html.matchAll(/data-hub-count="(\w+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]),
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('HubSummary — ранний выход', () => {
  it('ни корзин, ни времени — строки нет', () => {
    expect(renderToStaticMarkup(<HubSummary groups={[]} now={NOW} />)).toBe('');
    // Отброшенный чат и строка разбора — не группы: сводке считать нечего.
    const html = renderToStaticMarkup(
      <HubSummary groups={[row({ retired: true }), row({ stages: ['triage'] })]} now={NOW} />,
    );
    expect(html).toBe('');
  });
});

describe('HubSummary — корзины', () => {
  it('идёт, ждёт ответа и стоит — каждая группа ровно в одной корзине', () => {
    const html = renderToStaticMarkup(
      <HubSummary
        groups={[
          row({ chatId: 'a', isRunning: true }),
          // Идущий прогон перевешивает вопрос прошлого хода.
          row({ chatId: 'b', isRunning: true, waitingFor: 'question' }),
          row({ chatId: 'c', waitingFor: 'question' }),
          row({ chatId: 'd' }),
        ]}
        now={NOW}
      />,
    );
    expect(Object.keys(counts(html))).toEqual(['running', 'ask', 'idle']);
    expect(counts(html).running).toContain('2');
    expect(counts(html).ask).toContain('1');
    expect(counts(html).idle).toContain('1');
    expect(html).not.toContain('data-hub-keep-warm-total');
  });

  it('время — от первого звена до последней записи, когда ничего не идёт', () => {
    const html = renderToStaticMarkup(
      <HubSummary
        groups={[
          row({ startedAt: '2026-10-22T08:00:00.000Z', lastAt: '2026-10-22T09:30:00.000Z' }),
        ]}
        now={NOW}
      />,
    );
    expect(html).toContain('data-hub-elapsed');
    expect(html).toContain('1ч 30м');
  });
});
