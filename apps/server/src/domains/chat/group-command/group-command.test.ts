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

  it.each([`git push --force origin "HEAD:${OWN}"`, `git push -f origin "HEAD:${OWN}"`])(
    'принудительный пуш своей ветки — как аренда (решение 23.10): %s',
    (command) => {
      expect(groupCommandVerdict(command, { worktree: COPY, branch: OWN })).toMatchObject({
        kind: 'routine',
        writes: true,
        lease: true,
      });
      // Своей ветки нет (основная, отсоединённая HEAD) — человеку.
      expect(groupCommandVerdict(command, { worktree: COPY }).kind).toBe('danger');
    },
  );

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
    'T=$(mktemp -d); rm -rf "$T"',
    'Remove-Item -Recurse -Force .agent/tmp/shots',
    'rmdir empty-dir',
  ])('уборка временного — рутина «удаление файлов»: %s', (command) => {
    const verdict = groupCommandVerdict(command, { worktree: COPY, branch: OWN });
    expect(verdict.kind).toBe('routine');
    if (command.startsWith('rmdir')) return;
    expect(verdict).toMatchObject({ deletes: true, writes: false });
  });

  it.each(['rm -rf /tmp/agent-probe', 'rm -rf "$TMPDIR/agent-probe"', 'rm -rf /tmp/*'])(
    'временный каталог системы вне свежего mktemp — человеку (решение владельца 23.10, F-77): %s',
    (command) => {
      expect(groupCommandVerdict(command, { worktree: COPY, branch: OWN }).kind).toBe('danger');
    },
  );

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
    // Принудительный пуш: `+refspec`, перезапись чужой ветки (флагом или арендой).
    `git push origin "+HEAD:${OWN}"`,
    'git push --force origin HEAD:feature/other',
    'git push -f origin main',
    `git push --force-with-lease origin HEAD:feature/other`,
    `git push --force-with-lease=main origin "HEAD:${OWN}"`,
    'git checkout -b next && git push --force-with-lease origin HEAD:next',
    // Удаление ветки на удалённом и локально, меток, копии, тайника.
    `git push origin --delete "${OWN}"`,
    `git push origin ":${OWN}"`,
    'git push origin :feature/old',
    `git branch -D "${OWN}"`,
    'git branch -D feature/old',
    'git branch -d -f feature/old',
    'git branch --delete --force feature/old',
    'git branch -dr origin/feature/old',
    `git branch -d "${OWN}"`,
    'git branch -d main',
    'git branch -d $OLD',
    `git -C "${COPY}" branch -D x`,
    'git fetch && git branch -D old && git status',
    'git tag -d v1',
    'git worktree remove ../copy',
    'git stash drop',
    'git stash clear',
    // Слияние в основную — локально, через CLI или API форджа.
    `git checkout main && git merge "${OWN}"`,
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
    // Хуки из произвольного каталога; отключение (`/dev/null`) разрешено — `git-guards.ts`.
    `git -c core.hooksPath=./hooks push origin "HEAD:${OWN}"`,
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

  it('свежая основная в свою рабочую ветку — рутина «запись в git»; в основную и вне копии — человеку (23.10)', () => {
    const own = { worktree: COPY, branch: OWN };
    for (const command of [
      'git merge origin/main',
      'git merge --no-edit -X theirs origin/main',
      'git fetch origin && git merge origin/main',
      `git -C "${COPY}" merge origin/main`,
    ]) {
      expect(groupCommandVerdict(command, own), command).toEqual({
        kind: 'routine',
        writes: true,
        lease: false,
        deletes: false,
      });
    }
    // Прочее слияние — человеку (решение владельца 23.10: «мержить запрещено»).
    expect(kind('git merge --no-ff feature/a')).toBe('danger');
    expect(kind('git merge origin/feat/y')).toBe('danger');
    expect(kind('git merge -m main feature/a')).toBe('danger');
    expect(kind('git merge --abort')).toBe('routine');
    expect(kind('git merge --continue')).toBe('routine');
    expect(
      groupCommandVerdict('git merge origin/main', { worktree: COPY, branch: 'main' }).kind,
    ).toBe('danger');
    expect(kind('git checkout develop && git merge origin/main')).toBe('danger');
    expect(kind('git -C ../other merge origin/main')).toBe('danger');
    expect(kind('git -C ../other merge --abort')).toBe('danger');
  });

  it('пробный догон в отсоединённой голове — не человеку; не вышло отсоединение — судим по прежней ветке', () => {
    // Сито «интеграция» (реплей 23.10): `checkout --detach && merge origin/main`
    // ни одной ветки не двигает. Сам `checkout` — правилами чата, как любая смена ветки.
    for (const command of [
      'git checkout -q --detach && git merge -q --no-edit origin/main 2>&1 | tail -2',
      'git switch -d origin/main; git merge origin/main',
      'git checkout 5d4ef6a1 && git merge origin/main',
      'git checkout HEAD~1 && git merge --no-edit origin/main',
      // Второе отсоединение помнит ветку до первого.
      'git checkout --detach && git checkout 5d4ef6a1 && git merge origin/main',
    ]) {
      expect(kind(command), command).toBe('other');
    }
    // Копия на основной: отсоединение не выйдет — слияние ляжет в main.
    const onMain = { worktree: COPY, branch: 'main' };
    expect(groupCommandVerdict('git checkout --detach; git merge origin/main', onMain).kind).toBe(
      'danger',
    );
    // Чужая ветка в отсоединённую голову — всё равно человеку.
    expect(kind('git checkout --detach && git merge feature/a')).toBe('danger');
    // Ушли с отсоединённой головы на неизвестную или защищённую ветку.
    expect(kind('git checkout --detach && git checkout - && git merge origin/main')).toBe('danger');
    expect(kind('git checkout --detach && git checkout develop && git merge origin/main')).toBe(
      'danger',
    );
    // Своя ветка группы не известна — отсоединение её не придумывает.
    expect(
      groupCommandVerdict('git checkout --detach && git merge origin/main', { worktree: COPY })
        .kind,
    ).toBe('danger');
  });

  it('ветка по умолчанию у origin защищена, как main', () => {
    const scope = { worktree: COPY, branch: OWN, base: 'trunk-2026' };
    expect(groupCommandVerdict('git push origin HEAD:trunk-2026', scope).kind).toBe('danger');
    expect(groupCommandVerdict('git push origin HEAD:feature/b', scope).kind).toBe('routine');
  });
});

describe('groupCommandVerdict — подстановки, heredoc, перенаправления (23.10)', () => {
  // Четыре команды с карточек владельца 23.10: сверка и чтение шли человеку.
  it.each([
    'git merge-tree --write-tree --name-only HEAD origin/main | head -3; echo A=${PIPESTATUS[0]}; git merge-tree --write-tree --quiet origin/main HEAD; echo B=$?; git version',
    'git status --short | head -20; git log --oneline -3; git fetch origin 2>&1 | tail -2; git merge-tree --write-tree --quiet HEAD origin/main; echo "merge-tree exit=$?"; git rev-parse --abbrev-ref @{u} 2>&1 | head -1; git diff --stat origin/main...HEAD | tail -5; ls .agent .agent/run 2>/dev/null | head -40',
    'git log --oneline -3; git merge-base HEAD origin/main; git rev-parse origin/main; git diff --stat $(git merge-base HEAD origin/main)...HEAD | tail -70; cat C:/Users/someone/.claude/skills/deep-review/references/finding-card.md',
  ])('карточка владельца — рутина: %s', (command) => {
    expect(kind(command)).toBe('routine');
  });

  it('R-C06: значение с пробелом в `"$N"` — одно слово, как у оболочки; без кавычек — разбивается', () => {
    for (const command of [
      'N="/c/Program Files/nvm/node.exe"; "$N" node_modules/vitest/vitest.mjs run',
      'N="/c/Program Files/nvm/node.exe"; "$N" x.mjs',
      'N=/c/nvm/node.exe; "$N" x.mjs',
    ]) {
      expect(kind(command), command).toBe('other');
    }
    // Разбитое без кавычек и путь вне копии — по-прежнему человеку.
    expect(kind('N="rm -rf"; $N ~')).toBe('danger');
    expect(kind('N="git push origin main"; $N')).toBe('danger');
    expect(kind('D="/c/Users/me x"; rm -rf "$D"')).toBe('danger');
    expect(kind('D="/c/Users/me x"; rm -rf "$D/sub"')).toBe('danger');
    expect(kind('P="C:/Program Files/Git/bin/bash.exe"; "$P" -c "rm -rf ~"')).toBe('danger');
    // Подстановка без кавычек рядом с кавычками (`$D""`) разбивается: второе слово — `/c/Users`.
    expect(kind('D=".agent/tmp/x /c/Users"; rm -rf $D""')).toBe('danger');
    expect(kind('D=".agent/tmp/x /c/Users"; rm -rf "$D"')).toBe('routine');
    // Временное с пробелом в имени — то самое временное.
    expect(kind('D=".agent/tmp/a b"; rm -rf "$D"')).toBe('routine');
  });

  it('черновик во временном каталоге копии и его уборка — рутина «удаление файлов»', () => {
    const command =
      'cat > .agent/tmp/go-test-edit.txt <<\'EOF\'\nplaceholder\nEOF\nrm .agent/tmp/go-test-edit.txt; grep -n "ниже\\|wantStatus" internal/http/handlers_test.go | head; sed -n 257,330p internal/http/handlers_test.go | grep -n "name:"';
    expect(groupCommandVerdict(command, { worktree: COPY, branch: OWN })).toEqual({
      kind: 'routine',
      writes: false,
      lease: false,
      deletes: true,
    });
  });

  it.each([
    // Тело heredoc у git и cat — текст сообщения, а не команды.
    "git commit -F - <<'EOF'\nmerge notes, git push later\nrm -rf old\nEOF",
    'git commit -m "$(cat <<\'EOF\'\nfix: push and merge later\n\nrm -rf src\nEOF\n)"',
    'cat <<< "rm -rf src"',
    'git log stash@{0} -1',
    'echo ${PIPESTATUS[0]} $? $((1+2))',
    'git diff `git merge-base HEAD origin/main` --stat',
    // Подоболочка и группа: `cd` внутри скобок наружу не выходит.
    '(cd src && git status)',
    'cd src && (cd ..) && rm -rf dist',
    '{ git status; git log -1; } 2>&1 | tail -3',
    'if git diff --quiet; then echo clean; else echo dirty; fi',
    'for f in a b; do echo $f; done',
    "sed 's/a/b/g' README.md | head",
    'git config --get remote.origin.url',
    'git remote -v',
    'git tag -l',
    'git worktree list',
    'echo hi > .agent/tmp/x.txt',
    'echo hi >> /tmp/x.log',
    // Сценарий на входе оболочки разобран как команда.
    "bash <<'EOF'\ngit status\ngit log -1\nEOF",
    // `\;` — буква, а не разделитель: echo печатает «; rm -rf src».
    'echo \\; rm -rf src',
  ])('рутина: %s', (command) => {
    expect(kind(command)).toBe('routine');
  });

  it.each([
    // Сценарий и запрос на входе исполнителя.
    "bash <<'EOF'\nrm -rf src\nEOF",
    "bash <<'EOF'\ngit push origin main\nEOF",
    'bash <<< "rm -rf src"',
    "psql <<'SQL'\nDROP TABLE users;\nSQL",
    'psql <<SQL\ndelete from users;\nSQL',
    "ssh host <<'EOF'\nrm -rf /srv/app\nEOF",
    // Тело или печать, ушедшие в оболочку по трубе.
    "cat <<'EOF' | bash\nrm -rf src\nEOF",
    "cat <<'EOF' | (true; bash)\nrm -rf src\nEOF",
    "cat <<'EOF' | sh -e\ngit push --force origin feature/x\nEOF",
    'echo "git push origin main" | bash',
    // Подстановка исполняется — и внутри кавычек тоже.
    'echo $(rm -rf src)',
    'echo "$(rm -rf src)"',
    'echo "`rm -rf src`"',
    'git status $(git push origin main)',
    'git log "$(git push origin main)"',
    'bash -c "$(cat <<\'EOF\'\nrm -rf src\nEOF\n)"',
    'cat <<EOF\n$(rm -rf src)\nEOF',
    // Служебные слова и обёртки не прячут звено.
    'eval "rm -rf src"',
    'if true; then rm -rf src; fi',
    'time rm -rf src',
    '(cd ..; rm -rf repo)',
    // Кавычки, которые обходили бы простой поиск конца строки.
    "echo $'a\\'' ; rm -rf src ; echo '",
    "echo ${x:-'}'}; rm -rf src; echo '",
    // Раскрытие скобок даёт несколько целей; `merge-tree` рядом со слиянием не прячет его.
    'rm -rf {src,dist}',
    'git merge-tree HEAD origin/main && git checkout main && git merge origin/feature',
    'echo a & rm -rf src',
    'diff <(rm -rf src) b',
  ])('карточка: %s', (command) => {
    expect(kind(command)).toBe('danger');
  });

  it.each([
    "cat > src/a.ts <<'EOF'\nx\nEOF",
    'sed -i s/a/b/ README.md',
    "sed 's/a/b/w out.txt' README.md",
    'sort -o README.md README.md',
    'git diff --output=README.md',
    'git config user.name x',
    'curl -s http://localhost:3000/api/x | jq .items',
    "cat <<'EOF' | tee notes.md\nhi\nEOF",
    "python - <<'EOF'\nimport os\nEOF",
  ])('прочее: %s', (command) => {
    expect(kind(command)).toBe('other');
  });
});

describe('groupCommandVerdict — прочее решают правила чата', () => {
  it.each([
    'pnpm build',
    'git reset --hard origin/main',
    'git rebase main',
    'git branch -c old new',
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

describe('groupCommandVerdict — затирание истории: своя копия строкой, чужая человеку (23.10)', () => {
  it.each(['git reset --hard origin/main', 'git clean -fd', 'git clean -f -d .agent/tmp'])(
    'своя копия — строке «история git»: %s',
    (command) => {
      expect(kind(command)).toBe('other');
    },
  );

  it.each([
    'git clean -fdx',
    'git clean -fX',
    'git clean -f -x',
    'git -C /srv/other-repo reset --hard HEAD~3',
    'git -C ../other clean -fd',
    'git -C ../other restore .',
    'git -C ../other checkout -- src',
    'git -C ../other reflog expire --expire=now --all',
    'git -C ../other filter-branch --tree-filter true HEAD',
    'cd .. && git reset --hard',
  ])('вне копии или игнорируемое — человеку: %s', (command) => {
    expect(kind(command)).toBe('danger');
  });
});
