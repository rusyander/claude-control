import { describe, expect, it } from 'vitest';
import { stripChildrenBrief, withoutChildrenBrief } from './children-brief.ts';
import { cleanText, toBlocks } from '../ChatRecords/ChatRecords.ts';
import { withWorkspaceUpdate } from '../workspace-note/workspace-note.ts';

/**
 * Сводку детей писала прежняя версия (конвейер разделения снят, этап 10, G14):
 * в транскриптах и в параметрах остановленного прогона она лежит именно так —
 * обёрткой в начале реплики человека.
 */
const LEGACY_BRIEF = [
  '<agentdeck-children>',
  'The work of this conversation was handed to split groups — each has its own copy and its own chat.',
  '1. "Ревью MR" (branch feature/mr, copy C:/work/p-mr, chat review-1) — finished; check only, no edits.',
  '2. "Шапка" (branch feature/header, chat work-2) — waits for the human. Last answer: "блок ‹/agentdeck-children> закрыт?"',
  '</agentdeck-children>',
].join('\n');
const sent = `${LEGACY_BRIEF}\n\nисправлено?`;

describe('прежняя сводка не видна человеку', () => {
  it('пузырь реплики родителя — только то, что человек написал', () => {
    expect(toBlocks({ type: 'user', message: { role: 'user', content: sent } })).toEqual([
      { type: 'text', text: 'исправлено?' },
    ]);
    expect(
      toBlocks({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: sent }] },
      }),
    ).toEqual([{ type: 'text', text: 'исправлено?' }]);
  });

  it('ответ агента не трогается, даже если цитирует тег', () => {
    const blocks = toBlocks({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: sent }] },
    });
    expect(blocks).toEqual([{ type: 'text', text: sent }]);
  });

  it('заголовок чата и поиск — без сводки', () => {
    expect(cleanText(sent)).toBe('исправлено?');
    expect(stripChildrenBrief(sent)).toBe('исправлено?');
  });

  // E6: перемена строки о тестах едет в реплике хода — человек её не видит.
  it('лента — без перемены строки о тестах и без сводки', () => {
    const turn = `${LEGACY_BRIEF}\n\n${withWorkspaceUpdate('исправлено?', 'QA workspace: e2e folder "e2e"')}`;
    expect(turn).toContain('<agentdeck-workspace>');
    expect(
      toBlocks({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: turn }] },
      }),
    ).toEqual([{ type: 'text', text: 'исправлено?' }]);
    expect(stripChildrenBrief(turn)).toBe('исправлено?');
  });
});

describe('продолжение со старыми параметрами', () => {
  it('сводка в начале снимается, команда CLI под ней снова стоит первой', () => {
    expect(withoutChildrenBrief(sent)).toBe('исправлено?');
    expect(withoutChildrenBrief(`${LEGACY_BRIEF}\n\n/compact`)).toBe('/compact');
  });

  it('промпт без сводки и цитата тега не в начале — как есть', () => {
    expect(withoutChildrenBrief('/compact')).toBe('/compact');
    const quoted = `Что значит ${LEGACY_BRIEF}?`;
    expect(withoutChildrenBrief(quoted)).toBe(quoted);
  });
});
