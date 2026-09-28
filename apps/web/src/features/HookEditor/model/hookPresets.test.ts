import { afterAll, describe, expect, it } from 'vitest';
import { i18n, presetText } from '@shared/config/i18n';
import { presetsEn } from '@shared/config/i18n/presets/en';
import { HOOK_PRESETS } from './hookPresets';

const CYRILLIC = /[А-Яа-яЁё]/;

/**
 * Готовые хуки заполняют форму своими текстами — название, описание и
 * сообщение. Английская панель раньше заполняла их по-русски (кадр справки
 * hooks/first, 28.09): у каждой заготовки должен быть полный английский текст.
 */
describe('готовые хуки: английский текст', () => {
  afterAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('у каждой заготовки переведены все её поля, без кириллицы', () => {
    const problems = HOOK_PRESETS.flatMap((preset) => {
      const fields: Array<'title' | 'description' | 'message'> = [
        'title',
        'description',
        ...(preset.message ? (['message'] as const) : []),
      ];
      return fields.flatMap((field) => {
        const text = presetsEn.hook[preset.id]?.[field];
        if (!text?.trim()) return [`${preset.id}.${field}: нет перевода`];
        return CYRILLIC.test(text) ? [`${preset.id}.${field}: кириллица`] : [];
      });
    });
    expect(problems).toEqual([]);
  });

  it('в словаре нет ключей без заготовки', () => {
    const known = new Set(HOOK_PRESETS.map((preset) => preset.id));
    expect(Object.keys(presetsEn.hook).filter((id) => !known.has(id))).toEqual([]);
  });

  it('en: сообщение заготовки — английское, ru — своё', async () => {
    const preset = HOOK_PRESETS.find((item) => item.message)!;
    const t = (key: string, options: { defaultValue: string }) => i18n.t(key, options);

    await i18n.changeLanguage('en');
    const english = presetText(t, 'hook', preset.id, 'message', preset.message!);
    expect(english).not.toMatch(CYRILLIC);
    expect(english).toBe(presetsEn.hook[preset.id]!.message);

    await i18n.changeLanguage('ru');
    expect(presetText(t, 'hook', preset.id, 'message', preset.message!)).toBe(preset.message);
  });
});
