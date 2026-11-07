import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';
import type { LaunchDraft } from '../../model/launch.types';
import { emptyDraft } from '../../model/launchDraft';

// React не поднимается (окружение node): форма вызывается как функция, состояние живёт между
// «рендерами» по порядку вызова, как у смонтированного компонента.
let cells: unknown[] = [];
let at = 0;
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const i = at++;
    if (!(i in cells))
      cells[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    const set = (next: unknown) => {
      cells[i] = typeof next === 'function' ? (next as (v: unknown) => unknown)(cells[i]) : next;
    };
    return [cells[i], set];
  },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ru' } }),
}));
// Список сценариев ядра — запрос по сети; форме хватает пустого.
vi.mock('../../api/launchApi', () => ({
  useScenarioListing: () => ({ data: undefined, isLoading: false, isError: false }),
}));

const { LaunchForm } = await import('./LaunchForm');

/** Первый элемент дерева, чьи свойства подходят под условие. */
function find(
  node: ReactNode,
  match: (props: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found: Record<string, unknown> | undefined = find(child as ReactNode, match);
      if (found) return found;
    }
    return undefined;
  }
  const props = (node as ReactElement<Record<string, unknown>>).props;
  if (match(props)) return props;
  return find(props.children as ReactNode, match);
}

const onEstimate = vi.fn<(fields: EstimateFields) => void>();
const render = (initial: Partial<LaunchDraft>) => {
  at = 0;
  return LaunchForm({ pending: false, retrying: false, onEstimate, initial });
};
// Кнопка запускает отправку без ожидания (`void submit()`), а отпечаток источника считает
// crypto.subtle вне потока — под нагрузкой дольше одного макротаска; тесты ждут исход отправки.
const submit = (initial: Partial<LaunchDraft>) => {
  const button = find(render(initial), (p) => p['data-estimate-button'] === true);
  (button?.onClick as () => void)();
};
const pickerProblem = (initial: Partial<LaunchDraft>) =>
  find(render(initial), (p) => 'problem' in p && typeof p.onDraft === 'function')?.problem;

const REPO = [{ path: 'C:/work/app', baseRef: '' }];

/**
 * Источник задачи на форме запуска (этап 11): задача из трекера, голосом или пунктами. Оценка
 * уходит с источником, а требования, которых человек не набрал, берутся из его тела; нечего
 * отправить — форма называет проблему источника кодом, и оценка не уходит.
 */
describe('LaunchForm — источник задачи', () => {
  beforeEach(() => {
    cells = [];
    onEstimate.mockClear();
  });

  it('пункты группой без набранных требований — оценка уходит с пунктами, требования из их тел', async () => {
    const initial: Partial<LaunchDraft> = {
      title: 'Группа правок',
      repos: REPO,
      source: {
        ...emptyDraft().source,
        mode: 'items',
        itemsAs: 'group',
        items: [
          { title: 'Кнопка', body: 'поправить кнопку', at: 1 },
          { title: '', body: '   ', at: 2 },
          { title: '', body: 'обновить справку', at: 3 },
        ],
      },
    };
    submit(initial);

    await vi.waitFor(() => expect(onEstimate).toHaveBeenCalledTimes(1));
    const fields = onEstimate.mock.calls[0]?.[0] as EstimateFields & {
      sources?: Array<{ kind: string; body: string; title?: string }>;
    };
    expect(fields.request).toBe('поправить кнопку\n\nобновить справку');
    expect(fields.sources?.map((s) => [s.kind, s.title, s.body])).toEqual([
      ['group-item', 'Кнопка', 'поправить кнопку'],
      ['group-item', undefined, 'обновить справку'],
    ]);
  });

  it('трекер без прочитанной задачи — проблема источника кодом, оценка не уходит', async () => {
    const initial: Partial<LaunchDraft> = {
      title: 'T',
      request: 'r',
      repos: REPO,
      source: { ...emptyDraft().source, mode: 'tracker', trackerKey: 'PROJ-12' },
    };
    expect(pickerProblem(initial)).toBeUndefined();
    submit(initial);

    await vi.waitFor(() => expect(pickerProblem(initial)).toBe('tracker-unread'));
    expect(onEstimate).not.toHaveBeenCalled();
  });
});
