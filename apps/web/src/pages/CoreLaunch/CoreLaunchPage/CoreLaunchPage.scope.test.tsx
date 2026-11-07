import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// React не поднимается (окружение node): страница вызывается как функция, состояние живёт между
// «рендерами» по порядку вызова, как у смонтированного компонента.
let cells: unknown[] = [];
let at = 0;
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const i = at++;
    if (!(i in cells)) cells[i] = initial;
    const set = (next: unknown) => {
      cells[i] = typeof next === 'function' ? (next as (v: unknown) => unknown)(cells[i]) : next;
    };
    return [cells[i], set];
  },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { CoreLaunchPage } = await import('./CoreLaunchPage');
const { CoreLaunchScreen, LeadBlock } = await import('@features/CoreLaunch');

/** Свойства первого элемента этого типа в дереве страницы. */
function propsOf(node: ReactNode, type: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child as ReactNode, type);
      if (found) return found;
    }
    return undefined;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === type) return element.props;
  return propsOf(element.props.children as ReactNode, type);
}

const render = () => {
  at = 0;
  return CoreLaunchPage();
};

/**
 * «Настроить для этого проекта» на оценке ведущего (этап 11): область карточки «Ведение задачи»
 * становится этим проектом, проект попадает в список виденных один раз, а страница прокручивается
 * к блоку ведения — область живёт на странице, над экраном запуска и блоком ведения.
 */
describe('CoreLaunchPage — область ведения', () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    cells = [];
    vi.stubGlobal('document', {
      querySelector: (selector: string) =>
        selector === '[data-lead-block]' ? { scrollIntoView } : null,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('проект с оценки ставит область ведения, виденные — без повторов, прокрутка к блоку', () => {
    expect(propsOf(render(), LeadBlock)).toMatchObject({ scope: '', seen: [] });

    const onLeadScope = propsOf(render(), CoreLaunchScreen)?.onLeadScope as (key: string) => void;
    onLeadScope('repo-a');
    onLeadScope('repo-b');
    onLeadScope('repo-a');

    expect(propsOf(render(), LeadBlock)).toMatchObject({
      scope: 'repo-a',
      seen: ['repo-a', 'repo-b'],
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  });

  it('область, выбранная в самом блоке ведения, доходит до него', () => {
    (propsOf(render(), LeadBlock)?.onScope as (key: string) => void)('repo-z');
    expect(propsOf(render(), LeadBlock)?.scope).toBe('repo-z');
  });
});
