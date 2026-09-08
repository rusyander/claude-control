import { describe, expect, it } from 'vitest';
import type { ProjectTestGroup, ProjectTestPlan } from '@agentdeck/contracts';
import {
  attributeProblem,
  plansUsingEnvironment,
  sharedStepUsage,
  sortEnvironments,
} from './testSettings';

/**
 * Счёт окна настроек: он решает, что человек увидит перед удалением.
 *
 * Проверяется ровно то, из-за чего удаление становится молчаливым: ссылка на
 * общий шаг живёт в `ref`, а не в тексте шага, и план ссылается на окружение
 * списком.
 */
describe('features/ProjectTests/testSettings', () => {
  /** Кейс ровно с теми полями, которые читает счёт: остальное здесь шум. */
  const testCase = (
    id: string,
    steps: { action: string; ref?: string }[],
  ): ProjectTestGroup['cases'][number] => ({
    id,
    title: id,
    type: 'case',
    source: 'human',
    status: 'unknown',
    steps,
  });

  const group = (cases: ProjectTestGroup['cases']): ProjectTestGroup => ({
    id: 'gui',
    title: 'Интерфейс',
    file: '.agent/tests/gui.tests.json',
    cases,
  });

  it('общий шаг считается по ссылкам, а не по подписям', () => {
    const usage = sharedStepUsage([
      group([
        testCase('gui-001', [{ action: 'Войти', ref: 'login' }, { action: 'Открыть отчёт' }]),
        // Тот же шаг дважды в одном кейсе — это всё равно ОДИН кейс.
        testCase('gui-002', [
          { action: 'Войти', ref: 'login' },
          { action: 'Войти ещё раз', ref: 'login' },
        ]),
        testCase('gui-003', [{ action: 'Войти' }]),
      ]),
    ]);

    expect(usage.get('login')).toBe(2);
    expect(usage.get('logout')).toBeUndefined();
  });

  it('сломанная группа в счёт не идёт: её кейсы не прочитаны', () => {
    const broken: ProjectTestGroup = {
      id: 'api',
      title: 'API',
      file: '.agent/tests/api.tests.json',
      cases: [],
      error: 'Файл не разобрался',
    };
    expect(sharedStepUsage([broken]).size).toBe(0);
  });

  it('план, ссылающийся на окружение, находится до удаления', () => {
    const plans: ProjectTestPlan[] = [
      { id: 'smoke', title: 'Дым', environmentIds: ['stand'] },
      { id: 'full', title: 'Полный', environmentIds: ['prod'] },
      { id: 'any', title: 'Без окружения' },
    ];
    expect(plansUsingEnvironment(plans, 'stand').map((item) => item.title)).toEqual(['Дым']);
    expect(plansUsingEnvironment(plans, 'dev')).toEqual([]);
  });

  it('своё поле проверяется до отправки: ключ, повтор и выбор без вариантов', () => {
    const existing = [{ key: 'stand', title: 'Стенд', type: 'text' as const }];

    expect(attributeProblem({ key: 'Своё поле', title: '', type: 'text' }, existing)).toBe('key');
    expect(attributeProblem({ key: 'stand', title: '', type: 'text' }, existing)).toBe('duplicate');
    // Правка того же поля повтором не считается — иначе его нельзя переименовать.
    expect(attributeProblem({ key: 'stand', title: '', type: 'text' }, existing, 'stand')).toBe(
      undefined,
    );
    expect(
      attributeProblem({ key: 'level', title: '', type: 'select', options: [] }, existing),
    ).toBe('options');
    expect(
      attributeProblem({ key: 'level', title: '', type: 'select', options: ['A'] }, existing),
    ).toBe(undefined);
  });

  it('окружения: сначала по умолчанию, архив внизу', () => {
    const order = sortEnvironments([
      { id: 'old', title: 'Старый', archived: true },
      { id: 'b', title: 'Бета' },
      { id: 'stand', title: 'Стенд', isDefault: true },
    ]).map((item) => item.id);

    expect(order).toEqual(['stand', 'b', 'old']);
  });
});
