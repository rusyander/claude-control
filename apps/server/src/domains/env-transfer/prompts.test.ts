import { describe, expect, it } from 'vitest';
import type { PromptOverride } from '@agentdeck/contracts/prompts';
import {
  buildPanelPrompts,
  panelPromptsFile,
  planPanelPrompts,
  takePanelPrompts,
} from './prompts.ts';

/**
 * Секция промптов в архиве: архив приехал с ЧУЖОЙ машины.
 *
 * Проверяется то, что может прийти не таким, как ждали: промпт, которого в этой
 * панели нет (архив собран новее), битая секция, версия из будущего. Каждый
 * случай должен быть НАЗВАН и пропущен — молча записанная правка промпта,
 * которого не существует, легла бы на диск файлом, который никто не прочитает.
 */

const mine: PromptOverride = {
  id: 'image',
  text: 'мой текст картинки',
  baseSha: 'abc',
  updatedAt: '2026-09-11T10:00:00.000Z',
};

const fromArchive = (overrides: unknown): Buffer =>
  Buffer.from(JSON.stringify({ version: 1, overrides }), 'utf8');

describe('план по секции промптов', () => {
  it('нет секции — нет и строк', () => {
    expect(planPanelPrompts({ data: undefined, current: [] })).toEqual({ entries: [] });
  });

  it('новая правка, такая же и отличающаяся различимы', () => {
    const data = panelPromptsFile(buildPanelPrompts([mine]));

    expect(planPanelPrompts({ data, current: [] }).entries.at(0)?.status).toBe('new');
    expect(planPanelPrompts({ data, current: [mine] }).entries.at(0)?.status).toBe('same');
    expect(
      planPanelPrompts({ data, current: [{ ...mine, text: 'другой' }] }).entries.at(0)?.status,
    ).toBe('differs');
  });

  it('промпт, которого в этой панели нет, помечен неизвестным', () => {
    const data = fromArchive([{ ...mine, id: 'видео' }]);
    const entry = planPanelPrompts({ data, current: [] }).entries.at(0);

    expect(entry?.id).toBe('видео');
    expect(entry?.unknown).toBe(true);
  });

  it('битая секция названа причиной, а не пустым списком', () => {
    const plan = planPanelPrompts({ data: Buffer.from('{не json', 'utf8'), current: [] });

    expect(plan.entries).toEqual([]);
    expect(plan.problem).toContain('не разбирается');
  });

  it('секция новее поддерживаемой версии не разбирается вслепую', () => {
    const data = Buffer.from(JSON.stringify({ version: 99, overrides: [mine] }), 'utf8');
    const plan = planPanelPrompts({ data, current: [] });

    expect(plan.problem).toContain('новее');
  });

  it('секция не той раскладки не проходит проверку', () => {
    const data = fromArchive([{ id: 'image' }]);

    expect(planPanelPrompts({ data, current: [] }).problem).toContain('не проходит проверку');
  });
});

describe('отбор правок к записи', () => {
  it('берётся только отмеченное', () => {
    const data = panelPromptsFile(
      buildPanelPrompts([mine, { ...mine, id: 'presentation', text: 'слайды' }]),
    );

    expect(takePanelPrompts(data, ['image']).map((item) => item.id)).toEqual(['image']);
  });

  it('неизвестный промпт не берётся, даже когда он отмечен', () => {
    const data = fromArchive([{ ...mine, id: 'видео' }]);

    expect(takePanelPrompts(data, ['видео'])).toEqual([]);
  });

  it('битая секция не даёт ни одной записи', () => {
    expect(takePanelPrompts(Buffer.from('{не json', 'utf8'), ['image'])).toEqual([]);
  });
});

describe('сборка секции', () => {
  it('везёт только правки — встроенных текстов в ней нет по устройству', () => {
    const document = buildPanelPrompts([mine]);

    expect(document.overrides).toEqual([mine]);
    expect(Object.keys(document)).toEqual(['version', 'overrides']);
  });
});
