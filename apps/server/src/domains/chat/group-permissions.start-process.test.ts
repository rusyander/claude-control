import { describe, expect, it } from 'vitest';
import { GROUP_REQUEST_IDS, type GroupRequestId } from '@agentdeck/contracts/split-groups';
import { ruleFor, shouldAutoApprove } from './auto-approve/auto-approve.ts';
import { startProcessLines } from './group-command/start-process.ts';
import { groupDecision, type GroupAutoApprove } from './group-permissions.ts';

/**
 * `Start-Process` — запуск программы мимо разбора (P-02/P-04, 24.10): программа
 * и её аргументы стояли в кавычках списка, и группа удаляла чужую ветку и
 * каталог вне копии сама, а тумблер одиночного чата подтверждал такое молча.
 */
const COPY = 'C:/work/shop-worktrees/fix-PROJ-1-x';

function placed(extra: Partial<GroupAutoApprove> = {}): GroupAutoApprove {
  const rows = Object.fromEntries(GROUP_REQUEST_IDS.map((id) => [id, 'auto'])) as Record<
    GroupRequestId,
    'auto'
  >;
  return {
    rows,
    allowEdits: true,
    parentChatId: 'p',
    groupIndex: 1,
    worktree: COPY,
    shellCwd: COPY,
    base: 'main',
    branch: 'feat/x',
    ownBranch: 'feat/x',
    ...extra,
  };
}

const run = (command: string, extra?: Partial<GroupAutoApprove>): string =>
  groupDecision(placed(extra), { toolName: 'PowerShell', input: { command }, guardedPatterns: [] });

describe('groupDecision — Start-Process (P-02, 24.10)', () => {
  it('удаление чужой ветки и тега, слияние, пуш в main — человеку', () => {
    expect(run("Start-Process git -ArgumentList 'branch','-D','other'")).toBe('human');
    expect(run("Start-Process git -ArgumentList 'tag','-d','v1'")).toBe('human');
    expect(run("saps git -Args 'push','origin','HEAD:main'")).toBe('human');
    expect(
      run(
        "start -FilePath 'C:/Program Files/Git/cmd/git.exe' -ArgumentList 'branch -D other' -Wait",
      ),
    ).toBe('human');
  });

  it('снос вне копии через cmd — человеку', () => {
    expect(run("Start-Process cmd -ArgumentList '/c','rd','/s','/q','C:/Users/me/Documents'")).toBe(
      'human',
    );
    expect(run("Start-Process -NoNewWindow -Wait cmd '/c','rd','/s','/q','C:/Users/me'")).toBe(
      'human',
    );
  });

  it('рутина запуском остаётся рутиной', () => {
    expect(run("Start-Process pnpm -ArgumentList 'build' -NoNewWindow -Wait")).toBe('auto');
  });

  it('псевдонимы снимка Bash к запуску не относятся: программу зовёт не оболочка', () => {
    const aliases = { git: 'echo' };
    expect(run("Start-Process git -ArgumentList 'push','origin','HEAD:main'", { aliases })).toBe(
      'human',
    );
  });
});

describe('ruleFor — Start-Process (P-04, 24.10)', () => {
  const rule = (command: string) => ruleFor('PowerShell', { command });

  it('удаление и история git внутри списка аргументов узнаются', () => {
    expect(rule("Start-Process cmd -ArgumentList '/c','rd','/s','/q','C:/x'")).toBe('filesDelete');
    expect(rule("Start-Process git -ArgumentList 'branch','-D','other'")).toBeDefined();
    expect(
      shouldAutoApprove({
        toolName: 'PowerShell',
        input: { command: "Start-Process cmd -ArgumentList '/c','rd','/s','/q','C:/x'" },
        guardedPatterns: [],
        allowEdits: true,
        allowedRules: new Set(),
      }),
    ).toBe(false);
  });

  it('обычная работа правилом не задета', () => {
    expect(rule('Get-ChildItem')).toBeUndefined();
    expect(rule("Start-Process notepad -ArgumentList 'a.txt'")).toBeUndefined();
  });
});

describe('startProcessLines', () => {
  it('программа и список аргументов — одной строкой, как их склеит запуск', () => {
    expect(startProcessLines("Start-Process git -ArgumentList 'branch','-D','x'")).toEqual([
      'git branch -D x',
    ]);
    expect(
      startProcessLines('Start-Process -FilePath "git.exe" -ArgumentList:"push origin"'),
    ).toEqual(['git push origin']);
    expect(startProcessLines("git status; & saps cmd -Wait '/c','del','f'")).toEqual([
      'cmd /c del f',
    ]);
  });

  it('не запуск, имя в переменной, оборванная кавычка — пусто', () => {
    expect(startProcessLines('git branch -D x')).toEqual([]);
    expect(startProcessLines("Start-Process $g -ArgumentList 'push'")).toEqual([]);
    expect(startProcessLines("Start-Process git -ArgumentList 'push")).toEqual([]);
  });
});
