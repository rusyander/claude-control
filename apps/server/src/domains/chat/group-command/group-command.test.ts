import { describe, it, expect } from 'vitest';
import { groupCommandVerdict } from './group-command.ts';

const COPY = 'C:/work/shop-worktrees/fix-PROJ-1567-PROJ-1589-PROJ-1626-kb-198297';
const OWN = 'fix-PROJ-1567,PROJ-1589,PROJ-1626/kb-models-upload-errors';

const kind = (command: string, branch: string | undefined = OWN): string =>
  groupCommandVerdict(command, { worktree: COPY, ...(branch ? { branch } : {}) }).kind;

describe('groupCommandVerdict — рутина группы', () => {
  it('пример с карточки владельца 19.10 — рутина с арендой', () => {
    const command = `cd "${COPY}" && git push --force-with-lease origin "HEAD:${OWN}" 2>&1 | tail -5 # sieve-ack: @.agent/tmp/sieve-ack.txt`;
    expect(groupCommandVerdict(command, { worktree: COPY, branch: OWN })).toEqual({
      kind: 'routine',
      writes: true,
      lease: true,
      deletes: false,
    });
  });

  it.each([
    `git push origin HEAD:refs/heads/${OWN}`,
    `git push --force-with-lease=${OWN}:abc123 origin ${OWN}`,
    'git push -u origin HEAD',
    'git push',
    `cd src && git push origin "HEAD:${OWN}"`,
    // Политика 19.10: обычный пуш рабочей ветки — сам, и не только своей.
    'git push origin HEAD:feature/other',
    `git push origin "${OWN}" feature/other`,
    `git -C "${COPY}" push origin "HEAD:${OWN}"`,
    `cd "${COPY}"; git add -A; git commit -m "merge notes, git push later, drop rm -rf"`,
    `git commit -m "$(cat <<'EOF'\nfix: drop the table step\n\nEOF\n)"`,
    'git rebase origin/main',
    'git rebase --onto origin/main abc123',
    'git rebase --continue',
    'git fetch origin --prune && git rebase origin/master',
    'git stash push -m "wip" && git stash pop',
    'git status --short && git log --oneline -3 | head -3',
    'git diff --stat >/dev/null 2>&1',
    'git branch --show-current',
  ])('рутина: %s', (command) => {
    expect(kind(command)).toBe('routine');
  });

  it.each([
    'rm -rf dist',
    'rm -rf .agent/tmp/probe',
    'rm -rf node_modules packages/a/dist coverage',
    'rm -f build.log',
    'rm -f logs/*.log',
    'rm -rf apps/web/dist/*',
    'rm -rf /tmp/agent-probe',
    'rm -rf "$TMPDIR/agent-probe"',
    'Remove-Item -Recurse -Force .agent/tmp/shots',
    'rmdir empty-dir',
  ])('уборка временного — рутина «удаление файлов»: %s', (command) => {
    const verdict = groupCommandVerdict(command, { worktree: COPY, branch: OWN });
    expect(verdict.kind).toBe('routine');
    if (command.startsWith('rmdir')) return;
    expect(verdict).toMatchObject({ deletes: true, writes: false });
  });

  it('на Windows копия узнаётся и в форме /c/… и с обратными косыми', () => {
    if (process.platform !== 'win32') return;
    expect(
      kind(`cd /c/work/shop-worktrees/fix-PROJ-1567-PROJ-1589-PROJ-1626-kb-198297 && git push`),
    ).toBe('routine');
    expect(
      kind(
        `cd "C:\\work\\shop-worktrees\\fix-PROJ-1567-PROJ-1589-PROJ-1626-kb-198297" && git push`,
      ),
    ).toBe('routine');
  });
});

describe('groupCommandVerdict — карточка человеку (политика 19.10)', () => {
  it.each([
    // Пуш в основную или защищённую ветку — в любой форме.
    'git push origin main',
    'git push origin HEAD:master',
    'git push origin HEAD:main',
    'git push origin HEAD:refs/heads/main',
    'git push origin develop',
    'git push origin HEAD:release/2.4',
    `git -C "${COPY}" push origin main`,
    `git -C . push origin HEAD:main`,
    `cd "${COPY}" && git status && git push origin HEAD:main 2>&1 | tail -3`,
    'git checkout main && git push',
    'git push origin refs/tags/v1',
    // Принудительный пуш: флаг, `+refspec`, аренда чужой ветки.
    `git push --force origin "HEAD:${OWN}"`,
    `git push -f origin "HEAD:${OWN}"`,
    `git push origin "+HEAD:${OWN}"`,
    `git push --force-with-lease origin HEAD:feature/other`,
    `git push --force-with-lease=main origin "HEAD:${OWN}"`,
    'git checkout -b next && git push --force-with-lease origin HEAD:next',
    // Удаление ветки на удалённом и локально, меток, копии, тайника.
    `git push origin --delete "${OWN}"`,
    `git push origin ":${OWN}"`,
    'git push origin :feature/old',
    `git branch -D "${OWN}"`,
    'git branch -d feature/old',
    'git branch --delete feature/old',
    `git -C "${COPY}" branch -D x`,
    'git fetch && git branch -D old && git status',
    'git tag -d v1',
    'git worktree remove ../copy',
    'git stash drop',
    'git stash clear',
    // Слияние — любое: в основную, в свою, через CLI или API форджа.
    `git checkout main && git merge "${OWN}"`,
    'git merge origin/main',
    'git merge --no-ff feature/a',
    'gh pr merge 5 --squash',
    'glab mr merge 5',
    'gh api -X PUT repos/team/repo/pulls/5/merge',
    'curl -X PUT -H "PRIVATE-TOKEN: x" https://git.example.com/api/v4/projects/1/merge_requests/5/merge',
    'curl -X DELETE https://git.example.com/api/v4/projects/1/repository/branches/x',
    'gh repo delete team/repo --yes',
    // Прочие формы, в которых пуш не проследить.
    `git push --mirror origin`,
    `git push upstream "HEAD:${OWN}"`,
    `git push -o merge_request.merge_when_pipeline_succeeds origin "HEAD:${OWN}"`,
    `git push origin "HEAD:$BRANCH"`,
    `git -c core.hooksPath=/dev/null push origin "HEAD:${OWN}"`,
    `git -C ../other push origin "HEAD:${OWN}"`,
    `cd .. && git push origin "HEAD:${OWN}"`,
    `cd C:/work/agentdeck && git push`,
    `GIT_DIR=../x/.git git push origin "HEAD:${OWN}"`,
    `bash -c "git push origin main"`,
    `(git push origin main)`,
    // Удаление настоящих файлов и каталогов — в копии и вне её.
    'rm -rf ../repo',
    'rm -rf C:/work/agentdeck',
    'rm -rf .',
    'rm -rf *',
    'rm -rf src',
    'rm -f notes.txt',
    'rm -r "$TARGET"',
    'rm -rf /tmp/../etc',
    'Remove-Item -Recurse -Force ../x',
    'Remove-Item -Recurse -Force src',
    'rd /s /q src',
    'find . -name "*.ts" -delete',
    'xargs rm -rf < list.txt',
    'sudo rm -rf /var/lib/app',
    'FOO=1 rm -rf src',
    '(rm -rf src)',
    // Снос базы.
    'psql -c "drop table users"',
    'psql -c "DROP DATABASE app"',
    'psql "$DB" -c "truncate events"',
    'docker exec db psql -U app -c "delete from users"',
    'redis-cli flushall',
    'dropdb app',
    'pnpm prisma migrate reset --force',
  ])('карточка: %s', (command) => {
    expect(kind(command)).toBe('danger');
  });

  it('без своей ветки (копия на main, HEAD отсоединена, git молчит) неявный пуш — человеку', () => {
    const branchless = (command: string): string =>
      groupCommandVerdict(command, { worktree: COPY }).kind;
    expect(branchless('git push')).toBe('danger');
    expect(branchless('git push -u origin HEAD')).toBe('danger');
    expect(branchless('git push --force-with-lease origin HEAD:feature/a')).toBe('danger');
    expect(branchless('git merge feature/a')).toBe('danger');
    expect(groupCommandVerdict('git push', {}).kind).toBe('danger');
    // Явная рабочая ветка — сама и без своей.
    expect(branchless('git push origin HEAD:feature/a')).toBe('routine');
  });

  it('ветка по умолчанию у origin защищена, как main', () => {
    const scope = { worktree: COPY, branch: OWN, base: 'trunk-2026' };
    expect(groupCommandVerdict('git push origin HEAD:trunk-2026', scope).kind).toBe('danger');
    expect(groupCommandVerdict('git push origin HEAD:feature/b', scope).kind).toBe('routine');
  });
});

describe('groupCommandVerdict — прочее решают правила чата', () => {
  it.each([
    'pnpm build',
    'git merge --abort',
    'git reset --hard origin/main',
    'git rebase main',
    'git branch -m old new',
    // Новая рабочая ветка и её пуш — не карточка: смену ветки решают правила чата.
    'git checkout -b next && git push -u origin HEAD',
    'echo hi > out.txt',
    'psql -c "select count(*) from users"',
    'gh pr view 5',
    'curl https://example.com/api/v4/projects/1/merge_requests/5',
    `git push --force-with-lease origin "HEAD:${OWN}" && pnpm test`,
  ])('прочее: %s', (command) => {
    expect(kind(command)).toBe('other');
  });
});
