import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { SplitHumanSteps } from './SplitHumanSteps';

/**
 * «Сделать человеку» свёрнут по умолчанию (владелец 22.10.2026): четырнадцать
 * шагов занимали хаб целиком. Проверяется разметка самого компонента.
 */

const step = {
  action: 'Выставить зависимость MR !808 от !789',
  where: 'https://git.example/p/-/merge_requests/808',
  why: 'операции нет в инструментах',
  at: '2026-09-25T10:30:00.000Z',
};
const groups = [
  { index: 0, title: 'Группа 0', status: 'done', humanSteps: [step] },
  { index: 1, title: 'Группа 1', status: 'done', humanSteps: [{ ...step, why: 'нужна мне' }] },
] as unknown as SplitPlanView['groups'];

const stepsIn = (html: string): number => html.match(/data-split-human-step(?!s)/g)?.length ?? 0;

describe('«Сделать человеку» — сворачивание', () => {
  it('по умолчанию свёрнут: заголовок-переключатель закрыт, шагов нет', () => {
    const html = renderToStaticMarkup(<SplitHumanSteps groups={groups} />);

    expect(html).toContain('data-split-human-steps="1"');
    expect(html).toContain('aria-expanded="false"');
    expect(stepsIn(html)).toBe(0);
    expect(html).not.toContain(step.action);
  });

  it('раскрытый показывает шаг одной строкой на обе группы', () => {
    const html = renderToStaticMarkup(<SplitHumanSteps groups={groups} defaultExpanded />);

    expect(html).toContain('aria-expanded="true"');
    expect(stepsIn(html)).toBe(1);
    expect(html).toContain(step.action);
  });
});
