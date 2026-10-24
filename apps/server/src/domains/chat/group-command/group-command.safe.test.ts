import { describe, it, expect } from 'vitest';
import { groupCommandVerdict, type GroupCommandScope } from './group-command.ts';
import { ignoredFacts } from './targets.ts';

/**
 * Политика владельца 23.10: «все безопасные команды — сами». Переменные,
 * обёртки, сценарии и восстановимое удаление в копии судятся по тому, что
 * исполнят; то, чего git не вернёт, — человеку.
 */
const COPY = 'C:/work/shop-worktrees/fix-PROJ-1567-kb';
const OWN = 'fix-PROJ-1567/kb-upload';
/**
 * Что git копии игнорирует, кроме временного: каталог проб, локальная база,
 * вложенный каталог — и локальный слой (`*.local.*`, `.dev/`), который защищён.
 */
const IGNORED = ['secrets', 'data/local.db', 'apps/web/private', 'config/app.local.json', '.dev'];
/**
 * Каталог оболочки CLI известен — корень копии. Без него относительное
 * невременное удаление решает человек (F-29), это отдельный случай ниже.
 */
const SCOPE: GroupCommandScope = { worktree: COPY, branch: OWN, ignored: IGNORED, cwd: COPY };

const kind = (command: string, scope: GroupCommandScope = SCOPE): string =>
  groupCommandVerdict(command, scope).kind;

describe('удаление в копии: временное, восстановимое, защищённое', () => {
  it.each([
    'rm -rf src',
    'rm -f notes.txt',
    'rm -rf apps/web/src/old docs/draft.md',
    `rm -rf "${COPY}/src"`,
    `cd "${COPY}" && rm -rf apps/web/src`,
    // Привязанный каталог: `secrets` из `apps/web/private` не задет.
    `cd "${COPY}" && rm -rf secrets-docs`,
    'rm -rf .agent/tmp/probe',
    'Remove-Item -Recurse -Force src/old',
    'git rm src/a.ts',
    // Карточка 23.10: свой временный тест снят, дальше чтение.
    `cd ${COPY} && rm admin-api/internal/api/zz_live_metadata_test.go && git status --short | grep -v '^??'; git ls-files e2e/bl | head -3; sed -n 40,200p e2e/bl/proj1660-live.mjs`,
  ])('рутина «удаление файлов»: %s', (command) => {
    expect(groupCommandVerdict(command, SCOPE)).toMatchObject({ kind: 'routine', deletes: true });
  });

  // Карточка 23.10, ждавшая человека 4 ч 21 мин: черновик heredoc во временном,
  // его удаление и чтение. Команда дословно, кроме имени модуля проекта.
  const HEREDOC_RM =
    'cat > .agent/tmp/go-test-edit.txt <<\'EOF\'\nplaceholder\nEOF\nrm .agent/tmp/go-test-edit.txt; grep -n "ниже\\|wantStatus: http.StatusBadRequest" svc-auth/internal/http/handlers_list_filters_test.go | head; sed -n 257,330p svc-auth/internal/http/handlers_list_filters_test.go | grep -n "name:" ';

  it('черновик heredoc во временном и его удаление — не карточка (4 ч 21 мин, 23.10)', () => {
    const verdict = groupCommandVerdict(HEREDOC_RM, SCOPE);
    expect(verdict.kind).not.toBe('danger');
    expect(verdict).toMatchObject({ deletes: true });
    // Тот же черновик вне копии — уже не уборка своей копии.
    expect(kind(HEREDOC_RM.replace(/\.agent\/tmp\/go-test-edit/g, '../other/go-test-edit'))).toBe(
      'danger',
    );
  });

  // Карточка группы №1 (23.10, 08:02Z), дословно: пробный репозиторий во
  // временном каталоге из `mktemp -d`, коммит в нём и его удаление.
  const MKTEMP_REPO =
    'd=$(mktemp -d); cd "$d"; git init -q; echo a > a.txt; git add --all; time (timeout 60 git commit -q -m x; echo "commit exit $?"); cd /; rm -rf "$d" 2>/dev/null; echo done';

  it('пробный репозиторий в свежем `mktemp -d` — сам (карточка группы №1, 23.10)', () => {
    expect(groupCommandVerdict(MKTEMP_REPO, SCOPE)).toMatchObject({ kind: 'routine' });
    for (const made of ['$(mktemp -d -t probe.XXXXXX)', '$(mktemp -d "${TMPDIR:-/tmp}/x.XXXX")']) {
      expect(kind(MKTEMP_REPO.replace('$(mktemp -d)', made)), made).toBe('routine');
    }
  });

  it.each([
    // Переменную переназначили между `mktemp` и `cd`: каталог уже не свежий временный.
    'd=$(mktemp -d); d=/srv/repo; cd "$d"; git init -q; git add --all; git commit -q -m x',
    'd=$(mktemp -d); d=$(cat dir.txt); cd "$d"; git add --all; git commit -q -m x',
    // `TMPDIR` переопределён в той же команде: `mktemp` создаст каталог там.
    'TMPDIR=/srv; d=$(mktemp -d); cd "$d"; git init -q; git add --all',
    // Подъём из временного каталога.
    'd=$(mktemp -d); rm -rf "$d/../x"',
    'd=$(mktemp -d); rm -rf "$d/.."',
    'd=$(mktemp -d); cd "$d/.."; rm -rf x',
    // Довод уводит git из пробного репозитория: чужой путь, общие настройки.
    'd=$(mktemp -d); cd "$d"; git init -q /srv/repo',
    'd=$(mktemp -d); cd "$d"; git init -q ../repo',
    'd=$(mktemp -d); cd "$d"; git config --global user.name x',
    // Пуш из пробного репозитория уходит наружу.
    'd=$(mktemp -d); cd "$d"; git init -q; git remote add o https://example.com/r.git; git push o HEAD:main',
  ])('не пробный репозиторий — не сам: %s', (command) => {
    expect(kind(command)).not.toBe('routine');
  });

  it('`mktemp` без `-d` — файл: `cd` в него не войдёт, git останется там, где был', () => {
    const outside: GroupCommandScope = { ...SCOPE, worktree: undefined };
    expect(kind('d=$(mktemp); cd "$d"; git init -q; git add --all', outside)).not.toBe('routine');
  });

  // R-C02 (ревью корпуса 23.10): игнорируемое вне локального слоя в своей копии —
  // зеркало основной копии или сделанное группой; уборка его — своя работа.
  it.each([
    'rm -rf data',
    'rm -rf data/local.db',
    'rm -rf private',
    'rm -f apps/web/private/cache.json',
    'rm -f apps/web/private/cache*',
  ])('игнорируемое вне локального слоя — само: %s', (command) => {
    expect(groupCommandVerdict(command, SCOPE)).toMatchObject({ kind: 'routine', deletes: true });
  });

  it.each([
    // Игнорируемое локального слоя: внутри цели или сама цель.
    'rm -rf config',
    'rm -f config/app.local.json',
    'rm -rf .dev',
    'rm -rf .agent',
    'rm -rf .agent/notes.md',
    'rm -rf .claude/settings.local.json',
    // Игнорируемое с именем секрета: зеркало его могло не копировать, git не вернёт.
    'rm -rf secrets',
    'rm -f secrets/key.pem',
    'rm -f secrets/*.pem',
    'rm -f apps/web/private/tls.pem',
    // Шаблон цели задевает игнорируемый секрет или может попасть в секрет.
    'rm -rf secret*',
    'rm -f apps/web/private/cred*',
    'rm -f .env',
    'rm -f apps/api/.env.production',
    'rm -rf .git',
    'rm -rf .git/hooks',
    'rm -rf .',
    `rm -rf "${COPY}"`,
    'rm -rf ../repo',
    'rm -rf src/*/fixtures',
    'rm -rf "$UNKNOWN"',
    'rm -rf $(cat list.txt)',
  ])('карточка: %s', (command) => {
    expect(kind(command)).toBe('danger');
  });

  it('каталог, внутри которого игнорируемый секрет, — карточка; с игнорируемым кэшем — само', () => {
    const nested = (ignored: string[]): GroupCommandScope => ({ ...SCOPE, ignored });
    expect(kind('rm -rf apps/api', nested(['apps/api/secrets']))).toBe('danger');
    expect(kind('rm -rf apps/api', nested(['apps/api/certs/tls.key']))).toBe('danger');
    expect(kind('rm -rf apps/api', nested(['apps/api/cache']))).toBe('routine');
  });

  it('без списка игнорируемого невременное — человеку, как раньше', () => {
    const blind: GroupCommandScope = { worktree: COPY, branch: OWN };
    expect(kind('rm -rf src', blind)).toBe('danger');
    expect(kind('rm -rf dist', blind)).toBe('routine');
  });

  it('на Windows регистр букв пути не спасает игнорируемое', () => {
    if (process.platform !== 'win32') return;
    expect(kind('rm -rf CONFIG/App.Local.json')).toBe('danger');
    expect(kind('rm -rf .AGENT/notes.md')).toBe('danger');
  });

  it('список игнорируемого от git: косая на конце снята, временное отброшено', () => {
    expect(ignoredFacts('secrets/\0node_modules/\0.env\0apps/web/dist/\0data/x.db\0')).toEqual([
      'secrets',
      '.env',
      'data/x.db',
    ]);
  });
});

describe('переменные, подстановки и каталог оболочки', () => {
  it.each([
    'S=.agent/tmp/x; rm -rf "$S"',
    'export OUT=dist; rm -rf "$OUT" && echo done',
    'T=$(mktemp -d); echo hi > "$T/a"; rm -rf "$T"',
    'T="$(mktemp -t probe.XXXX)"; cat README.md > $T; rm -f $T',
    'D=src/old; rm -rf ${D}',
    'FOO=1 rm -rf dist',
    'T=$(mktemp -d); rm -rf "$T/agent-probe"',
    'pushd src && popd && rm -rf dist',
    // Карточка владельца 23.10: ревизия в переменной, вывод во временный файл копии.
    "M=$(git rev-parse origin/main); git merge-tree --write-tree --name-only HEAD $M > .agent/tmp/mt.txt 2>&1; echo \"mt=$?\"; sed -n '2,60p' .agent/tmp/mt.txt | grep -v '^$' | head -30",
  ])('рутина: %s', (command) => {
    expect(kind(command)).toBe('routine');
  });

  it('без точного каталога подъём к временному копии — уборка, к прочему — карточка', () => {
    // Оболочка агента стояла в подкаталоге копии (`apps/web`): `..` — ещё копия.
    expect(kind('cd .. && rm -rf .agent/tmp/probe')).toBe('routine');
    expect(kind("cat > ../.agent/tmp/head.txt <<'EOF'\nx\nEOF\nrm ../.agent/tmp/head.txt")).toBe(
      'routine',
    );
    expect(kind('rm -rf ../../dist')).toBe('routine');
    expect(kind('cd .. && rm -rf src')).toBe('danger');
    expect(kind('rm -rf ../other-repo/.agent/tmp/x')).toBe('danger');
    // Каталог известен точно — `..` из корня копии уже вне её.
    expect(kind(`cd "${COPY}" && cd .. && rm -rf .agent/tmp/probe`)).toBe('danger');
    expect(kind(`rm -rf "${COPY}/../.agent/tmp/x"`)).toBe('danger');
  });

  it('`cd` в свежий `mktemp -d` и уборка в нём — рутина; в `/tmp` — человеку; прочее — правила чата', () => {
    expect(
      groupCommandVerdict('d=$(mktemp -d) && cd "$d" && rm -rf agent-probe', SCOPE),
    ).toMatchObject({ kind: 'routine', deletes: true });
    // Решение владельца 23.10 (F-77): `/tmp` общий — там чужое.
    expect(kind('cd /tmp && rm -rf agent-probe')).toBe('danger');
    expect(kind('cd ../other && git status')).toBe('other');
    expect(kind('cd ../other && git push origin HEAD:feature/a')).toBe('danger');
  });

  it.each([
    'B=$(git branch --show-current); git push origin "HEAD:$B"',
    'git push origin "HEAD:$(git branch --show-current)"',
    'git push --force-with-lease origin "HEAD:$(git rev-parse --abbrev-ref HEAD)"',
  ])('своя ветка по подстановке — пуш рутиной: %s', (command) => {
    expect(groupCommandVerdict(command, SCOPE)).toMatchObject({ kind: 'routine', writes: true });
  });

  it.each([
    // Переменная, чьё значение не проследить: цикл, чтение, `+=`, неизвестное.
    'for f in $(ls); do rm -rf "$f"; done',
    'while read f; do rm -f "$f"; done < list.txt',
    'S=src; S+=/x; rm -rf "$S"',
    'S=.agent/tmp; unset S; rm -rf "$S/x"',
    // Временный каталог системы вне свежего `mktemp` — не своё (решение владельца 23.10, F-77).
    'rm -rf "$TMPDIR/agent-probe"',
    'rm -rf /tmp/*',
    // Подоболочка не выносит переменную наружу.
    '(S=.agent/tmp/x); rm -rf "$S"',
    // `mktemp` с шаблоном-путём — уже не временный каталог системы.
    'T=$(mktemp ./keep.XXXX); rm -rf "$T"',
    // Каталог, ушедший из копии.
    'pushd .. && rm -rf repo; popd',
    'cd src && cd ../.. && rm -rf repo',
    // Ветка, сменённая в той же команде, — уже не своя.
    'git checkout -b other && B=$(git branch --show-current) && git push --force-with-lease origin "HEAD:$B"',
  ])('карточка: %s', (command) => {
    expect(kind(command)).toBe('danger');
  });

  it('окружение git, уводящее его в другой репозиторий, — не рутина', () => {
    expect(kind('GIT_PAGER=cat git log -3')).toBe('routine');
    expect(kind('GIT_TRACE=1 git status')).toBe('routine');
    expect(kind('GIT_DIR=../x/.git git status')).toBe('other');
    expect(kind('export GIT_WORK_TREE=/x; git push origin HEAD:feature/a')).toBe('danger');
    expect(kind('GIT_INDEX_FILE=/tmp/i git push origin HEAD:feature/a')).toBe('danger');
  });
});

describe('git: откат файлов, `-c`, удаление отслеживаемого', () => {
  it.each([
    // Снимок владельца 23.10: откат своих правок и сверка в одной команде.
    `git checkout -- cp-ca/go.mod inst-telemetry/go.mod; git status --short | head; B=$(git merge-base HEAD origin/main); echo base=$B; for l in ru en uz; do f=docs/$l/users.mdx; git diff --stat $B origin/main -- $f; done`,
    'git checkout HEAD -- src/a.ts',
    'git restore src/a.ts src/b.ts',
    'git restore --staged --worktree src/a.ts',
    'git restore --source=HEAD~1 src/a.ts',
  ])('откат восстановимого — рутина: %s', (command) => {
    expect(kind(command)).toBe('routine');
  });

  it.each([
    'git restore --staged src/a.ts',
    'git rm -n -r src',
    'git rm -r --cached dist',
    'git -c color.ui=always log --oneline -3',
    'git -c core.quotepath=false status --short',
    'git -c core.pager=cat diff --stat',
    'git --no-pager log -1',
  ])('индекс, пробный прогон и безопасный `-c` — рутина: %s', (command) => {
    expect(kind(command)).toBe('routine');
  });

  it.each([
    // То, чего git не вернёт: строка «история git» решает, а не уборка.
    'git checkout -- .env',
    'git checkout -- config/app.local.json',
    'git checkout -- .',
    'git restore .agent/notes.md',
    'git rm -r .claude',
  ])('прочее — правила чата: %s', (command) => {
    expect(kind(command)).toBe('other');
  });

  it.each([
    // F-20: `-c`, глобальная опция или ключ, исполняющие программу или меняющие репозиторий.
    'git -c diff.external=./x.sh diff',
    'git -c core.fsmonitor=./x status',
    'git -c core.editor=./x.sh commit',
    'git --git-dir=../x/.git status',
    'git --exec-path=/tmp/x status',
    'git fetch --upload-pack=./x.sh .',
    'git ls-remote --upload-pack=./x.sh .',
    "git rebase -x 'rm -rf ~' main",
    'git rebase --exec=./x.sh origin/main',
    "git submodule foreach 'rm -rf ~'",
    'git bisect run ./x.sh',
    'git difftool -x ./x.sh',
    'git clone -c core.fsmonitor=./x.sh https://example.com/r.git /tmp/r',
    'git fetch ext::sh\\ -c\\ x',
    // F-21: ссылки и хранилище, общие для всех копий репозитория.
    'git filter-branch -- --all',
    'git reflog expire --expire=now --all',
    'git gc --prune=now',
    'git -c gc.pruneExpire=now gc',
    'git prune',
    'git update-ref refs/remotes/origin/main HEAD',
    'git update-ref -d refs/heads/feature/a',
    'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/feature/a',
    'git remote set-url origin https://example.com/other.git',
    'git branch -f feature/a origin/main',
    'git branch -m feature/a feature/b',
    'git tag -f v1 HEAD',
    'git checkout -B feature/a origin/main',
    // F-26: запись программы в настройки — и в своей копии, и в пробном репозитории.
    'git config core.fsmonitor ./x.sh',
    'git config alias.st "!./x.sh"',
    'd=$(mktemp -d) && git -C "$d" init && git -C "$d" config core.fsmonitor ./x.sh && git -C "$d" status',
    // F-27: принудительный пуш вместе с метками.
    'git push --force --tags origin feature/a',
    'git push --force-with-lease --follow-tags',
  ])('исполняет программу или переписывает общее — человеку: %s', (command) => {
    expect(kind(command)).toBe('danger');
  });

  it.each([
    'git -c core.editor=true commit --amend --no-edit',
    'git config pull.rebase true',
    'git config --get user.email',
    'git --version',
  ])('безопасная запись настроек, справка — не человеку: %s', (command) => {
    expect(kind(command)).not.toBe('danger');
  });

  it('пуш за небезопасным `-c` — человеку', () => {
    expect(kind('git -c core.hooksPath=./hooks push origin HEAD:feature/a')).toBe('danger');
    // Отключение хуков на одну команду — как `--no-verify` (решение владельца 23.10).
    expect(kind('git -c core.hooksPath=/dev/null push origin HEAD:feature/a')).toBe('routine');
    expect(kind('git -c color.ui=never push origin "HEAD:feature/a"')).toBe('routine');
  });

  it.each([
    // Корпус карточек 23.10: снос своих черновых копий после сверки.
    'git worktree remove --force .agent/tmp/scratch-rv1050 2>&1; git worktree remove --force .agent/tmp/scratch-base 2>&1; git worktree prune; git worktree list | grep -c scratch',
    'L=.agent/tmp; git worktree add -q --detach $L/base-wt origin/main 2>&1; git worktree remove --force $L/base-wt',
  ])('снос временной рабочей папки внутри своей копии — уборка: %s', (command) => {
    // `prune` судится по живому списку копий (`withWorktree`): здесь сносить нечего.
    expect(groupCommandVerdict(command, { ...SCOPE, prunable: [] })).toMatchObject({
      kind: 'routine',
      deletes: true,
    });
  });

  it.each([
    // Соседняя копия, сама копия, неизвестная цель — несохранённое там не группы.
    'git worktree remove /c/work/shop-worktrees/_scratch-review-9c2549',
    'git worktree remove --force ../fix-PROJ-1600-other',
    'git worktree remove --force .',
    'git worktree remove --force src',
    'git worktree remove --force $WT',
    // Решение владельца 23.10: рабочая папка вне своей копии — человеку, временная тоже.
    'git worktree remove /tmp/review-wt',
  ])('снос прочей рабочей папки — человеку: %s', (command) => {
    expect(kind(command)).toBe('danger');
  });

  it.each([
    // Карточки 23.10: сверка своих коммитов с основной, ничего не пишет в ветки.
    `for c in 19069cce28 7991017f6b de58c8a86d; do git merge-base --is-ancestor $c 5018e7d6b5 && echo "$c in base" || echo "$c NOT in base"; done; git diff origin/main HEAD -- docs/content/ru/access/users.mdx | sed -n 1,30p | grep -E '^[-+]' | head -12`,
    `T=$(git merge-tree --write-tree HEAD origin/main | head -1); for l in ru en uz; do git show $T:docs/content/$l/access/users.mdx | grep -c -E "AI Use Case|inventory" ; git show origin/main:docs/content/$l/access/users.mdx | grep -c -E "AI Use Case|inventory"; done; git diff 5018e7d6b5 origin/main --stat -- 'docs/content/*/access/users.mdx'`,
  ])('сверка с основной — рутина: %s', (command) => {
    expect(kind(command)).toBe('routine');
  });

  it.each([
    'git branch -d rebuild/proj1298-chat-permissions',
    'git branch --delete -q rebuild/a tmp/b',
    'B=rebuild/x; git branch -d $B 2>&1 | tail -1',
  ])('удаление ветки даже без силы — человеку (решение владельца 23.10): %s', (command) => {
    expect(kind(command)).toBe('danger');
  });

  // Решение владельца 23.10: копия внутри своей или во временном — само, в прочем месте — человеку.
  it('черновая копия во временном или в своей — запись в git; в прочем месте — человеку', () => {
    expect(
      groupCommandVerdict('git worktree add -q --detach .agent/tmp/wt origin/main', SCOPE),
    ).toMatchObject({ kind: 'routine', writes: true });
    // Создание — запись: `/tmp` и `$TMPDIR` для неё временное (F-77 — только про удаление).
    for (const place of ['/tmp/wt-x', '"$TMPDIR/wt"', `${COPY}/wt`]) {
      expect(
        groupCommandVerdict(`git worktree add ${place} origin/main`, SCOPE),
        place,
      ).toMatchObject({ kind: 'routine', writes: true });
    }
    expect(kind('git worktree add -b tmp-x ../sibling origin/main')).toBe('danger');
    expect(kind('git worktree add C:/elsewhere/wt origin/main')).toBe('danger');
    // `-B` переставит существующую ветку: только свою.
    expect(kind('git worktree add -B feat/other /tmp/wt origin/main')).toBe('danger');
    expect(kind(`git worktree add -B ${OWN} /tmp/wt origin/main`)).toBe('routine');
  });

  // F-05: шаблон оболочки, задевающий `.git`, — человеку, не строке «история git».
  it.each([
    'git checkout -- .g*',
    'git checkout -- .gi?',
    'git checkout -- .[g]it/config',
    'git restore -- .g*',
    'git rm -f .g*',
  ])('%s — человеку', (command) => {
    expect(kind(command)).toBe('danger');
  });

  it('путь, лишь похожий на `.git`, — по-прежнему перезапись своего', () => {
    expect(kind('git checkout -- .gitignore')).not.toBe('danger');
    expect(kind('git checkout -- .github/workflows/ci.yml')).not.toBe('danger');
  });
});

describe('обёртки: судится то, что они исполнят', () => {
  it.each([
    'timeout 600 git log --oneline -20 2>&1 | tail -20',
    'timeout -k 5 60 git status',
    'nice -n 10 git log -3',
    'nohup git fetch origin',
    'env -u FOO git status',
    'env CI=1 git diff --stat',
    'command -v pnpm',
    'command git status',
    'stdbuf -oL git log -3',
    "bash -c 'git status && git log -1'",
    "sh -ec 'rm -rf dist coverage'",
    "eval 'git status'",
    'T=$(mktemp -d); trap \'rm -rf "$T"\' EXIT; git status',
    "cmd /c 'dir C:\\work'",
    'cmd.exe /d /s /c del /q build.log',
    'find . -name "*.log" -delete',
    'find . -name __pycache__ -exec rm -rf {} +',
    'find . -type d -empty -delete',
    'find src -name "*.ts" | head',
    'find . -name "*.ts" -exec grep -n TODO {} \\;',
    'git ls-files | xargs grep -n TODO',
    'xargs -0 cat < list.txt',
  ])('рутина: %s', (command) => {
    expect(kind(command)).toBe('routine');
  });

  it.each([
    "bash -c 'git push origin main'",
    "sh -c 'rm -rf .git'",
    'timeout 60 git push --force origin HEAD:feature/a',
    "eval 'rm -rf .agent'",
    "trap 'rm -rf .' EXIT",
    'cmd /c rd /s /q ..\\repo',
    'find . -delete',
    'find .agent -name "*.md" -delete',
    'find . -name "*.md" -exec rm {} \\;',
    'git ls-files | xargs rm -f',
    'env -C ../other git push origin HEAD:feature/a',
  ])('карточка: %s', (command) => {
    expect(kind(command)).toBe('danger');
  });
});

describe('код интерпретатора и запись вывода', () => {
  it.each([
    // `del` — оператор Python, `.drop(columns=…)` — таблица pandas.
    `python -c "d = {'a': 1}; del d['a']; print(d)"`,
    `python -c "import pandas as pd; df = pd.read_csv('a.csv'); print(df.drop(columns=['x']).head())"`,
    `node -e "console.log(require('./package.json').version)"`,
  ])('правила чата без совпадений: %s', (command) => {
    expect(groupCommandVerdict(command, SCOPE)).toMatchObject({
      kind: 'other',
      texts: [],
      rules: [],
    });
  });

  it('код, что удаляет файлы или пишет в базу, отдаётся своей строке', () => {
    expect(
      groupCommandVerdict(`node -e "require('fs').rmSync('x', {recursive: true})"`, SCOPE),
    ).toMatchObject({ kind: 'other', rules: ['filesDelete'] });
    expect(
      groupCommandVerdict(`python -c "cur.execute('insert into users values (1)')"`, SCOPE),
    ).toMatchObject({ kind: 'other', rules: ['database'] });
  });

  it.each([
    `python -c "import subprocess; subprocess.run(['git', 'push', 'origin', 'main'])"`,
    `node -e "require('child_process').execSync('git push origin main')"`,
    `python -c "cur.execute('drop table users')"`,
  ])('код со сносом, пушем или слиянием — человеку: %s', (command) => {
    expect(kind(command)).toBe('danger');
  });

  it.each([
    'pnpm test 2>&1 | tee .agent/tmp/test.log | tail -5',
    'git log -3 | tee /dev/null',
    "awk '{print $1}' README.md | sort | uniq -c",
    "awk -F: 'NR > 1 { n += 1 } END { print n }' list.txt",
  ])('чтение и запись во временное — рутина или прочее без правила: %s', (command) => {
    const verdict = groupCommandVerdict(command, SCOPE);
    expect(
      verdict.kind === 'routine' || (verdict.kind === 'other' && verdict.rules.length === 0),
    ).toBe(true);
  });

  // awk судится по тому, что делает (`programs.ts`, тесты — `autonomy.test.ts`).
  it('запись в файл — не рутина: git log -3 | tee notes.md', () => {
    expect(kind('git log -3 | tee notes.md')).not.toBe('routine');
  });
});

describe('правила чата судят только тексты неузнанных звеньев', () => {
  it('чтение и сценарий на входе исполнителя в тексты не попадают', () => {
    const grep = groupCommandVerdict('grep -rn "drop table" src | head', SCOPE);
    expect(grep.kind).toBe('routine');
    const draft = groupCommandVerdict(
      "cat > migrations/001.sql <<'EOF'\ndrop table users;\nEOF",
      SCOPE,
    );
    expect(draft).toMatchObject({ kind: 'other', texts: ['cat'] });
  });

  it('неузнанное звено отдаёт правилам чата свой текст, а не всю строку', () => {
    const verdict = groupCommandVerdict(
      'git status && pnpm build && grep -n drop README.md',
      SCOPE,
    );
    expect(verdict).toMatchObject({ kind: 'other', texts: ['pnpm build'] });
  });
});
