import { afterAll, describe, expect, it } from 'vitest';
import { HOOK_EVENT_INFO, MCP_PRESETS, PERMISSION_PRESETS } from '@agentdeck/contracts';
import { presetsEn } from './presets/en';
import { presetText } from './preset-text';
import { i18n } from './instance';

const CYRILLIC = /[А-Яа-яЁё]/;

/**
 * Каждая заготовка, что видна в панели, переведена целиком, и в английском
 * тексте нет ни буквы кириллицы. Лишние ключи (заготовку удалили, перевод
 * остался) тоже ловятся — иначе словарь молча зарастает мёртвыми строками.
 * Заготовки хуков живут в фиче — их сверяет `HookEditor/model/hookPresets.test.ts`.
 */
describe('словарь заготовок: полнота английского', () => {
  const lists = {
    permission: PERMISSION_PRESETS.map((p) => ({
      id: p.id,
      fields: { title: p.title, description: p.description },
    })),
    mcp: MCP_PRESETS.map((p) => ({
      id: p.id,
      fields: { title: p.title, description: p.description },
    })),
    hookEvent: HOOK_EVENT_INFO.map((e) => ({
      id: e.event,
      fields: { when: e.when, useFor: e.useFor },
    })),
  } as const;

  for (const [area, items] of Object.entries(lists)) {
    it(`${area}: у каждой заготовки есть все поля, без кириллицы`, () => {
      const dictionary = presetsEn[area as keyof typeof presetsEn] as Record<
        string,
        Record<string, string> | undefined
      >;
      const problems = items.flatMap(({ id, fields }) =>
        Object.keys(fields).flatMap((field) => {
          const text = dictionary[id]?.[field];
          if (!text?.trim()) return [`${id}.${field}: нет перевода`];
          return CYRILLIC.test(text) ? [`${id}.${field}: кириллица`] : [];
        }),
      );
      expect(problems).toEqual([]);
    });

    it(`${area}: нет ключей без заготовки`, () => {
      const known = new Set(items.map((item) => item.id));
      const dictionary = presetsEn[area as keyof typeof presetsEn];
      expect(Object.keys(dictionary).filter((id) => !known.has(id))).toEqual([]);
    });
  }
});

describe('presetText через настоящий i18n', () => {
  afterAll(async () => {
    await i18n.changeLanguage('ru');
  });

  const preset = PERMISSION_PRESETS[0]!;
  const t = (key: string, options: { defaultValue: string }) => i18n.t(key, options);

  it('ru: текст самой заготовки', async () => {
    await i18n.changeLanguage('ru');
    expect(presetText(t, 'permission', preset.id, 'title', preset.title)).toBe(preset.title);
  });

  it('en: перевод из словаря', async () => {
    await i18n.changeLanguage('en');
    expect(presetText(t, 'permission', preset.id, 'title', preset.title)).toBe(
      presetsEn.permission[preset.id]!.title,
    );
  });

  it('en: заготовка без перевода — русский текст, а не ключ', async () => {
    await i18n.changeLanguage('en');
    expect(presetText(t, 'permission', 'no-such-preset', 'title', 'Запас')).toBe('Запас');
  });
});
