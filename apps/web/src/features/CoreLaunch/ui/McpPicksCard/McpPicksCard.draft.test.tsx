import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { ConfigView } from '@agentdeck/contracts/core/config';
import type { McpOffersReply } from '@agentdeck/contracts/core/panel-api';
import type { PicksDraft } from '../../model/mcpPicks';

// React не поднимается (окружение node): карточка вызывается как функция, состояние и памятки
// живут между «рендерами» по порядку вызова, эффект идёт после «рендера», если сменились его
// зависимости, — как у смонтированного компонента.
let cells: unknown[] = [];
let at = 0;
let effects: Array<() => void> = [];
const changed = (i: number, deps: unknown[] | undefined): boolean => {
  const prev = (cells[i] as { deps?: unknown[] } | undefined)?.deps;
  return !prev || !deps || deps.some((dep, k) => !Object.is(dep, prev[k]));
};
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
  useMemo: (make: () => unknown, deps: unknown[]) => {
    const i = at++;
    if (changed(i, deps)) cells[i] = { deps, value: make() };
    return (cells[i] as { value: unknown }).value;
  },
  useEffect: (effect: () => void, deps?: unknown[]) => {
    const i = at++;
    if (changed(i, deps)) {
      cells[i] = { deps };
      effects.push(effect);
    }
  },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Запросы ядра — граница сети: настройка и предложения отдаются тестом, запись запоминается.
const REPLY: McpOffersReply = {
  kinds: [{ kind: 'work', takesHuman: true, allByDefault: false }],
  clis: [
    {
      cli: 'claude',
      servers: [{ id: 'probe', scope: 'user', file: 'a', transport: 'stdio' }],
      unread: [],
    },
  ],
  noReader: [],
};
const config = (lead: string): ConfigView =>
  ({
    doc: { cliPaths: {}, mcpPicks: { work: [] }, lead: { note: lead } },
    digest: 'd'.repeat(64),
    drift: null,
    issues: [],
  }) as unknown as ConfigView;
let configData: ConfigView = config('a');
const save = {
  isPending: false,
  isSuccess: false,
  isError: false,
  reset: vi.fn(),
  mutate: vi.fn(),
};
vi.mock('../../api/mcpPicksApi', () => ({
  useMcpOffers: () => ({ data: REPLY, isLoading: false, isError: false }),
  useSavePicks: () => save,
}));
vi.mock('../../api/launchApi', () => ({
  useCoreConfig: () => ({ data: configData, isLoading: false, isError: false }),
}));

const { McpPicksCard } = await import('./McpPicksCard');

interface BodyProps {
  draft: PicksDraft;
  onDraft: (next: PicksDraft) => void;
}

/** Тело карточки в дереве разметки — по его обработчику правки. */
function findBody(node: ReactNode): BodyProps | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findBody(child as ReactNode);
      if (found) return found;
    }
    return undefined;
  }
  const props = (node as ReactElement<Record<string, unknown>>).props;
  if (typeof props.onDraft === 'function') return props as unknown as BodyProps;
  return findBody(props.children as ReactNode);
}

const render = (): BodyProps => {
  at = 0;
  effects = [];
  const tree = McpPicksCard();
  for (const effect of effects) effect();
  const body = findBody(tree);
  if (!body) throw new Error('нет тела карточки');
  return body;
};

/**
 * Выбор MCP рядом с карточкой ведения (этап 11): запись ведения перечитывает ту же настройку
 * ядра. Новое чтение без смены выбора MCP несохранённую отметку не стирает; правка после записи
 * снимает «Сохранено» — оно уже не про то, что на экране.
 */
describe('McpPicksCard — черновик выбора', () => {
  beforeEach(() => {
    cells = [];
    configData = config('a');
    save.isSuccess = false;
    save.reset.mockClear();
  });

  it('перечитанная настройка без смены выбора MCP отметку человека не трогает', () => {
    render();
    render().onDraft({ work: ['probe'] });
    expect(render().draft).toEqual({ work: ['probe'] });

    // Соседняя карточка записала ведение: настройка перечитана, выбор MCP тот же.
    configData = config('b');
    render();

    expect(render().draft).toEqual({ work: ['probe'] });
  });

  it('записанный выбор MCP сменился — черновик заново из настройки', () => {
    render();
    render().onDraft({ work: ['probe'] });
    configData = {
      ...config('a'),
      doc: { ...config('a').doc, mcpPicks: { work: ['other'] } },
    } as ConfigView;
    render();

    expect(render().draft).toEqual({ work: ['other'] });
  });

  it('правка после записи снимает «Сохранено»; без записи — нечего снимать', () => {
    render().onDraft({ work: ['probe'] });
    expect(save.reset).not.toHaveBeenCalled();

    save.isSuccess = true;
    render().onDraft({ work: [] });
    expect(save.reset).toHaveBeenCalledTimes(1);
  });
});
