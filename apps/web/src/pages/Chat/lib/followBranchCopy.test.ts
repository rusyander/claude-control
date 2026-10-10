import { describe, expect, it } from 'vitest';
import { getWorkspaceState, normalizeProjectPath, workspace } from '@shared/lib/workspace';
import { followBranchCopy } from './followBranchCopy';

/**
 * Ф-6: копия из карточки ворот ветки открывается своей вкладкой, и вкладка
 * сразу помнит переехавший разговор. Стор настоящий (синглтон), пути у каждого
 * теста свои, поэтому порядок тестов роли не играет.
 */
describe('followBranchCopy', () => {
  it('открывает вкладку копии, делает её активной и запоминает в ней разговор', () => {
    workspace.openProject('C:/work/app', 'app');
    const copy = 'C:/work/app-worktrees/agent-fix';

    const tabId = followBranchCopy(copy, 'chat-1');

    const state = getWorkspaceState();
    expect(tabId).toBe(normalizeProjectPath(copy));
    expect(state.activeTabId).toBe(tabId);
    expect(state.projectTabs.map((tab) => tab.id)).toContain(tabId);
    expect(state.views[tabId]).toBe('chat-1');
  });

  it('уже открытая копия второй вкладки не получает', () => {
    const copy = 'C:/work/lib-worktrees/agent-x';
    workspace.openProject(copy, 'agent-x');
    workspace.openProject('C:/work/lib', 'lib');
    const before = getWorkspaceState().projectTabs.length;

    const tabId = followBranchCopy(copy, 'chat-2');

    expect(getWorkspaceState().projectTabs).toHaveLength(before);
    expect(getWorkspaceState().activeTabId).toBe(tabId);
  });

  it('без разговора вкладка открывается, память вкладки не трогается', () => {
    const tabId = followBranchCopy('C:/work/web-worktrees/agent-y', undefined);

    expect(getWorkspaceState().activeTabId).toBe(tabId);
    expect(tabId in getWorkspaceState().views).toBe(false);
  });
});
