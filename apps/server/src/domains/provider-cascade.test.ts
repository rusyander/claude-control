import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@agentdeck/contracts';
import { KIND_PLAN, TASK_KINDS } from '@agentdeck/contracts/model-cascade';
import { planForeignAssignment, type CascadeProvider } from './provider-cascade.ts';
import { getProvider } from '../providers/registry.ts';

/**
 * Подбор модели у чужого провайдера. Главное, что здесь проверяется, — граница
 * fail-closed: панель либо называет конкретную модель СВОЕГО вендора, либо не
 * говорит ничего и оставляет прогон настройке пользователя.
 */

const model = (id: string, family: string, releaseDate: string): ModelInfo =>
  ({ id, name: id, family, releaseDate }) as ModelInfo;

const CATALOG: ModelInfo[] = [
  model('gpt-5.3-codex-spark', 'gpt-codex-spark', '2026-02-12'),
  model('gpt-5.1-codex', 'gpt-codex', '2025-11-13'),
  model('gpt-5.3-codex', 'gpt-codex', '2026-02-05'),
  model('gpt-5.5', 'gpt', '2026-04-23'),
];

const codex: CascadeProvider = {
  modelLadder: ['gpt-codex-spark', 'gpt-codex'],
  assistant: { apiKind: 'openai', apiKeyEnvVars: [], cliRunnable: true, oneShotArgs: (p) => [p] },
};

describe('planForeignAssignment', () => {
  it('механике даёт младшую ступень лестницы, свежайшую в семействе', () => {
    expect(planForeignAssignment(codex, CATALOG, { kind: 'mechanical', tasks: 2 })).toEqual({
      model: 'gpt-5.3-codex-spark',
      effort: 'medium',
      kind: 'mechanical',
      lowered: true,
    });
  });

  it('понятной работе и тестам — старшую ступень, тоже последнего поколения', () => {
    // В семействе `gpt-codex` две модели: берётся та, что вышла позже, — иначе
    // понижение ступени молча уводило бы группу на прошлое поколение.
    for (const kind of ['implementation', 'tests']) {
      expect(planForeignAssignment(codex, CATALOG, { kind, tasks: 1 })).toEqual({
        model: 'gpt-5.3-codex',
        effort: 'high',
        kind,
        lowered: true,
      });
    }
  });

  it('большая группа механикой не считается — ступень и глубина поднимаются', () => {
    expect(planForeignAssignment(codex, CATALOG, { kind: 'mechanical', tasks: 6 })).toMatchObject({
      model: 'gpt-5.3-codex',
      effort: 'high',
      // Класс остаётся распознанным: поправка на размер меняет исполнителя, а не
      // род работы.
      kind: 'mechanical',
    });
    expect(
      planForeignAssignment(codex, CATALOG, { kind: 'mechanical', tasks: 1, length: 5000 }),
    ).toMatchObject({ model: 'gpt-5.3-codex' });
  });

  it('классу-потолку, незнакомому и неназванному не назначает ничего', () => {
    for (const kind of ['design', 'investigation', 'review', 'странное', '', undefined]) {
      expect(planForeignAssignment(codex, CATALOG, { ...(kind ? { kind } : {}), tasks: 1 })).toBe(
        undefined,
      );
    }
  });

  it('таблица ступеней согласована с таблицей классов контрактов', () => {
    // Два списка классов — в контрактах (алиасы Claude) и здесь (ступени чужой
    // лестницы). Совпадать они обязаны ровно в одном: где у Claude потолок, там
    // и у чужого CLI «ничего не передаём».
    for (const kind of TASK_KINDS) {
      const foreign = planForeignAssignment(codex, CATALOG, { kind, tasks: 1 });
      expect(Boolean(foreign)).toBe(Boolean(KIND_PLAN[kind]));
    }
  });

  it('без лестницы или без способа передать модель подбора нет', () => {
    expect(
      planForeignAssignment({ ...codex, modelLadder: undefined }, CATALOG, { kind: 'mechanical' }),
    ).toBe(undefined);
    expect(
      planForeignAssignment({ modelLadder: ['gpt-codex'] }, CATALOG, { kind: 'mechanical' }),
    ).toBe(undefined);
  });

  it('семейства нет в каталоге — молчим, а не подставляем что попало', () => {
    expect(planForeignAssignment(codex, [], { kind: 'mechanical' })).toBe(undefined);
    expect(
      planForeignAssignment({ ...codex, modelLadder: ['выдумка'] }, CATALOG, {
        kind: 'implementation',
      }),
    ).toBe(undefined);
  });

  it('лестница из одной ступени обслуживает все понижаемые классы', () => {
    const single: CascadeProvider = { ...codex, modelLadder: ['gpt-codex-spark'] };
    expect(planForeignAssignment(single, CATALOG, { kind: 'implementation' })).toMatchObject({
      model: 'gpt-5.3-codex-spark',
      effort: 'high',
    });
  });

  it('лестница объявлена ровно у тех провайдеров, чей CLI умеет принять модель', () => {
    // Инвариант каталога, а не этого модуля: лестница без флага молча никуда бы
    // не уехала, зато карточка показала бы человеку подобранную модель.
    for (const id of ['claude', 'codex', 'gemini', 'qwen', 'kimi', 'opencode', 'aider', 'goose']) {
      const provider = getProvider(id);
      if (!provider.modelLadder) continue;
      expect(provider.assistant?.oneShotArgs).toBeTypeOf('function');
      expect(provider.modelVendors?.length).toBeGreaterThan(0);
    }
    // Подбор есть у codex и gemini; у остальных его нет намеренно — причина у
    // каждого записана в его файле каталога.
    expect(getProvider('codex').modelLadder).toEqual(['gpt-codex-spark', 'gpt-codex']);
    expect(getProvider('gemini').modelLadder).toEqual(['gemini-flash-lite', 'gemini-flash']);
    for (const id of ['claude', 'qwen', 'kimi', 'opencode', 'aider', 'goose', 'continue']) {
      expect(getProvider(id).modelLadder).toBe(undefined);
    }
  });
});
