import { describe, it, expect } from 'vitest';
import { HOME_TAB_ID, type WorkspaceState } from './workspace.types';
import {
  normalizeProjectPath,
  openProjectTab,
  closeProjectTab,
  activateTab,
  rememberTabView,
  reorderProjectTabs,
  moveProjectTab,
  sanitizeState,
} from './workspaceStore';

/**
 * Тесты логики табов рабочего пространства — чистые переходы состояния, без
 * React и хранилища. Здесь закреплено поведение, которое должно работать без
 * багов: дедуп при открытии, куда уходит фокус при закрытии, устойчивость к
 * мусору из localStorage. Тест-кейсы см. .agent/TEST-CASES.md → «Табы проектов».
 */
const HOME: WorkspaceState = { projectTabs: [], activeTabId: HOME_TAB_ID, views: {} };

function withTabs(...paths: string[]): WorkspaceState {
  let state = HOME;
  for (const path of paths) state = openProjectTab(state, { path, name: path });
  return state;
}

describe('normalizeProjectPath', () => {
  it('приводит слэши, регистр и хвостовой разделитель к общему виду', () => {
    expect(normalizeProjectPath('C:\\Work\\App\\')).toBe('c:/work/app');
    expect(normalizeProjectPath('C:/Work/App')).toBe('c:/work/app');
  });
});

describe('openProjectTab', () => {
  it('добавляет таб и делает его активным', () => {
    const state = openProjectTab(HOME, { path: 'C:/work/a', name: 'a' });
    expect(state.projectTabs).toHaveLength(1);
    expect(state.activeTabId).toBe('c:/work/a');
  });

  it('повторное открытие того же проекта не плодит таб, а активирует', () => {
    const one = openProjectTab(HOME, { path: 'C:/work/a', name: 'a' });
    const two = openProjectTab(activateTab(one, HOME_TAB_ID), { path: 'C:\\work\\a', name: 'a' });
    expect(two.projectTabs).toHaveLength(1);
    expect(two.activeTabId).toBe('c:/work/a');
  });
});

describe('closeProjectTab', () => {
  it('закрытие активного таба переводит фокус на левого соседа', () => {
    const state = withTabs('C:/a', 'C:/b', 'C:/c'); // активен c
    const next = closeProjectTab(state, 'c:/c');
    expect(next.projectTabs.map((t) => t.id)).toEqual(['c:/a', 'c:/b']);
    expect(next.activeTabId).toBe('c:/b');
  });

  it('закрытие первого проекта переводит фокус на домашний таб', () => {
    const state = activateTab(withTabs('C:/a', 'C:/b'), 'c:/a');
    const next = closeProjectTab(state, 'c:/a');
    expect(next.activeTabId).toBe(HOME_TAB_ID);
  });

  it('закрытие неактивного таба фокус не двигает', () => {
    const state = withTabs('C:/a', 'C:/b'); // активен b
    const next = closeProjectTab(state, 'c:/a');
    expect(next.activeTabId).toBe('c:/b');
    expect(next.projectTabs.map((t) => t.id)).toEqual(['c:/b']);
  });

  it('закрытие несуществующего таба возвращает то же состояние', () => {
    const state = withTabs('C:/a');
    expect(closeProjectTab(state, 'c:/нет')).toBe(state);
  });
});

describe('activateTab', () => {
  it('активирует домашний и существующий таб', () => {
    const state = withTabs('C:/a');
    expect(activateTab(state, HOME_TAB_ID).activeTabId).toBe(HOME_TAB_ID);
    expect(activateTab(state, 'c:/a').activeTabId).toBe('c:/a');
  });

  it('несуществующий id игнорируется', () => {
    const state = withTabs('C:/a');
    expect(activateTab(state, 'c:/нет')).toBe(state);
  });
});

describe('reorderProjectTabs: порядок табов задаёт человек', () => {
  it('переставляет табы в названный порядок, активный таб не трогая', () => {
    const state = withTabs('C:/a', 'C:/b', 'C:/c'); // активен c
    const next = reorderProjectTabs(state, ['c:/c', 'c:/a', 'c:/b']);
    expect(next.projectTabs.map((t) => t.id)).toEqual(['c:/c', 'c:/a', 'c:/b']);
    expect(next.activeTabId).toBe('c:/c');
  });

  it('тот же порядок — то же состояние (хранилище не переписываем)', () => {
    const state = withTabs('C:/a', 'C:/b');
    expect(reorderProjectTabs(state, ['c:/a', 'c:/b'])).toBe(state);
  });

  it('не перестановка — состояние не меняем: неполный список, лишние и дубли', () => {
    const state = withTabs('C:/a', 'C:/b', 'C:/c');
    expect(reorderProjectTabs(state, ['c:/b', 'c:/a'])).toBe(state);
    expect(reorderProjectTabs(state, ['c:/c', 'c:/b', 'c:/нет'])).toBe(state);
    expect(reorderProjectTabs(state, ['c:/a', 'c:/a', 'c:/b', 'c:/c'])).toBe(state);
    expect(reorderProjectTabs(state, [])).toBe(state);
  });

  it('открытые разговоры вкладок переезд переживают', () => {
    const state = rememberTabView(withTabs('C:/a', 'C:/b'), 'c:/a', 'chat-1');
    expect(reorderProjectTabs(state, ['c:/b', 'c:/a']).views['c:/a']).toBe('chat-1');
  });
});

describe('moveProjectTab: шаг табу с клавиатуры', () => {
  it('двигает влево и вправо', () => {
    const state = withTabs('C:/a', 'C:/b', 'C:/c');
    expect(moveProjectTab(state, 'c:/c', -1).projectTabs.map((t) => t.id)).toEqual([
      'c:/a',
      'c:/c',
      'c:/b',
    ]);
    expect(moveProjectTab(state, 'c:/a', 1).projectTabs.map((t) => t.id)).toEqual([
      'c:/b',
      'c:/a',
      'c:/c',
    ]);
  });

  it('у краёв ленты шаг никуда не ведёт', () => {
    const state = withTabs('C:/a', 'C:/b');
    expect(moveProjectTab(state, 'c:/a', -1)).toBe(state);
    expect(moveProjectTab(state, 'c:/b', 1)).toBe(state);
  });

  it('несуществующий таб игнорируется', () => {
    const state = withTabs('C:/a');
    expect(moveProjectTab(state, 'c:/нет', 1)).toBe(state);
  });
});

describe('rememberTabView: вкладка помнит свой разговор', () => {
  it('запоминает и переписывает разговор вкладки', () => {
    const state = rememberTabView(withTabs('C:/a'), 'c:/a', 'chat-1');
    expect(state.views['c:/a']).toBe('chat-1');
    expect(rememberTabView(state, 'c:/a', 'chat-2').views['c:/a']).toBe('chat-2');
  });

  it('пустой разговор — забыть; повтор того же — то же состояние', () => {
    const state = rememberTabView(withTabs('C:/a'), 'c:/a', 'chat-1');
    expect(rememberTabView(state, 'c:/a', 'chat-1')).toBe(state);
    expect(rememberTabView(state, 'c:/a', undefined).views['c:/a']).toBeUndefined();
  });

  it('закрытая вкладка уносит свою память с собой', () => {
    const state = rememberTabView(withTabs('C:/a', 'C:/b'), 'c:/a', 'chat-1');
    expect(closeProjectTab(state, 'c:/a').views['c:/a']).toBeUndefined();
  });

  it('открытие второго проекта не стирает память первого', () => {
    const one = rememberTabView(withTabs('C:/a'), 'c:/a', 'chat-1');
    const two = openProjectTab(one, { path: 'C:/b', name: 'b' });
    expect(two.views['c:/a']).toBe('chat-1');
  });
});

describe('sanitizeState', () => {
  it('чинит мусор из хранилища: дубли, битые записи, несуществующий активный', () => {
    const raw = {
      projectTabs: [
        { id: 'c:/a', path: 'C:/a', name: 'a' },
        { id: 'c:/a', path: 'C:/a', name: 'a' }, // дубль
        { id: 'c:/b', path: 'C:/b' }, // без name
        { path: 'C:/c' }, // без id — битая
        null,
      ],
      activeTabId: 'c:/несуществует',
    };
    const state = sanitizeState(raw);
    expect(state.projectTabs.map((t) => t.id)).toEqual(['c:/a', 'c:/b']);
    // name подставлен из пути, активный сброшен на домашний.
    expect(state.projectTabs[1]?.name).toBe('C:/b');
    expect(state.activeTabId).toBe(HOME_TAB_ID);
  });

  it('пустой/битый ввод → домашнее состояние', () => {
    expect(sanitizeState(undefined)).toEqual(HOME);
    expect(sanitizeState('строка')).toEqual(HOME);
  });

  it('сохраняет валидный активный таб', () => {
    const state = sanitizeState({
      projectTabs: [{ id: 'c:/a', path: 'C:/a', name: 'a' }],
      activeTabId: 'c:/a',
    });
    expect(state.activeTabId).toBe('c:/a');
  });

  it('память вкладок переживает перезагрузку, но только у живых вкладок', () => {
    const state = sanitizeState({
      projectTabs: [{ id: 'c:/a', path: 'C:/a', name: 'a' }],
      activeTabId: 'c:/a',
      views: { 'c:/a': 'chat-1', home: 'chat-home', 'c:/закрытая': 'chat-2', 'c:/битая': 42 },
    });
    expect(state.views).toEqual({ 'c:/a': 'chat-1', home: 'chat-home' });
  });
});
