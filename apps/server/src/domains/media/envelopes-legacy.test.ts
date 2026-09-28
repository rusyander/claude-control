import { describe, expect, it } from 'vitest';
import { mediaRequestOf } from '@agentdeck/contracts/media-block';
import { legacyBlockLang } from '@agentdeck/contracts/brand';

/**
 * Ревью 28.09 (F-329): прежний русский конверт собирался с НЫНЕШНЕЙ меткой
 * блока (`agentdeck:deck`), а просьбы, сохранённые 14.09–17.09, несут метку
 * под прежним именем — они не узнавались, и лента звала их первой строкой
 * правил. Тексты — ровно как их писала панель тех дней.
 */
describe('старый конверт под прежним именем метки', () => {
  it('колода', () => {
    const text = `rules\n\nГотовый ответ — РОВНО ОДИН блок кода с языком ${legacyBlockLang('deck')}, внутри — тот самый JSON.\n\nТема: Кот на окне`;
    expect(mediaRequestOf(text)).toEqual({ kind: 'deck', topic: 'Кот на окне' });
  });

  it('рисунок', () => {
    const text = `rules\n\nОтвет — РОВНО ОДИН блок кода с языком ${legacyBlockLang('svg')}.\n\nРисунок: кот`;
    expect(mediaRequestOf(text)).toEqual({ kind: 'picture', topic: 'кот' });
  });
});
