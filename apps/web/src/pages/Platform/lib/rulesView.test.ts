import { describe, it, expect } from 'vitest';
import type { Platform, PlatformRuleConflict, PlatformRuleRow } from '@agentdeck/contracts';
import {
  blockingConflict,
  conflictTone,
  layerOn,
  managedRules,
  observedRules,
  ourRules,
  parseToolNames,
  platformRules,
  withOurRule,
  withRule,
} from './rulesView';

/**
 * Карточка правил контура (Т7): что она раскладывает и что отправляет назад.
 *
 * Смысл правил тут не проверяется — его считает сервер. Проверяется ровно то,
 * что карточка делает сама: деление на два списка (иначе видимое правило
 * выглядело бы настройкой, которой почему-то нельзя пользоваться), разбор имён
 * инструментов руками человека и сборка настройки без потери соседних полей.
 */

const row = (patch: Partial<PlatformRuleRow>): PlatformRuleRow => ({
  id: 'x',
  title: 'Правило',
  detail: 'что делает',
  kind: 'request',
  value: '',
  where: '',
  ...patch,
});

const conflict = (patch: Partial<PlatformRuleConflict>): PlatformRuleConflict => ({
  id: 'tools',
  level: 'exclusive',
  platformRule: 'enterprise-platform_tools',
  ourRule: 'toolShim',
  title: 'Инструменты',
  detail: 'выберите один',
  active: false,
  ...patch,
});

const PLATFORM = {
  id: 'enterprise-platform-dev',
  toolShim: true,
  rules: {
    platform: {
      platformTools: ['web_search'],
      toolMode: 'loop' as const,
      generationPreset: 'balanced',
      enableThinking: 'default' as const,
    },
  },
} as unknown as Platform;

describe('два списка правил', () => {
  it('управляемое — с полем настройки, видимое — без него', () => {
    const rows = [
      row({ id: 'a', field: 'platformTools' }),
      row({ id: 'b', kind: 'observed', where: 'включает владелец' }),
      // Ручка, объявленная задаваемой, но без поля настройки, — это рассказ, а
      // не настройка: в верхний список она попасть не должна.
      row({ id: 'c' }),
    ];
    expect(managedRules(rows).map((item) => item.id)).toEqual(['a']);
    expect(observedRules(rows).map((item) => item.id)).toEqual(['b', 'c']);
  });
});

describe('цвет и блокировка', () => {
  it('красное — только взаимное исключение', () => {
    expect(conflictTone('exclusive')).toBe('danger');
    expect(conflictTone('warning')).toBe('warning');
    expect(conflictTone('info')).toBe('info');
  });

  it('мешает сохранению только включённое с обеих сторон исключение', () => {
    expect(
      blockingConflict([conflict({}), conflict({ id: 'x', level: 'warning' })]),
    ).toBeUndefined();
    expect(blockingConflict([conflict({ active: true })])?.id).toBe('tools');
    // Активное предупреждение сохранению не мешает: оно не запрет.
    expect(
      blockingConflict([conflict({ id: 'c', level: 'warning', active: true })]),
    ).toBeUndefined();
  });
});

describe('имена инструментов из строки', () => {
  it('принимает запятые, пробелы и переносы, выбрасывая пустое', () => {
    expect(parseToolNames(' web_search,  code_interpreter \n rag ')).toEqual([
      'web_search',
      'code_interpreter',
      'rag',
    ]);
  });

  it('регистр и порядок сохраняются: это чужие идентификаторы', () => {
    expect(parseToolNames('WebSearch, rag')).toEqual(['WebSearch', 'rag']);
  });

  it('пустая строка — пустой список, а не список с пустым именем', () => {
    expect(parseToolNames('   ')).toEqual([]);
  });
});

/**
 * Ответ без правил приносит не сервер, а рассинхрон версий: панель на диске
 * новее запущенного сервера, развёрнутый архив чужой машины, старый телефон.
 * Найдено живым прогоном `tools/qa/check-platform.mjs`: карточка на такой записи
 * падала и уносила с экрана ВЕСЬ раздел — человек видел пустую страницу вместо
 * одного пустого списка.
 */
describe('запись без правил', () => {
  const older = { id: 'enterprise-platform-dev', toolShim: true } as unknown as Platform;

  it('правила подставляются умолчанием, а не роняют карточку', () => {
    expect(platformRules(older)).toEqual({
      platformTools: [],
      toolMode: 'loop',
      generationPreset: '',
      enableThinking: 'default',
    });
  });

  it('списки и матрица без ответа — пустые, а не исключение', () => {
    expect(managedRules(undefined)).toEqual([]);
    expect(observedRules(undefined)).toEqual([]);
    expect(blockingConflict(undefined)).toBeUndefined();
  });

  it('правка такой записи собирает полную настройку, а не одно поле', () => {
    expect(withRule(older, 'enableThinking', 'off').rules.platform).toEqual({
      platformTools: [],
      toolMode: 'loop',
      generationPreset: '',
      enableThinking: 'off',
    });
  });
});

/**
 * Наши слои (Т8). Что какой флаг снимает, проверяет сервер и живая проба; здесь
 * — ровно то, что делает карточка: показать действующее состояние галочки и
 * собрать настройку, не потеряв соседние слои.
 */
describe('наши слои', () => {
  const withLayers = (patch: Record<string, boolean>): Platform =>
    ({
      ...PLATFORM,
      rules: {
        ...PLATFORM.rules,
        ours: {
          enabled: true,
          settings: true,
          skills: true,
          mcp: true,
          systemPrompt: true,
          ...patch,
        },
      },
    }) as unknown as Platform;

  it('записи без слоёв не роняют карточку — едет всё наше', () => {
    expect(ourRules(PLATFORM)).toEqual({
      enabled: true,
      settings: true,
      skills: true,
      mcp: true,
      systemPrompt: true,
    });
  });

  it('общий выключатель сильнее частной галочки', () => {
    const off = ourRules(withLayers({ enabled: false }));
    expect(layerOn(off, 'skills')).toBe(false);
    // И наоборот: снятая частная не уносит соседние.
    const skills = ourRules(withLayers({ skills: false }));
    expect(layerOn(skills, 'skills')).toBe(false);
    expect(layerOn(skills, 'mcp')).toBe(true);
  });

  it('правка слоя не теряет ни соседний слой, ни правила контура', () => {
    const next = withOurRule(withLayers({}), 'mcp', false);
    expect(next.rules.ours).toEqual({
      enabled: true,
      settings: true,
      skills: true,
      mcp: false,
      systemPrompt: true,
    });
    expect(next.rules.platform.platformTools).toEqual(['web_search']);
  });

  it('первая же правка записи без слоёв записывает их целиком', () => {
    // Иначе в настройку уехал бы объект из одного поля, и остальные слои
    // достались бы умолчанию схемы молча — включёнными после того, как человек
    // снял общий выключатель.
    expect(withOurRule(PLATFORM, 'enabled', false).rules.ours).toEqual({
      enabled: false,
      settings: true,
      skills: true,
      mcp: true,
      systemPrompt: true,
    });
  });
});

describe('сборка настройки', () => {
  it('меняет одно правило и не теряет соседние', () => {
    const next = withRule(PLATFORM, 'enableThinking', 'off');
    expect(next.rules.platform).toEqual({
      platformTools: ['web_search'],
      toolMode: 'loop',
      generationPreset: 'balanced',
      enableThinking: 'off',
    });
    // Исходная настройка не тронута: карточка отправляет копию, а не правит
    // объект, которым react-query отдаёт состояние списка.
    expect(PLATFORM.rules.platform.enableThinking).toBe('default');
  });
});
