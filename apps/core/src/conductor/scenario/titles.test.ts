import { describe, expect, it } from 'vitest';
import { PRESET_IDS } from '@agentdeck/contracts/core/scenario';
import { PRESETS } from './presets.ts';
import {
  localizePreset,
  PRESET_TITLES,
  scenarioTitleIn,
  STEP_TITLES,
  stepTitleIn,
  titleLangOf,
} from './titles.ts';

/**
 * Таблица заголовков против данных пресетов (этап 10, F4): русская сторона равна строке данных
 * (иначе пресет не узнаётся и остаётся русским в английской панели), у каждого пресета и шага есть
 * английская строка, свой заголовок человека и неизвестное значение остаются как записаны.
 */

describe('preset title table', () => {
  it('every preset and every preset step has a row whose Russian side is the preset data', () => {
    expect(Object.keys(PRESET_TITLES).sort()).toEqual([...PRESET_IDS].sort());
    for (const p of PRESETS) {
      expect(PRESET_TITLES[p.id as keyof typeof PRESET_TITLES]?.ru, p.id).toBe(p.title);
      for (const st of p.steps) expect(STEP_TITLES[st.id]?.ru, `${p.id}/${st.id}`).toBe(st.title);
    }
  });

  it('every row has a non-empty English side without Cyrillic', () => {
    for (const pair of [...Object.values(PRESET_TITLES), ...Object.values(STEP_TITLES)]) {
      expect(pair.en.trim()).not.toBe('');
      expect(pair.en).not.toMatch(/\p{Script=Cyrillic}/u);
    }
  });

  it('a preset step title is named in the asked language from either side; an own title stays', () => {
    expect(stepTitleIn({ id: 'work', title: 'Работа' }, 'en')).toBe('Work');
    expect(stepTitleIn({ id: 'work', title: 'Work' }, 'ru')).toBe('Работа');
    expect(stepTitleIn({ id: 'work', title: 'Работа' }, 'ru')).toBe('Работа');
    expect(stepTitleIn({ id: 'work', title: 'Своя работа' }, 'en')).toBe('Своя работа');
    expect(stepTitleIn({ id: 'path-1', title: 'Мой шаг' }, 'en')).toBe('Мой шаг');
    expect(stepTitleIn({ id: 'toString', title: 'x' }, 'en')).toBe('x');
  });

  it('a preset is localized in full; a library scenario (non-preset id) is returned as is', () => {
    const bugFix = PRESETS.find((p) => p.id === 'bug-fix');
    if (!bugFix) throw new Error('bug-fix preset missing');
    const en = localizePreset(bugFix, 'en');
    expect(en.title).toBe('Bug fix');
    expect(en.steps.map((s) => s.title)).not.toContain('Работа');
    expect(localizePreset(bugFix, 'ru')).toEqual(bugFix);
    const own = { ...bugFix, id: 'team-flow' };
    expect(localizePreset(own, 'en')).toBe(own);
    expect(scenarioTitleIn({ id: 'team-flow', title: 'Исправление ошибки' }, 'en')).toBe(
      'Исправление ошибки',
    );
  });

  it('language: en only from exactly "en"; anything else, missing included, is Russian', () => {
    expect(titleLangOf('en')).toBe('en');
    for (const raw of [undefined, null, '', 'ru', 'de', 'EN', 'en-US', 1]) {
      expect(titleLangOf(raw)).toBe('ru');
    }
  });
});
