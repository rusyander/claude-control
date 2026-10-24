import { describe, it, expect } from 'vitest';
import { GROUP_REQUEST_IDS, type GroupRequestId } from '@agentdeck/contracts/split-groups';
import { groupDecision, type GroupAutoApprove } from './group-permissions.ts';

/**
 * Остатки пути Claude, найденные при переносе правил групп на чужие CLI (P-02, R1):
 * инструмент PowerShell, у которого git или удаление спрятаны в `Start-Process`/`iex`,
 * а не стоят первым словом. Судья чужого CLI зовёт тот же `groupDecision`, поэтому
 * дыра здесь — дыра у обоих.
 */
const COPY = 'C:/work/shop-worktrees/fix-PROJ-1-x';

function placed(): GroupAutoApprove {
  const rows = Object.fromEntries(GROUP_REQUEST_IDS.map((id) => [id, 'auto'])) as Record<
    GroupRequestId,
    'auto'
  >;
  return {
    rows: { ...rows, externalWrite: 'human', externalDestroy: 'human' },
    allowEdits: true,
    parentChatId: 'p',
    groupIndex: 1,
    worktree: COPY,
    shellCwd: COPY,
    base: 'main',
    branch: 'feat/x',
    ownBranch: 'feat/x',
  };
}

const run = (toolName: string, command: string): string =>
  groupDecision(placed(), { toolName, input: { command }, guardedPatterns: [] });

describe('groupDecision — PowerShell: git и удаление внутри Start-Process/iex (R1)', () => {
  it('удаление ветки и метки через Start-Process — человеку', () => {
    expect(run('PowerShell', "Start-Process git -ArgumentList 'branch','-D','other'")).toBe(
      'human',
    );
    expect(run('PowerShell', "Start-Process git -ArgumentList 'tag','-d','v1'")).toBe('human');
    expect(run('PowerShell', "Start-Process -FilePath git.exe -ArgumentList 'merge','side'")).toBe(
      'human',
    );
    expect(run('PowerShell', "saps git 'branch -D other'")).toBe('human');
  });

  it('рекурсивное удаление через Start-Process cmd — человеку', () => {
    expect(run('PowerShell', "Start-Process cmd -ArgumentList '/c','rd','/s','/q','src'")).toBe(
      'human',
    );
    expect(run('PowerShell', "Start-Process cmd.exe '/c rmdir /s /q src'")).toBe('human');
  });

  it('git внутри iex / Invoke-Expression — человеку', () => {
    expect(run('PowerShell', "iex 'git branch -D other'")).toBe('human');
    expect(run('PowerShell', "Invoke-Expression 'git push origin HEAD:main'")).toBe('human');
  });

  it('обычная работа инструментом PowerShell по-прежнему сама', () => {
    expect(run('PowerShell', 'Get-ChildItem')).toBe('auto');
    expect(run('PowerShell', 'git status')).toBe('auto');
    expect(run('PowerShell', 'git commit -m "fix: x"')).toBe('auto');
    expect(run('PowerShell', 'git push origin HEAD')).toBe('auto');
  });
});
