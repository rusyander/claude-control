import { describe, it, expect } from 'vitest';
import { blockLang } from '@agentdeck/contracts/brand';
import { scanPlanBlocks, scanSplitPlanBlocks } from '@agentdeck/contracts/split-plan';

/**
 * Что панель держит от уровней разделения после переезда разбора и плана в
 * ядро: чтение блоков разбора и плана для карточек в ленте старых разговоров.
 */

const SPLIT_PLAN_BLOCK_LANG = blockLang('split-plan');
const PLAN_BLOCK_LANG = blockLang('plan');

function block(lang: string, body: string): string {
  return ['```' + lang, body, '```'].join('\n');
}

function scanPlan(value: unknown) {
  return scanSplitPlanBlocks(block(SPLIT_PLAN_BLOCK_LANG, JSON.stringify(value))).plan;
}

describe('scanSplitPlanBlocks: терпимость к форме', () => {
  it('группы по номеру с единицы под разными ключами; hold строкой и объектом', () => {
    const plan = scanPlan({
      groups: [
        { index: 1, owns: ['src/login'], after: ['2'], hold: 'какой валидатор?' },
        { group: 2, files: 'src/header.tsx', hold: { question: 'цвет?' } },
        { n: '#3', dependsOn: [1, 2] },
      ],
      conflicts: [{ paths: ['src/api.ts'], resolvedBy: 1, why: 'она зовёт' }],
      order: [2, 1, 3],
    });

    expect(plan?.groups.map((group) => group.index)).toEqual([0, 1, 2]);
    expect(plan?.groups[0]).toMatchObject({ after: [1], hold: 'какой валидатор?' });
    expect(plan?.groups[1]).toMatchObject({ owns: ['src/header.tsx'], hold: 'цвет?' });
    expect(plan?.groups[2]?.after).toEqual([0, 1]);
    expect(plan?.conflicts[0]).toMatchObject({ resolvedBy: 0, why: 'она зовёт' });
    expect(plan?.order).toEqual([1, 0, 2]);
  });

  it('ссылка на себя, за пределы разделения и по названию отбрасывается, а не угадывается', () => {
    const plan = scanPlan({ groups: [{ index: 1, after: [1, 0, 31, 'Шапка'] }] });

    expect(plan?.groups[0]?.after).toEqual([]);
  });

  it('без единой узнаваемой группы блок не разобран', () => {
    expect(scanPlan({ groups: [{ index: 42 }, { title: 'Шапка' }] })).toBeUndefined();
  });
});

describe('scanSplitPlanBlocks', () => {
  it('разобранный блок уходит из показа, текст перед ним остаётся', () => {
    const scan = scanSplitPlanBlocks(
      `Пересекались в api.ts.\n\n${block(SPLIT_PLAN_BLOCK_LANG, JSON.stringify({ groups: [{ index: 1 }] }))}`,
    );

    expect(scan.text).toBe('Пересекались в api.ts.');
    expect(scan.plan?.groups).toHaveLength(1);
    expect(scan.rejected).toBe(0);
  });

  it('непонятый блок остаётся в тексте и считается', () => {
    const scan = scanSplitPlanBlocks(block(SPLIT_PLAN_BLOCK_LANG, '{ не json }'));

    expect(scan.plan).toBeUndefined();
    expect(scan.rejected).toBe(1);
    expect(scan.text).toContain('не json');
  });
});

describe('scanPlanBlocks: план с вложенными блоками кода', () => {
  it('закрывающей считается ПОСЛЕДНЯЯ кавычка: вложенный блок команд план не обрывает', () => {
    const plan = [
      '## Шаги',
      '1. Запустить проверку:',
      '```',
      'pnpm test',
      '```',
      '2. Поправить импорт.',
    ].join('\n');
    const scan = scanPlanBlocks(`Готово.\n\n${block(PLAN_BLOCK_LANG, plan)}`);

    expect(scan.plan).toContain('pnpm test');
    expect(scan.plan).toContain('Поправить импорт');
    expect(scan.text).toBe('Готово.');
  });

  it('недописанный блок прячется до конца, плана нет', () => {
    const scan = scanPlanBlocks('Вот план.\n\n```' + PLAN_BLOCK_LANG + '\n## Шаги\n1. ...');

    expect(scan.plan).toBeUndefined();
    expect(scan.text).toBe('Вот план.');
  });
});
