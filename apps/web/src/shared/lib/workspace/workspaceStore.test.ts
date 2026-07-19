import { describe, it, expect } from 'vitest';
import { HOME_TAB_ID, type WorkspaceState } from './workspace.types';
import {
  normalizeProjectPath,
  openProjectTab,
  closeProjectTab,
  activateTab,
  sanitizeState,
} from './workspaceStore';

/**
 * Тесты логики табов рабочего пространства — чистые переходы состояния, без
 * React и хранилища. Здесь закреплено поведение, которое должно работать без
 * багов: дедуп при открытии, куда уходит фокус при закрытии, устойчивость к
 * мусору из localStorage. Тест-кейсы см. .agent/TEST-CASES.md → «Табы проектов».
 */
const HOME: WorkspaceState = { projectTabs: [], activeTabId: HOME_TAB_ID };

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
});
