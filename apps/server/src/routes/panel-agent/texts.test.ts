import { describe, expect, it } from 'vitest';
import {
  panelTextCodes,
  panelTextCountCodes,
  panelTextParams,
} from '@agentdeck/contracts/panel-agent';
import { PANEL_TEXTS_RU, panelTextRu } from './texts.ts';
import { PANEL_ACTIONS } from './actions.ts';

/**
 * Русский запасной текст карточки и следа — ровно по контракту кодов: каждый
 * код, те же подстановки, ни одного лишнего. Иначе запасная строка у старого
 * клиента разойдётся с тем, что окно переводит.
 */
describe('тексты агента панели на сервере', () => {
  const used = (text: string) =>
    [...new Set([...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))].sort();

  it('у каждого кода русский текст ровно с объявленными подстановками', () => {
    const problems = panelTextCodes.flatMap((code) => {
      const entry: unknown = PANEL_TEXTS_RU[code];
      const declared = [...panelTextParams[code]].sort();
      const forms: Array<[string, unknown]> =
        typeof entry === 'string' ? [['', entry]] : Object.entries(entry as object);
      if (typeof entry !== 'string' && !panelTextCountCodes.includes(code as never)) {
        return [`${code}: формы числа у кода без count`];
      }
      if (typeof entry !== 'string') {
        const keys = Object.keys(entry as object).sort();
        if (JSON.stringify(keys) !== JSON.stringify(['few', 'many', 'one', 'other'])) {
          return [`${code}: формы ${keys.join(',')}`];
        }
      }
      return forms.flatMap(([form, text]) => {
        if (typeof text !== 'string' || !text.trim()) return [`${code}${form}: нет текста`];
        return JSON.stringify(used(text)) === JSON.stringify(declared)
          ? []
          : [`${code}${form}: ${used(text).join(',')} ≠ ${declared.join(',')}`];
      });
    });
    expect(problems).toEqual([]);
    expect(Object.keys(PANEL_TEXTS_RU).sort()).toEqual([...panelTextCodes].sort());
  });

  it('число склоняется по правилам языка, а не «кейс(ов)»', () => {
    expect(panelTextRu('summary-run-tests-run', { count: 1 })).toBe(
      'Запустить агента тестов: 1 кейс',
    );
    expect(panelTextRu('summary-run-tests-run', { count: 3 })).toBe(
      'Запустить агента тестов: 3 кейса',
    );
    expect(panelTextRu('summary-run-tests-run', { count: 5 })).toBe(
      'Запустить агента тестов: 5 кейсов',
    );
    expect(panelTextRu('summary-run-tests-run', { count: 21 })).toBe(
      'Запустить агента тестов: 21 кейс',
    );
    expect(panelTextRu('summary-draft-cases', { count: 12 })).toContain('12 кейсов');
    for (const code of panelTextCodes) {
      expect(panelTextRu(code, { count: 2 })).not.toMatch(/\(ов\)|\(а\)/);
    }
  });

  it('у каждой правки — название следа кодом, у каждого чтения — строка следа кодом', () => {
    const missing = PANEL_ACTIONS.filter((action) =>
      action.risk === 'read' ? !action.summary : !action.title,
    ).map((action) => action.name);
    expect(missing).toEqual([]);
  });
});
