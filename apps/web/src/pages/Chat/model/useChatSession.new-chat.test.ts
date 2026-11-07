import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSummary } from '@agentdeck/contracts';

// React не поднимается (окружение node): состояние и ссылки живут между «рендерами» по порядку
// вызова, эффект выполняется после «рендера», если сменились его зависимости, — как у
// смонтированного компонента. «Рендер» — повторный вызов хука.
let cells: unknown[] = [];
let at = 0;
let effects: Array<() => void> = [];
const changed = (i: number, deps: unknown[] | undefined): boolean => {
  const prev = cells[i] as unknown[] | undefined;
  cells[i] = deps;
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
  useRef: (initial: unknown) => {
    const i = at++;
    if (!(i in cells)) cells[i] = { current: initial };
    return cells[i];
  },
  useCallback: (fn: unknown) => {
    at++;
    return fn;
  },
  useEffect: (effect: () => void, deps?: unknown[]) => {
    if (changed(at++, deps)) effects.push(effect);
  },
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));

// Роутер, адрес и соседние сущности — обвязка страницы; поведение сессии от них не зависит.
const writeUrl = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useSearch: () => ({}) }));
vi.mock('@shared/hooks/use-entity-url', () => ({
  useEntityUrl: () => undefined,
  useEntityUrlWriter: () => writeUrl,
}));
vi.mock('@entities/Chat', () => ({ useRefreshChat: () => vi.fn() }));
vi.mock('@entities/ProjectRunner', () => ({ useClearRunnerAutostart: () => vi.fn() }));
vi.mock('@entities/ProjectFile', () => ({ useForgetProjectCodeView: () => vi.fn() }));

const { useChatSession } = await import('./useChatSession');
const { workspace, getWorkspaceState } = await import('@shared/lib/workspace');

const useRender = (chats: ChatSummary[] | undefined) => {
  at = 0;
  effects = [];
  const session = useChatSession({ chats });
  for (const effect of effects) effect();
  return session;
};

const OLD = { id: 'chat-old', title: 'прежний', projectPath: '/p' } as unknown as ChatSummary;

/**
 * «Новый чат» без проекта (W3-17a: в `/chat`, а не на экран ядра): чистый лист в песочнице.
 * Вкладка, открытая по памяти до прихода списка, ждёт свой прежний разговор; человек нажал
 * «Новый чат» раньше, чем список доехал, — доехавший список не подменяет лист прежним разговором.
 */
describe('useChatSession — новый чат', () => {
  beforeEach(() => {
    cells = [];
    writeUrl.mockClear();
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['Date'] });
    workspace.rememberView(getWorkspaceState().activeTabId, OLD.id);
  });
  afterEach(() => vi.useRealTimers());

  it('чистый лист: свой черновик, адрес без id, вкладка помнит черновик', () => {
    useRender(undefined);
    useRender(undefined).startNewChat();
    const session = useRender(undefined);

    expect(session.activeChat).toBeUndefined();
    expect(session.draftId).toBe('new-1800000000000');
    expect(session.pending).toEqual([]);
    expect(writeUrl).toHaveBeenLastCalledWith(undefined);
    expect(getWorkspaceState().views[getWorkspaceState().activeTabId]).toBe('new-1800000000000');
  });

  it('список доехал после нажатия — прежний разговор лист не подменяет', () => {
    // Список ещё грузится: вкладка открыла запомненный разговор черновиком и ждёт его в списке.
    useRender(undefined);
    const waiting = useRender(undefined);
    expect(waiting.draftId).toBe(OLD.id);
    waiting.startNewChat();

    const session = useRender([OLD]);

    expect(session.activeChat).toBeUndefined();
    expect(session.draftId).toBe('new-1800000000000');
    expect(writeUrl).not.toHaveBeenCalledWith(OLD.id);
  });
});
