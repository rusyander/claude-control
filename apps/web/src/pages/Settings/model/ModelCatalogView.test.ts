import { describe, it, expect } from 'vitest';
import type { ModelCatalogResponse, ModelInfo, PlatformStatus } from '@agentdeck/contracts';
import {
  canPinModel,
  canUsePlatformSource,
  declaredFlags,
  emptyKey,
  formatContext,
  platformSourceOptions,
  showsPlatformSource,
  sourceLine,
  sourceValue,
  visibleModels,
  VISIBLE_MODELS,
} from './ModelCatalogView';

const models = (count: number): ModelInfo[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `model-${index}`,
    name: `Model ${index}`,
    family: 'f',
    vendor: 'v',
  }));

describe('карточка моделей', () => {
  it('до раскрытия показывает первую дюжину, после — весь список', () => {
    const all = models(30);

    expect(visibleModels(all, false)).toHaveLength(VISIBLE_MODELS);
    expect(visibleModels(all, true)).toHaveLength(30);
    // Коротким спискам раскрытие не нужно.
    expect(visibleModels(models(3), false)).toHaveLength(3);
  });

  it('окно контекста показывается человеческим числом', () => {
    expect(formatContext(1_000_000)).toBe('1M');
    expect(formatContext(200_000)).toBe('200K');
    expect(formatContext(1_500_000)).toBe('1.5M');
    expect(formatContext(512)).toBe('512');
  });

  it('неизвестный лимит не превращается в ноль', () => {
    expect(formatContext(undefined)).toBe('');
    expect(formatContext(0)).toBe('');
  });
});

/**
 * Выбор источника каталога и то, что карточка о нём говорит.
 *
 * Здесь живут решения, которые иначе оказались бы внутри компонента: тесты
 * фронта идут в окружении `node` и ничего не рендерят, а молчаливый откат на
 * другой источник — самая дорогая ошибка этого экрана.
 */
const catalog = (overrides: Partial<ModelCatalogResponse> = {}): ModelCatalogResponse => ({
  provider: 'claude',
  vendors: ['anthropic'],
  models: [],
  source: 'models.dev',
  requestedSource: 'models.dev',
  stale: false,
  url: 'https://models.dev/api.json',
  unsupported: false,
  newIds: [],
  ...overrides,
});

const status = (id: string, enabled: boolean, hasToken: boolean): PlatformStatus =>
  ({
    platform: { id, title: `Контур ${id}`, enabled },
    hasToken,
    maskedToken: '',
  }) as PlatformStatus;

describe('platformSourceOptions: предлагаем только то, что ответит', () => {
  it('выключенный и бесключевой в список не попадают', () => {
    const options = platformSourceOptions(
      [status('a', true, true), status('b', false, true), status('c', true, false)],
      '',
    );
    expect(options.map((o) => o.platform.id)).toEqual(['a']);
  });

  it('уже выбранный остаётся в списке даже негодным', () => {
    // Иначе он молча пропадает из поля, и человек не понимает, что выбрано.
    const options = platformSourceOptions([status('b', false, true)], 'b');
    expect(options.map((o) => o.platform.id)).toEqual(['b']);
  });

  it('контуров нет вовсе — источник «контур» предлагать нечем', () => {
    expect(canUsePlatformSource(undefined, '')).toBe(false);
    expect(canUsePlatformSource([], '')).toBe(false);
    expect(canUsePlatformSource([status('a', true, true)], '')).toBe(true);
  });

  it('выбранный источником контур из ПОЛЯ не исчезает, даже когда годных не осталось', () => {
    // Контур выключили уже после того, как его выбрали источником, а «какой
    // контур» остался пустым. Убрав строку, поле показало бы models.dev при
    // сохранённом `platform` — враньё о выбранном прямо над предупреждением.
    expect(showsPlatformSource(false, 'platform')).toBe(true);
    expect(showsPlatformSource(false, 'models.dev')).toBe(false);
    expect(showsPlatformSource(true, 'models.dev')).toBe(true);
  });
});

describe('emptyKey: пусто у контура и пусто у models.dev — разные беды', () => {
  it('контур ответил пустым списком — это ответ про права ключа, а не про связь', () => {
    expect(emptyKey(catalog({ source: 'platform', requestedSource: 'platform' }))).toBe(
      'models.emptyPlatform',
    );
  });

  it('открытый каталог не скачался — прежняя строка про молчащий источник', () => {
    expect(emptyKey(catalog({ source: 'none' }))).toBe('models.empty');
    expect(emptyKey(catalog({ source: 'models.dev' }))).toBe('models.empty');
  });
});

describe('sourceLine: откат никогда не молчит', () => {
  it('причина отката бьёт и источник, и дату — строка становится предупреждением', () => {
    const line = sourceLine(
      catalog({ requestedSource: 'platform', fallback: 'platform-off', platformTitle: 'Контур' }),
      '10.09.2026',
    );

    expect(line.key).toBe('models.fallback.platform-off');
    expect(line.params.platform).toBe('Контур');
    expect(line.warning).toBe(true);
  });

  it('у отката без имени контура подставляется идентификатор', () => {
    const line = sourceLine(
      catalog({ requestedSource: 'platform', fallback: 'platform-gone', platformId: 'gone' }),
      '',
    );
    expect(line.params.platform).toBe('gone');
  });

  it('контур ответил — строка про контур, а не про models.dev', () => {
    const line = sourceLine(
      catalog({ source: 'platform', requestedSource: 'platform', platformTitle: 'Контур' }),
      '10.09.2026',
    );

    expect(line.key).toBe('models.sourcePlatform');
    expect(line.warning).toBe(false);
  });

  it('источник ни разу не отвечал — своя строка, а не пустая подпись', () => {
    expect(sourceLine(catalog({ source: 'none' }), '').key).toBe('models.noSource');
  });
});

describe('canPinModel: что можно сделать дефолтом', () => {
  it('пропавшую у контура — нельзя: контур такой запрос уже не примет', () => {
    const platform = catalog({ source: 'platform', requestedSource: 'platform' });
    expect(
      canPinModel(platform, { id: 'a', name: 'a', family: '', vendor: 'g', retired: true }),
    ).toBe(false);
  });

  it('живую модель контура — можно', () => {
    const platform = catalog({ source: 'platform', requestedSource: 'platform' });
    expect(canPinModel(platform, { id: 'a', name: 'a', family: '', vendor: 'g' })).toBe(true);
  });

  it('на models.dev дефолт остаётся настройкой Claude', () => {
    const model = { id: 'a', name: 'a', family: '', vendor: 'openai' };
    expect(canPinModel(catalog({ provider: 'codex' }), model)).toBe(false);
    expect(canPinModel(catalog({ provider: 'claude' }), model)).toBe(true);
  });
});

describe('declaredFlags: показываем объявленное, включая объявленное «нет»', () => {
  it('невыясненного флага на экране нет вовсе', () => {
    expect(declaredFlags({ id: 'a', name: 'a', family: '', vendor: 'g' })).toEqual([]);
  });

  it('объявленное `false` показывается — это знание, а не молчание', () => {
    const flags = declaredFlags({
      id: 'a',
      name: 'a',
      family: '',
      vendor: 'g',
      vision: false,
      jsonMode: true,
    });

    expect(flags).toEqual([
      { key: 'vision', on: false },
      { key: 'jsonMode', on: true },
    ]);
  });
});

describe('sourceValue: чужая строка в настройку не проходит', () => {
  it('всё, что не «platform», считается открытым каталогом', () => {
    expect(sourceValue('platform')).toBe('platform');
    expect(sourceValue('models.dev')).toBe('models.dev');
    expect(sourceValue('что-то ещё')).toBe('models.dev');
  });
});
