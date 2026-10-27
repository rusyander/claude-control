import { describe, expect, it } from 'vitest';
import { groupGitAimRefusal, type GroupAutoApprove } from './group-permissions.ts';

/**
 * git над копией (D-4, 25.10): из подпапки `inst-docs-ui` группа написала
 * `cd ..; git -C .. add … && rebase --continue` — два подъёма вместо одного, git
 * пошёл бы в каталоге, где лежат все копии. Карточка человеку держала группу
 * посреди перебазирования; верный ответ всегда один — «поправь путь», поэтому
 * отказ агенту с причиной. Один подъём из подпапки и путь к самой копии — свои.
 */
const COPY = 'C:/work/shop-worktrees/fix-PROJ-1-x';
const SUB = `${COPY}/inst-docs-ui`;
const ABOVE = 'C:/work/shop-worktrees';

function group(extra: Partial<GroupAutoApprove> = {}): GroupAutoApprove {
  return {
    rows: {} as GroupAutoApprove['rows'],
    allowEdits: true,
    parentChatId: 'p',
    groupIndex: 1,
    branch: 'fix-PROJ-1/x',
    worktree: COPY,
    ownBranch: 'fix-PROJ-1/x',
    ignored: [],
    ...extra,
  };
}

const bash = (command: string) => ({ toolName: 'Bash', input: { command } });
/** Путь в тексте отказа — в написании разбора (на Windows строчными), сравнение без регистра. */
const norm = (text: string | undefined): string => (text ?? '').replace(/\\/g, '/').toLowerCase();

/** Дословная команда карточки 25.10 из журнала группы. */
const LIVE =
  'cd .. 2>/dev/null; git -C .. add inst-docs-ui/src/app.tsx && git -C .. rebase --continue';

/** Команда карточки D-6 (25.10), тело коммита сокращено: коммит в своей копии из подпапки. */
const D6 = [
  "git -C .. add inst-docs-ui && git -C .. commit -q -F - <<'EOF'",
  'fix(inst-docs-ui): сверка жирных ячеек',
  'EOF',
  'echo rc=$?; git -C .. log --oneline -2; git -C .. status --short | head',
].join('\n');

describe('groupGitAimRefusal — git в каталоге над копией (D-4)', () => {
  it('два подъёма из подпапки (`cd ..` + `-C ..`) — отказ называет оболочку, каталог git и копию', () => {
    const refusal = groupGitAimRefusal(group({ shellCwd: SUB }), bash(LIVE));
    expect(refusal).toMatch(/^Nothing in this command ran: /);
    const text = norm(refusal);
    expect(text).toContain(`your shell is in ${norm(SUB)}`);
    expect(text).toContain(`git would run in ${norm(ABOVE)},`);
    expect(text).toContain(`contains your copy ${norm(COPY)}`);
    expect(refusal).toContain(`git -C "${COPY}"`);
  });

  it('подъёмы складываются в любом виде: два `cd ..` и `-C ..` от самого корня копии', () => {
    expect(
      groupGitAimRefusal(group({ shellCwd: SUB }), bash('cd .. && cd .. && git add x')),
    ).toBeDefined();
    expect(groupGitAimRefusal(group({ shellCwd: COPY }), bash('git -C .. add x'))).toBeDefined();
  });

  it('один подъём из подпапки остаётся в копии — отказа нет', () => {
    const command = 'git -C .. add inst-docs-ui/src/app.tsx && git -C .. rebase --continue';
    expect(groupGitAimRefusal(group({ shellCwd: SUB }), bash(command))).toBeUndefined();
    expect(
      groupGitAimRefusal(group({ shellCwd: SUB }), bash('cd .. && git add x')),
    ).toBeUndefined();
  });

  it('опасное по другой причине в самой копии — не этот отказ: решает человек, как прежде', () => {
    // Корень копии лежит «внутри» самого себя — над копией он не считается.
    for (const command of ['git push origin HEAD:main', 'cd .. && git push origin HEAD:main']) {
      expect(groupGitAimRefusal(group({ shellCwd: SUB }), bash(command))).toBeUndefined();
    }
    expect(
      groupGitAimRefusal(group({ shellCwd: COPY }), bash('git push origin HEAD:main')),
    ).toBeUndefined();
  });

  it('абсолютный `-C` к корню копии — отказа нет', () => {
    const command = `git -C "${COPY}" add inst-docs-ui/src/app.tsx && git -C "${COPY}" rebase --continue`;
    expect(groupGitAimRefusal(group({ shellCwd: SUB }), bash(command))).toBeUndefined();
  });

  it('корень оболочки угадан (каталог не прочитан) — отказ с тем, от чего считался `..` (D-6)', () => {
    // D-6 25.10: запись вызова не успела лечь в транскрипт, `-C ..` из подпапки
    // считался от корня копии — карточка человеку на обычный коммит в своей копии.
    const refusal = groupGitAimRefusal(group(), bash(D6));
    expect(refusal).toMatch(/^Nothing in this command ran: /);
    const text = norm(refusal);
    expect(text).toContain("could not read your shell's directory for this call");
    expect(text).toContain(`counted from your copy root ${norm(COPY)}`);
    expect(text).toContain(`git would run in ${norm(ABOVE)},`);
    expect(text).not.toContain('your shell is in');
    expect(refusal).toContain(`git -C "${COPY}"`);
    expect(groupGitAimRefusal(group(), bash('git -C .. add x'))).toBeDefined();
    // Каталог прочитан: тот же `-C ..` из подпапки — сама копия, отказа нет.
    expect(groupGitAimRefusal(group({ shellCwd: SUB }), bash(D6))).toBeUndefined();
    // Опасное без подъёма от угаданного корня — человеку, как прежде.
    expect(groupGitAimRefusal(group(), bash('git push origin HEAD:main'))).toBeUndefined();
  });

  it('без копии и не оболочка — не этот случай', () => {
    expect(groupGitAimRefusal(group({ shellCwd: SUB, worktree: '' }), bash(LIVE))).toBeUndefined();
    expect(
      groupGitAimRefusal(group({ shellCwd: SUB }), { toolName: 'Read', input: { file_path: 'x' } }),
    ).toBeUndefined();
  });
});
