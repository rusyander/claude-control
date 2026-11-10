import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RecordedCaseView } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { RecordedCaseRow } from './RecordedCaseRow';

/**
 * Полоска прогонов записанного сценария (R3): статус каждого прогона слышен скринридеру и виден без
 * наведения, а не живёт в одном `title` — `title` не читается с клавиатуры и на касании.
 */

const item: RecordedCaseView = {
  groupId: 'g',
  caseId: 'g-001',
  title: 'Вход по паролю',
  file: '.agent/tests/recorded/g/g-001.recorded.mjs',
  testName: 'recorded > g-001',
  unchecked: 0,
  status: 'failed',
  history: [
    { runId: 'r3', status: 'failed', startedAt: '2026-11-09T10:00:00.000Z' },
    { runId: 'r2', status: 'passed', startedAt: '2026-11-08T10:00:00.000Z' },
    { runId: 'r1', status: 'passed', startedAt: '2026-11-07T10:00:00.000Z' },
    // Не запускавшийся прогон не «прошёл»: сводка считает только прошедшие.
    { runId: 'r0', status: 'skipped', startedAt: '2026-11-06T10:00:00.000Z' },
  ],
};

async function render(view: RecordedCaseView, lang = 'ru'): Promise<string> {
  await i18n.changeLanguage(lang);
  return renderToStaticMarkup(<RecordedCaseRow item={view} />);
}

describe('recorded case row history strip', () => {
  it('every run mark carries its status as text, and the strip says how many passed', async () => {
    const html = await render(item);
    // Каждая отметка — текст для скринридера, не только подсказка наведения.
    const marks = [...html.matchAll(/<li[^>]*data-tone="[^"]*"[^>]*>(.*?)<\/li>/g)].map(
      (m) => m[1] ?? '',
    );
    expect(marks).toHaveLength(4);
    expect(marks[0]).toContain('упал');
    expect(marks[1]).toContain('прошёл');
    expect(marks[3]).toContain('не запускался');
    // Видимая сводка: без наведения ясно, сколько из последних прогонов прошли.
    expect(html).toContain('data-recorded-history-summary');
    expect(html).toContain('прошли 2 из 4');
  });

  it('the English row says the same', async () => {
    const html = await render(item, 'en');
    expect(html).toContain('2 of 4 passed');
    await i18n.changeLanguage('ru');
  });
});
