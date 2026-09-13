import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@agentdeck/contracts';
import type { PlatformModelChoice } from '@agentdeck/contracts/platform-models';
import {
  modelLabel,
  MODEL_OPTIONS,
  EFFORT_LEVELS,
  modelSelectOptions,
  platformLayersCaption,
  platformModelCaption,
  withCurrentValue,
} from './index';

/**
 * Константы и подпись выбора модели/глубины продумывания. Мелочь, но подпись
 * рисуется в шапке чата, а пустое значение («по умолчанию») не должно
 * превращаться в «U» или падать.
 */
describe('modelLabel', () => {
  it('делает первую букву заглавной', () => {
    expect(modelLabel('opus')).toBe('Opus');
    expect(modelLabel('sonnet')).toBe('Sonnet');
    expect(modelLabel('haiku')).toBe('Haiku');
  });

  it('пустая строка (по умолчанию) остаётся пустой', () => {
    expect(modelLabel('')).toBe('');
  });
});

describe('список выбора модели', () => {
  const model = (id: string, name: string): ModelInfo => ({
    id,
    name,
    family: 'claude-opus',
    vendor: 'anthropic',
  });

  const options = (models: ModelInfo[]): Array<{ value: string; label: string }> =>
    modelSelectOptions(models, MODEL_OPTIONS, (value) => value || 'как выберет CLI');

  it('алиасы идут первыми, конкретные модели — следом и подписаны id', () => {
    const result = options([model('claude-opus-5', 'Claude Opus 5')]);

    expect(result.slice(0, 3)).toEqual([
      { value: '', label: 'как выберет CLI' },
      { value: 'fable', label: 'fable' },
      { value: 'opus', label: 'opus' },
    ]);
    expect(result.at(-1)).toEqual({
      value: 'claude-opus-5',
      label: 'Claude Opus 5 · claude-opus-5',
    });
  });

  it('пропавшая у контура модель в выбор не попадает', () => {
    // В карточке каталога она остаётся объяснением («была, больше нет») и
    // кнопки «сделать по умолчанию» не имеет. Выбор дефолта пишет ровно ту же
    // настройку — запрет, который держится в одном из двух мест, не запрет.
    const result = options([
      model('claude-opus-5', 'Claude Opus 5'),
      { ...model('ru-embed', 'ru-embed'), retired: true, lastSeenAt: '2026-09-01' },
    ]);

    expect(result.some((option) => option.value === 'ru-embed')).toBe(false);
  });

  it('уже выбранная пропавшая модель из поля не исчезает', () => {
    // Иначе поле покажет чужое значение вместо того, что реально в настройках.
    const shown = withCurrentValue(
      options([{ ...model('ru-embed', 'ru-embed'), retired: true }]),
      'ru-embed',
    );

    expect(shown.at(-1)).toEqual({ value: 'ru-embed', label: 'ru-embed' });
  });

  it('модель, совпавшая с алиасом, не задваивается', () => {
    const result = options([model('opus', 'Opus')]);

    expect(result.filter((option) => option.value === 'opus')).toHaveLength(1);
  });

  it('выбранная модель остаётся в списке, даже когда каталог не скачался', () => {
    const withPinned = withCurrentValue(options([]), 'claude-opus-4-8');

    expect(withPinned.at(-1)).toEqual({ value: 'claude-opus-4-8', label: 'claude-opus-4-8' });
    // Уже присутствующее значение не дублируется, пустое не добавляется.
    expect(withCurrentValue(options([]), 'opus')).toHaveLength(MODEL_OPTIONS.length);
    expect(withCurrentValue(options([]), '')).toHaveLength(MODEL_OPTIONS.length);
  });
});

describe('константы выбора', () => {
  it('первый вариант модели — пустой (как выберет Claude)', () => {
    expect(MODEL_OPTIONS[0]).toBe('');
    expect(MODEL_OPTIONS).toContain('opus');
    // Верхняя ступень лестницы: без неё потолок на неё не поставить иначе как
    // конкретным id из каталога.
    expect(MODEL_OPTIONS).toContain('fable');
  });

  it('первый уровень effort — пустой (по умолчанию)', () => {
    expect(EFFORT_LEVELS[0]).toBe('');
    expect(EFFORT_LEVELS).toContain('max');
  });
});

/**
 * Подпись «чем прогон пойдёт через контур» — одна на обе шапки. Ревью Т6 нашло
 * здесь разрыв: подпись выбиралась по одному признаку `replaced`, и контур без
 * модели объявлял подмену, которой не происходит, с прочерком вместо имени.
 */
describe('подпись модели через контур', () => {
  const choice = (over: Partial<PlatformModelChoice>): PlatformModelChoice => ({
    model: 'enterprise-platform-mid',
    asked: '',
    source: 'default',
    replaced: false,
    ...over,
  });

  it('обычный случай — просто называет модель, без тревоги', () => {
    expect(platformModelCaption('EnterprisePlatform · dev', choice({}))).toEqual({
      key: 'chat.platformModel',
      params: { title: 'EnterprisePlatform · dev', asked: '', model: 'enterprise-platform-mid' },
      warn: false,
    });
  });

  it('подмена названа и подсвечена', () => {
    const caption = platformModelCaption(
      'EnterprisePlatform · dev',
      choice({ asked: 'sonnet', replaced: true }),
    );
    expect(caption).toMatchObject({ key: 'chat.platformModelReplaced', warn: true });
  });

  it('у контура нет модели — своя строка, а не подмена с прочерком', () => {
    const caption = platformModelCaption(
      'EnterprisePlatform · dev',
      choice({ model: 'sonnet', asked: 'sonnet', source: 'none' }),
    );
    expect(caption).toMatchObject({ key: 'chat.platformModelUnset', warn: true });
  });
});

/**
 * Подпись о снятых слоях (Т8). Считает их сервер — здесь проверяется выбор
 * слов: молчание там, где сказать нечего, и отдельная строка на «не едет
 * ничего», потому что перечислять все четыре слоя человеку незачем.
 */
describe('подпись о наших слоях', () => {
  it('ничего не снято — шапка молчит', () => {
    expect(platformLayersCaption({ args: [], systemPrompt: true, dropped: [] })).toBeUndefined();
  });

  it('прогон ведёт не Claude — поля нет вовсе, и подписи тоже', () => {
    expect(platformLayersCaption(undefined)).toBeUndefined();
  });

  it('снятое называется поимённо', () => {
    expect(
      platformLayersCaption({
        args: ['--disable-slash-commands'],
        systemPrompt: true,
        dropped: ['skills'],
      }),
    ).toEqual({ key: 'chat.platformLayers', dropped: ['skills'] });
  });

  it('снято всё — своя строка, а не перечисление из четырёх', () => {
    expect(
      platformLayersCaption({
        args: ['--setting-sources', 'project,local'],
        systemPrompt: false,
        dropped: ['settings', 'skills', 'mcp', 'systemPrompt'],
      }),
    ).toMatchObject({ key: 'chat.platformLayersAll' });
  });
});
