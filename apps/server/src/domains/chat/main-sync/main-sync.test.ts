import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  conflictsBetween,
  conflictsWith,
  isHiddenSync,
  isMainSyncRequest,
  isSoleSync,
  MAIN_SYNC_ASK,
  remoteConflicts,
  syncCandidate,
  syncsWithTarget,
  syncTarget,
} from './main-sync.ts';
import { readMergeTree, runGit, type GitResult, type GitRunner } from './conflicts.ts';

describe('syncsWithTarget', () => {
  it.each([
    'git rebase origin/main',
    'git -C C:/work/x rebase origin/main',
    'git fetch origin && git rebase origin/main',
    'git pull --rebase origin main',
    'git merge origin/main',
    'git rebase --onto origin/main HEAD~3',
    'git merge FETCH_HEAD',
  ])('догон целевой ветки: %s', (command) => {
    expect(syncsWithTarget(command)).toBe(true);
  });

  it.each([
    'git rebase --continue',
    'git rebase --abort',
    'git rebase -i HEAD~3',
    'git merge-base HEAD origin/main',
    'git pull',
    'git log origin/main..HEAD',
    'git merge feat/other',
  ])('не догон: %s', (command) => {
    expect(syncsWithTarget(command)).toBe(false);
  });

  /**
   * F-32: перестановка ветки на целевую другими подкомандами и значения ключей,
   * принятые за ссылку, обходили «догон только при конфликте».
   */
  it.each([
    'git rebase -X theirs origin/main',
    'git rebase -s ort -X ours origin/main',
    'git merge -m main origin/main',
    'git merge -S origin/main',
    'git reset --hard origin/main',
    'git reset --keep origin/main',
    'git -C x reset --soft origin/master',
    'git branch -f own origin/main',
    'git branch own2 origin/main',
    'git switch -c t origin/main',
    'git switch --detach origin/main',
    'git checkout -b t origin/main',
    'git checkout origin/main',
    'git cherry-pick HEAD..origin/main',
    'git cherry-pick -x origin/main',
    'git update-ref refs/heads/own origin/main',
    'git fetch origin +main:own',
    'git switch -c t --track origin/main',
    // Названа целевая — уже догон, не кандидат на сверку по хэшу.
    'git checkout -B feat origin/main',
    'git switch --force-create feat origin/main',
  ])('перестановка на целевую — догон: %s', (command) => {
    expect(isMainSyncRequest('Bash', { command })).toBe(true);
  });

  it.each([
    'git merge -m main feat/x',
    'git reset --hard',
    'git reset --hard HEAD',
    'git reset origin/main -- a.txt',
    'git checkout origin/main -- a.txt',
    'git branch -d main',
    'git branch --list main',
    'git fetch origin main',
    'git fetch origin',
    'git update-ref -d refs/agentdeck/backup/1',
    // Переход на локальную основную — не догон своей ветки: слияние в неё и пуш ведут правила группы.
    'git checkout main',
    'git switch main',
  ])('не перестановка на целевую: %s', (command) => {
    expect(isMainSyncRequest('Bash', { command })).toBe(false);
  });

  it('только Bash считается командой догона', () => {
    expect(isMainSyncRequest('Bash', { command: 'git rebase origin/main' })).toBe(true);
    expect(isMainSyncRequest('Edit', { command: 'git rebase origin/main' })).toBe(false);
  });

  /**
   * RF-BGCD-12b: дерево целевой ветки целиком поверх своего (без переноса
   * истории) и разница с ней, наложенная заплаткой, — тот же догон.
   */
  it.each([
    ['git checkout origin/main -- .', 'origin/main'],
    ['git checkout origin/main -- :/', 'origin/main'],
    ['git restore --source=origin/main .', 'origin/main'],
    ['git restore -s origin/main -W -S -- .', 'origin/main'],
    ['git -C x restore --source origin/master :/', 'origin/master'],
    ['git read-tree -m -u origin/main', 'origin/main'],
    ['git read-tree --reset -u FETCH_HEAD', 'FETCH_HEAD'],
    ['git diff HEAD origin/main | git apply', 'origin/main'],
    ['git diff HEAD...origin/main > p.diff && git apply p.diff', 'origin/main'],
    ['git format-patch HEAD..origin/main --stdout | git am', 'origin/main'],
  ])('догон содержимым или заплаткой: %s', (command, target) => {
    expect(isMainSyncRequest('Bash', { command })).toBe(true);
    expect(syncTarget(command)).toBe(target);
  });

  it.each([
    'git restore --source=origin/main a.txt',
    'git restore .',
    'git restore --source=HEAD~1 .',
    'git checkout origin/main -- src/a.ts',
    'git diff origin/main',
    'git diff origin/main --stat | tail',
    'git apply fix.patch',
    'git read-tree HEAD',
  ])('не догон содержимым: %s', (command) => {
    expect(isMainSyncRequest('Bash', { command })).toBe(false);
  });

  /**
   * RF-BGCD-12b, раунд 9: догон в два вызова — содержимое целевой в файл или
   * дерево, наложение следующим (`git apply p`, `patch -p1 < p`, `cp -r`). Второй
   * вызов целевую не называет, поэтому догон — сама запись, кем бы она ни была.
   */
  it.each([
    ['git diff origin/main > p.diff', 'origin/main'],
    ['git diff HEAD origin/main -o /tmp/p.diff', 'origin/main'],
    ['git diff HEAD origin/main --output=p.diff', 'origin/main'],
    ['git format-patch HEAD..origin/main', 'origin/main'],
    ['git format-patch -o /tmp/pp HEAD..origin/main', 'origin/main'],
    ['git show origin/main > tip.patch', 'origin/main'],
    ['git archive origin/main | tar -x -C /tmp/m', 'origin/main'],
    ['git archive -o /tmp/m.tar origin/main', 'origin/main'],
    ['git cat-file -p origin/main:src/a.ts > src/a.ts', 'origin/main'],
    ['git show origin/main:src/a.ts > src/a.ts', 'origin/main'],
    ['git diff HEAD origin/main | patch -p1', 'origin/main'],
    // не из списка
    ['git log -p HEAD..origin/master > l.patch', 'origin/master'],
    ['git diff HEAD origin/main | tee p.diff', 'origin/main'],
    ['git diff HEAD origin/main |& tee p', 'origin/main'],
    ['git worktree add /tmp/m origin/main', 'origin/main'],
    ['echo "$(git diff HEAD origin/main)" > p.diff', 'origin/main'],
    ['X=$(git diff HEAD origin/main); echo "$X" | git apply', 'origin/main'],
    ['git --no-pager diff HEAD FETCH_HEAD 1> p.diff', 'FETCH_HEAD'],
    ['for f in a b; do git show origin/main:$f > $f; done', 'origin/main'],
    ['git diff $(git merge-base HEAD origin/main) origin/main > p', 'origin/main'],
    ['git -C ../x diff HEAD origin/main >> p', 'origin/main'],
    ['git diff HEAD origin/main | sed --in-place x a', 'origin/main'],
    ['cd x; git diff HEAD origin/main -U0 | sh', 'origin/main'],
    ['git format-patch -1 origin/main', 'origin/main'],
  ])('содержимое целевой в файл или дерево — догон: %s', (command, target) => {
    expect(isMainSyncRequest('Bash', { command })).toBe(true);
    expect(syncTarget(command)).toBe(target);
  });

  it.each([
    'git diff origin/main',
    'git diff origin/main --stat > s.txt',
    'git diff --name-only origin/main > files.txt',
    'git diff origin/main...HEAD > .agent/tmp/rv.diff',
    'git log --oneline origin/main..HEAD > log.txt',
    'git format-patch origin/main..HEAD',
    'git format-patch origin/main',
    'git diff origin/main 2>/dev/null | head -50',
    'git show origin/main:package.json | jq .version',
    'diff <(git show origin/main:a.ts) a.ts',
    'git diff abc123..HEAD > rv.diff',
    'git show HEAD:a.ts > /tmp/a.ts',
    'git log -p -n 3 --grep main > l.txt',
    'git rev-parse origin/main > sha.txt',
    'X=$(git show origin/main:VERSION); echo $X',
    'git diff HEAD origin/main >/dev/null',
    'git show origin/main:a.ts | diff - a.ts',
    'for l in ru en; do git diff origin/main -- $l/a.mdx | grep "^[-+]"; done',
    'git show origin/main:a.go | grep -n "a\\|b" | head',
    'git show origin/main:a.go | grep -n "->"',
    'git show origin/main:a.go | grep -E "foo|bar"',
    'git format-patch --stdout HEAD..origin/main | head -40',
    'git cat-file -t origin/main > t.txt',
    'git log -p ^origin/main HEAD > own.patch',
  ])('просмотр содержимого целевой — не догон: %s', (command) => {
    expect(isMainSyncRequest('Bash', { command })).toBe(false);
  });

  // Повторная проверка 24.10: файл из `>& p`, вывод составной команды, `exec >`,
  // обёртка оболочки и ссылка через `rev-parse` или переменную — та же запись.
  it.each([
    ['git diff origin/main >& p', 'origin/main'],
    ['git diff origin/main >&p', 'origin/main'],
    ['{ git diff origin/main; } > p', 'origin/main'],
    ['(git diff origin/main) > p', 'origin/main'],
    ['if true; then git diff origin/main; fi > p', 'origin/main'],
    ['for f in a b; do git show origin/main:$f; done > out', 'origin/main'],
    ['exec > p; git diff origin/main', 'origin/main'],
    ['git diff HEAD $(git rev-parse origin/main) > p', 'origin/main'],
    ['M=origin/main; git diff "${M}" > p', 'origin/main'],
    ["bash -c 'git rebase origin/main'", 'origin/main'],
    ['sh -c "git diff origin/main > p"', 'origin/main'],
    ["eval 'git merge origin/main'", 'origin/main'],
  ])('запись целевой формой команды или в обёртке — догон: %s', (command, target) => {
    expect(isMainSyncRequest('Bash', { command })).toBe(true);
    expect(syncTarget(command)).toBe(target);
  });

  it.each([
    'git diff origin/main >&2',
    'git diff origin/main 2>&1 | head',
    '(git diff origin/main) | head',
    '{ git diff origin/main | head; }',
    'git diff origin/main | head; { echo x; } > log',
    'M=x; echo $M > p',
    "bash -c 'git diff origin/main | head'",
  ])('просмотр в составной команде или обёртке — не догон: %s', (command) => {
    expect(isMainSyncRequest('Bash', { command })).toBe(false);
  });

  /** Хэш целевой в выгрузке — кандидат для git (`isHiddenSync`), как `git rebase <sha>`. */
  it.each([
    ['git diff HEAD 3f2a1b9c > p', '3f2a1b9c'],
    ['git show 3f2a1b9c:src/a.ts > src/a.ts', '3f2a1b9c'],
    ["bash -c 'git rebase 3f2a1b9c'", '3f2a1b9c'],
  ])('выгрузка или перенос по хэшу — кандидат догона: %s', (command, start) => {
    expect(syncCandidate(command)).toBe(start);
  });

  it.each(['git diff 3f2a1b9c | head', 'git diff > p', 'git show HEAD:a.ts > /tmp/a'])(
    'просмотр по хэшу и своя выгрузка — не кандидат: %s',
    (command) => {
      expect(syncCandidate(command)).toBeUndefined();
    },
  );
});

/**
 * Правило `ask` CLI: `*` — любая строка, пустая тоже (вид, каким его проверяет
 * `tools/qa/check-group-forge-ask.mjs` настоящим CLI). RF-BGCD-12b: правила
 * reset/switch/… были без проверки — их удаление переживало набор.
 */
function askMatches(rule: string, command: string): boolean {
  const inner = /^Bash\((.*)\)$/.exec(rule)?.[1] ?? '';
  const pattern = inner
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
    .replace(/ \.\*$/, '(?: .*)?');
  return new RegExp(`^${pattern}$`).test(command);
}

describe('MAIN_SYNC_ASK — каждая подкоманда догона доходит до брокера', () => {
  it.each([
    'git rebase origin/main',
    'git pull origin main',
    'git merge origin/main',
    'git checkout -B own origin/main',
    'git switch -C own origin/main',
    'git reset --hard origin/main',
    'git -C x reset --hard origin/main',
    'git branch -f own origin/main',
    'git switch -c t origin/main',
    'git -C x switch --detach origin/main',
    'git checkout origin/main -- .',
    'git cherry-pick HEAD..origin/main',
    'git update-ref refs/heads/own origin/main',
    'git fetch origin +main:own',
    'git restore --source=origin/main .',
    'git -C x restore --source=origin/main .',
    'git read-tree -m -u origin/main',
    'git apply',
    'git am',
    'git -C x am --3way',
  ])('%s', (command) => {
    expect(MAIN_SYNC_ASK.some((rule) => askMatches(rule, command))).toBe(true);
  });

  it('контроль эмулятора: чужая команда не задета', () => {
    expect(MAIN_SYNC_ASK.some((rule) => askMatches(rule, 'git status'))).toBe(false);
    expect(MAIN_SYNC_ASK.some((rule) => askMatches(rule, 'npm test'))).toBe(false);
  });
});

describe('syncTarget', () => {
  it.each([
    ['git rebase origin/main', 'origin/main'],
    ['git fetch && git -C x rebase origin/dev', 'origin/dev'],
    ['git pull --rebase origin main', 'origin/main'],
    ['git rebase --onto origin/main HEAD~2', 'origin/main'],
    ['git merge main', 'main'],
    ['git rebase -X theirs origin/main', 'origin/main'],
    ['git reset --hard origin/main', 'origin/main'],
    ['git branch -f own origin/dev', 'origin/dev'],
    ['git switch -c t origin/main', 'origin/main'],
    ['git cherry-pick a1b2..origin/main', 'origin/main'],
    ['git fetch origin +main:own', 'origin/main'],
  ])('%s → %s', (command, ref) => {
    expect(syncTarget(command)).toBe(ref);
  });
});

// При конфликте без карточки проходит только голый догон: хвост из других звеньев
// или `-C` в чужой каталог идут обычным разбором.
describe('isSoleSync', () => {
  it.each([
    ['git merge origin/main', true],
    ['git rebase origin/main', true],
    ['git pull origin main', true],
    ['git merge origin/main && git push origin main', false],
    ['git fetch && git rebase origin/main', false],
    ['git -C ../other merge origin/main', false],
    ['git merge --continue', false],
    // Перестановка на целевую при конфликте — строкам группы (со снимком), не короткому пути.
    ['git reset --hard origin/main', false],
    ['git branch -f own origin/main', false],
    ['git push', false],
  ])('%s → %s', (command, sole) => {
    expect(isSoleSync(command)).toBe(sole);
  });
});

// Настоящий git во временном репозитории: ровно то, что брокер спросит у копии группы.
describe('conflictsWith', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'main-sync-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  writeFileSync(path.join(dir, 'a.txt'), 'feat\n');
  git('commit', '-qam', 'feat');
  git('checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'b.txt'), 'other\n');
  git('add', '.');
  git('commit', '-qm', 'other file');
  git('branch', 'clean');
  writeFileSync(path.join(dir, 'a.txt'), 'main\n');
  git('commit', '-qam', 'same line');
  git('checkout', '-q', 'feat');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('main ушёл вперёд другим файлом — конфликта нет', async () => {
    expect(await conflictsBetween(dir, 'HEAD', 'clean')).toBe(false);
  });

  it('main правил ту же строку — конфликт', async () => {
    expect(await conflictsBetween(dir, 'HEAD', 'main')).toBe(true);
  });

  it('несуществующая ссылка — не знаем, а не «нет конфликта»', async () => {
    expect(await conflictsBetween(dir, 'HEAD', 'origin/nope')).toBeUndefined();
    // Копия без `origin`: сверить с сервером нечем — тоже не знаем.
    expect(await conflictsWith(dir, 'main')).toBeUndefined();
  });

  /**
   * D2 (23.10): в копии группы `merge-tree --quiet` дал код 0 при семи
   * конфликтах. Причуду git не воспроизвести — подменён только ответ
   * `merge-tree` (граница — процесс git); пробное слияние идёт настоящим git.
   */
  const lying =
    (answer: GitResult): GitRunner =>
    (cwd, args, timeout) =>
      args[0] === 'merge-tree' ? Promise.resolve(answer) : runGit(cwd, args, timeout);

  it('merge-tree без `--quiet`: код и перечень CONFLICT читаются вместе', async () => {
    const seen: string[][] = [];
    const spy: GitRunner = (cwd, args, timeout) => {
      seen.push(args);
      return runGit(cwd, args, timeout);
    };
    expect(await conflictsBetween(dir, 'HEAD', 'main', spy)).toBe(true);
    const tree = seen.find((args) => args[0] === 'merge-tree');
    expect(tree).toEqual(['merge-tree', '--write-tree', 'HEAD', 'main']);
  });

  it('код 0 при перечне CONFLICT — не ответ: решает пробное слияние', async () => {
    const answer = {
      code: 0,
      stdout: `${'a'.repeat(40)}\n\nCONFLICT (content): Merge conflict in a.txt\n`,
    };
    expect(await conflictsBetween(dir, 'HEAD', 'main', lying(answer))).toBe(true);
  });

  it.each([128, undefined])(
    'ошибка git (код %s) — пробное слияние, а не «нет конфликта»',
    async (code) => {
      const answer = { code, stdout: '' };
      expect(await conflictsBetween(dir, 'HEAD', 'main', lying(answer))).toBe(true);
      expect(await conflictsBetween(dir, 'HEAD', 'clean', lying(answer))).toBe(false);
      // Пробная копия убрана за собой.
      expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1);
    },
  );

  it('и пробное слияние не вышло (повреждённое хранилище) — не знаем', async () => {
    const broken: GitRunner = (cwd, args, timeout) =>
      args[0] === 'merge-tree' || args.includes('worktree')
        ? Promise.resolve({ code: 128, stdout: '' })
        : runGit(cwd, args, timeout);
    expect(await conflictsBetween(dir, 'HEAD', 'main', broken)).toBeUndefined();
  });

  /** F-118: пробная копия не запускает хуки копии группы от имени панели. */
  it('пробное слияние не запускает хуки копии', async () => {
    const marker = path.join(dir, 'hook-ran').replace(/\\/g, '/');
    const hook = path.join(dir, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
    try {
      const answer = { code: 128, stdout: '' };
      expect(await conflictsBetween(dir, 'HEAD', 'main', lying(answer))).toBe(true);
      expect(existsSync(marker)).toBe(false);
      // Контроль: тот же хук на обычной смене ветки срабатывает — проверка не слепая.
      git('checkout', '-q', 'clean');
      git('checkout', '-q', 'feat');
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(hook, { force: true });
      rmSync(marker, { force: true });
    }
  });

  /**
   * RF-BGCD-12a: `diff` в пробной копии и её уборка шли без `noHooks` —
   * `core.fsmonitor` копии (программа из настроек агента) запускался от имени панели.
   */
  it('пробное слияние не запускает fsmonitor копии', async () => {
    const marker = path.join(dir, 'fsmonitor-ran').replace(/\\/g, '/');
    const script = path.join(dir, 'fsmonitor.sh').replace(/\\/g, '/');
    writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`, { mode: 0o755 });
    git('config', 'core.fsmonitor', script);
    try {
      const answer = { code: 128, stdout: '' };
      expect(await conflictsBetween(dir, 'HEAD', 'main', lying(answer))).toBe(true);
      expect(existsSync(marker)).toBe(false);
      // Контроль: тот же fsmonitor на обычном чтении индекса срабатывает — проверка не слепая.
      git('diff', '--name-only');
      expect(existsSync(marker)).toBe(true);
    } finally {
      git('config', '--unset', 'core.fsmonitor');
      rmSync(script, { force: true });
      rmSync(marker, { force: true });
    }
  });

  it.each([
    // F-121: код 1 без дерева и перечня CONFLICT — не ответ.
    [{ code: 1, stdout: 'x' }, undefined],
    [{ code: 1, stdout: `${'b'.repeat(40)}\n` }, undefined],
    [{ code: 1, stdout: `${'b'.repeat(40)}\n\nCONFLICT (content): Merge conflict in a\n` }, true],
    [{ code: 0, stdout: `${'b'.repeat(40)}\n` }, false],
    [{ code: 0, stdout: '' }, undefined],
    [{ code: 2, stdout: `${'b'.repeat(40)}\n` }, undefined],
  ] as const)('readMergeTree(%o) → %s', (result, expected) => {
    expect(readMergeTree(result)).toBe(expected);
  });
});

/**
 * F-31: конфликт MR на ревью читался по `origin/*` копии — агент переписывал
 * `refs/remotes/origin/main` на конфликтующий коммит и получал право перезаписать
 * ветку. Настоящий git: голый `origin` во временном каталоге, копия и второй клон.
 */
describe('remoteConflicts — вершины у сервера, не в копии', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'remote-conflicts-'));
  const origin = path.join(root, 'origin.git');
  const copy = path.join(root, 'copy');
  const other = path.join(root, 'other');
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  const commit = (cwd: string, file: string, text: string, message: string) => {
    writeFileSync(path.join(cwd, file), text);
    run(cwd, 'add', '.');
    run(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', message);
  };
  run(root, 'init', '-q', '--bare', '-b', 'main', origin);
  run(root, 'clone', '-q', origin, copy);
  commit(copy, 'a.txt', 'one\n', 'base');
  run(copy, 'push', '-q', 'origin', 'HEAD:main');
  run(copy, 'checkout', '-qb', 'feat');
  commit(copy, 'b.txt', 'feat\n', 'feat');
  run(copy, 'push', '-q', 'origin', 'feat');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('настоящего конфликта нет — подменённый `origin/main` его не создаёт', async () => {
    // Агент: конфликтующий коммит и `origin/main` копии на него.
    run(copy, 'checkout', '-q', '-b', 'fake', 'origin/main');
    commit(copy, 'b.txt', 'conflict\n', 'fake');
    run(copy, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    run(copy, 'checkout', '-q', 'feat');
    // Старая сверка по ссылкам копии — «конфликт есть» (это и был обход).
    expect(await conflictsBetween(copy, 'origin/feat', 'origin/main')).toBe(true);
    expect(await remoteConflicts(copy, 'feat', 'main')).toBe(false);
  });

  it('настоящий конфликт на сервере — есть, коммиты дотянуты без записи ссылок', async () => {
    run(root, 'clone', '-q', origin, other);
    commit(other, 'b.txt', 'main side\n', 'main edits b');
    run(other, 'push', '-q', 'origin', 'HEAD:main');
    const head = run(other, 'rev-parse', 'HEAD');
    const before = run(copy, 'for-each-ref');
    expect(await remoteConflicts(copy, 'feat', 'main')).toBe(true);
    // Коммит сервера теперь есть в копии, а ссылки копии не тронуты.
    expect(run(copy, 'cat-file', '-t', head)).toBe('commit');
    expect(run(copy, 'for-each-ref')).toBe(before);
  });

  it('ветки на сервере нет — не знаем', async () => {
    expect(await remoteConflicts(copy, 'nope', 'main')).toBeUndefined();
  });
});

/**
 * RF-BGCD-05: проверка догона (`conflictsWith`, `isHiddenSync`) тоже читала
 * `origin/*` копии, а `git fetch . +X:refs/remotes/origin/main` — рутина, мимо
 * правил `update-ref`. Подменённая ссылка давала «конфликт есть» (догон без
 * конфликта) и прятала догон по хэшу. Настоящий git: голый `origin`, копия, второй клон.
 */
describe('conflictsWith — целевая ветка по серверу, не по origin/* копии', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sync-truth-'));
  const origin = path.join(root, 'origin.git');
  const copy = path.join(root, 'copy');
  const other = path.join(root, 'other');
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  const commit = (cwd: string, file: string, text: string, message: string) => {
    writeFileSync(path.join(cwd, file), text);
    run(cwd, 'add', '.');
    run(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', message);
  };
  run(root, 'init', '-q', '--bare', '-b', 'main', origin);
  run(root, 'clone', '-q', origin, copy);
  commit(copy, 'a.txt', 'one\n', 'base');
  run(copy, 'push', '-q', 'origin', 'HEAD:main');
  const base = run(copy, 'rev-parse', 'HEAD');
  run(copy, 'checkout', '-qb', 'feat');
  commit(copy, 'a.txt', 'feat\n', 'feat');
  // Сервер ушёл вперёд другим файлом: настоящего конфликта нет.
  run(root, 'clone', '-q', origin, other);
  commit(other, 'b.txt', 'main side\n', 'main edits b');
  run(other, 'push', '-q', 'origin', 'HEAD:main');
  const serverMain = run(other, 'rev-parse', 'HEAD');
  // Агент: конфликтующий коммит и `origin/main` копии на него — через fetch, не update-ref.
  run(copy, 'checkout', '-q', '-b', 'fake', base);
  commit(copy, 'a.txt', 'conflict\n', 'fake');
  run(copy, 'checkout', '-q', 'feat');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('подменённый fetch-ом `origin/main` не даёт «конфликт есть»', async () => {
    run(copy, 'fetch', '-q', '.', '+fake:refs/remotes/origin/main');
    // Контроль: по ссылкам копии конфликт «есть» — это и был обход.
    expect(await conflictsBetween(copy, 'HEAD', 'origin/main')).toBe(true);
    // Ссылки нет в истории сервера — не знаем: сначала `git fetch origin`.
    expect(await conflictsWith(copy, 'origin/main')).toBeUndefined();
    // Голое `main` — ветка сервера: ответ по её вершине, а не по подменённой ссылке.
    expect(await conflictsWith(copy, 'main')).toBe(false);
  });

  it('после настоящего fetch — ответ сервера: конфликта нет', async () => {
    run(copy, 'fetch', '-q', 'origin');
    expect(run(copy, 'rev-parse', 'origin/main')).toBe(serverMain);
    expect(await conflictsWith(copy, 'origin/main')).toBe(false);
    expect(await conflictsWith(copy, `refs/remotes/origin/main`)).toBe(false);
  });

  it('отставший `origin/main` копии сверяется с вершиной сервера', async () => {
    run(copy, 'update-ref', 'refs/remotes/origin/main', base);
    commit(other, 'a.txt', 'main side\n', 'main edits a');
    run(other, 'push', '-q', 'origin', 'HEAD:main');
    // По копии конфликта нет (база), по серверу он есть.
    expect(await conflictsBetween(copy, 'HEAD', 'origin/main')).toBe(false);
    expect(await conflictsWith(copy, 'origin/main')).toBe(true);
  });

  it('хэш коммита целевой — сверка с веткой сервера, где он лежит', async () => {
    run(copy, 'fetch', '-q', 'origin');
    expect(await conflictsWith(copy, serverMain)).toBe(true);
    // Хэш не из целевой ветки сервера (свой коммит агента) — не знаем.
    expect(await conflictsWith(copy, run(copy, 'rev-parse', 'fake'))).toBeUndefined();
  });

  it('сервер не ответил — не знаем', async () => {
    const offline: GitRunner = (cwd, args, timeout) =>
      args.includes('ls-remote')
        ? Promise.resolve({ code: 128, stdout: '' })
        : runGit(cwd, args, timeout);
    expect(await conflictsWith(copy, 'origin/main', undefined, offline)).toBeUndefined();
  });

  it('догон по хэшу целевой не прячется за подменённым `origin/main`', async () => {
    run(copy, 'fetch', '-q', 'origin');
    const tip = run(copy, 'rev-parse', 'origin/main');
    expect(await isHiddenSync(copy, tip, 'main')).toBe(true);
    // Свой коммит не из целевой — не догон.
    expect(await isHiddenSync(copy, run(copy, 'rev-parse', 'fake'), 'main')).toBe(false);
    run(copy, 'fetch', '-q', '.', '+fake:refs/remotes/origin/main');
    expect(await isHiddenSync(copy, tip, 'main')).toBe(true);
  });
});

describe('syncCandidate — догон без имени целевой ветки (D2)', () => {
  it.each([
    ['git rebase 39d90705abc', '39d90705abc'],
    ['git merge 39d90705abc', '39d90705abc'],
    ['git rebase --onto 39d90705abc HEAD~2', '39d90705abc'],
    ['git -C x checkout -B feat 4a03ca18', '4a03ca18'],
    ['git switch -C feat 4a03ca18', '4a03ca18'],
    // F-32: значение ключа — не ссылка; другие перестановки — по хэшу.
    ['git rebase -X theirs 39d90705abc', '39d90705abc'],
    ['git rebase -x "make test" 39d90705abc', '39d90705abc'],
    ['git reset --hard 4a03ca18', '4a03ca18'],
    ['git branch -f own 4a03ca18', '4a03ca18'],
    ['git switch -c t 4a03ca18', '4a03ca18'],
    ['git cherry-pick 1111..4a03ca18', '4a03ca18'],
  ])('%s → %s', (command, ref) => {
    expect(syncCandidate(command)).toBe(ref);
  });

  it.each([
    'git rebase --continue',
    'git checkout -B feat',
    'git checkout -b feat origin/main',
    'git checkout -B feat origin/main',
    'git rebase origin/main',
    'git status',
  ])('не кандидат: %s', (command) => {
    expect(syncCandidate(command)).toBeUndefined();
  });
});
