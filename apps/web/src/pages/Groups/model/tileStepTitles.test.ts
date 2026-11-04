import { describe, expect, it } from 'vitest';
import type { Group } from '@agentdeck/contracts';
import { tileStepTitles } from './tileStepTitles';

const step = (ru: string, en: string) =>
  ({ id: `s-${ru}`, title: { ru, en } }) as unknown as NonNullable<Group['path']>['steps'][number];

describe('tileStepTitles — шаги карточки прежней группы', () => {
  it('свой «Путь»: заголовок на языке интерфейса, пустой — другого языка', () => {
    const group = { path: { steps: [step('Сборка', 'Build'), step('', 'Review')] } };
    expect(tileStepTitles(group, 'ru')).toEqual({ titles: ['Сборка', 'Review'], more: 0 });
    expect(tileStepTitles(group, 'en')).toEqual({ titles: ['Build', 'Review'], more: 0 });
  });

  it('больше трёх — три словами и остаток числом', () => {
    const group = { path: { steps: ['a', 'b', 'c', 'd', 'e'].map((x) => step(x, x)) } };
    expect(tileStepTitles(group, 'ru')).toEqual({ titles: ['a', 'b', 'c'], more: 2 });
  });

  it('без «Пути» — старый «Порядок работы»; без обоих — пусто', () => {
    const scenario = { steps: [{ title: 'План' }, { title: ' ' }] } as unknown as Group['scenario'];
    expect(tileStepTitles({ scenario }, 'ru')).toEqual({ titles: ['План'], more: 0 });
    expect(tileStepTitles({}, 'ru')).toEqual({ titles: [], more: 0 });
  });
});
