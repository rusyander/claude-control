import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GROUP_REQUEST_DEFAULTS } from '@agentdeck/contracts/split-groups';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupDecision } from '../group-permissions.ts';
import { gitDestroys } from '../group-tree-state.ts';
import { groupCommandVerdict } from './group-command.ts';

/**
 * RF-BGCD, раунд 7 (сквозные пункты координатора 24.10), по классам:
 * 1. `git send-pack` — тот же пуш, что `git push`;
 * 2. «куда уйдёт пуш»: `git remote`/`git config`/`-c`/окружение, а также запись
 *    в хранилище git мимо `git config` (`>> .git/config`, `sed -i`, `cp` в
 *    `$(git rev-parse --git-path config)`, крючки) — человеку;
 * 3. «имя команды из подстановки»: `$g push`, `$(echo git) push`, псевдоним
 *    `alias g=git` — что исполнится, не прочесть, человеку.
 */
const slash = (path: string): string => path.replace(/\\/g, '/');
const bash = (script: string, cwd: string): string =>
  execFileSync('bash', ['-c', script], { cwd, encoding: 'utf8' });

describe('куда уйдёт пуш и чем станет имя команды — человеку', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'redirect-')));
  const copy = join(base, 'shop-worktrees', 'fix-a');
  const pad = join(base, 'claude', 'proj', 'session', 'scratchpad');
  const scope = { worktree: copy, cwd: copy, branch: 'fix/a', ignored: [], scratchpad: pad };
  const group = {
    rows: { ...GROUP_REQUEST_DEFAULTS },
    allowEdits: true,
    worktree: copy,
    base: 'main',
    ownBranch: 'fix/a',
    ignored: [],
    shellCwd: copy,
    scratchpad: pad,
    parentChatId: 'p',
    groupIndex: 0,
    tree: { dirty: false as const },
  };
  const decide = (command: string): string =>
    groupDecision(group, { toolName: 'Bash', input: { command }, guardedPatterns: [] });
  const kind = (command: string): string => groupCommandVerdict(command, scope).kind;

  beforeAll(() => {
    mkdirSync(join(copy, '.agent', 'tmp'), { recursive: true });
    writeFileSync(join(copy, '.git'), 'gitdir: elsewhere\n');
    mkdirSync(join(base, 'shop', '.git'), { recursive: true });
    mkdirSync(pad, { recursive: true });
    // Связка каталогов Windows (прав на ссылки не нужно): существующий путь в `.git`.
    symlinkSync(join(base, 'shop', '.git'), join(base, 'shop-worktrees', 'meta'), 'junction');
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('на диске: дозапись в общий `config` из копии уводит пуш копии', () => {
    const live = join(base, 'live');
    mkdirSync(live);
    bash(
      'git init -q -b main shop && cd shop && git commit -q --allow-empty -m a ' +
        '&& git remote add origin https://example.com/shop.git && git worktree add -q ../wt -b fix/a',
      live,
    );
    bash(
      `printf '[remote "origin"]\\n\\tpushurl = ../evil\\n' >> "$(git rev-parse --git-common-dir)/config"`,
      join(live, 'wt'),
    );
    expect(bash('git remote get-url --push origin', join(live, 'wt')).trim()).toBe('../evil');
  });

  it('на диске: оболочка раскрывает псевдоним, объявленный строкой выше', () => {
    expect(bash('shopt -s expand_aliases\nalias g=echo\ng aliased', base).trim()).toBe('aliased');
  });

  it.each([
    'git send-pack origin HEAD:main',
    'git send-pack ../shop :fix/a',
    'git send-pack --all ../shop',
    'git send-pack --mirror origin',
    'git send-pack --stdin origin < refs.txt',
  ])('`send-pack` судится как пуш: %s', (command) => {
    expect(kind(command)).toBe('danger');
    expect(decide(command)).toBe('human');
  });

  it('одиночный чат: удаление ветки через `send-pack` — удаление, как у `push`', () => {
    const destroys = (command: string): boolean => gitDestroys('Bash', { command });
    expect(destroys('git send-pack origin :old')).toBe(true);
    expect(destroys('git send-pack --mirror origin')).toBe(true);
    expect(destroys('git -c alias.sp=send-pack sp origin :old')).toBe(true);
    expect(destroys('git send-pack origin HEAD:feature')).toBe(false);
  });

  it.each([
    // из списка ревью
    'git remote set-url origin https://evil.example/x.git',
    'git remote add evil ../x && git push evil HEAD:fix/a',
    'git config remote.origin.pushurl ../x',
    'git config url.https://evil.example/.pushInsteadOf https://gitlab.com/',
    'git -c remote.origin.pushurl=../x push origin HEAD:fix/a',
    // не из списка ревью: ключи и окружение
    'git config Remote.Origin.Url ../x',
    'git config include.path ../x.cfg',
    'git config branch.fix/a.pushRemote evil',
    'GIT_CONFIG_PARAMETERS="\'remote.origin.pushurl=../x\'" git push origin HEAD:fix/a',
    'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url GIT_CONFIG_VALUE_0=../x git push origin HEAD:fix/a',
    // не из списка ревью: запись в хранилище git мимо `git config`
    'echo \'[remote "origin"] pushurl = ../x\' >> .git/config',
    `printf '[remote "origin"]\\n\\tpushurl = ../x\\n' >> "$(git rev-parse --git-common-dir)/config"`,
    'cp x.cfg "$(git rev-parse --git-path config)"',
    'echo x > `git rev-parse --git-path hooks`/pre-push',
    'cp hook "$(git config --get core.hooksPath)/pre-push"',
    'echo x | tee "$GIT_DIR/config"',
    'tee -a ../../shop/.git/config < x',
    'mv x.cfg ../../shop/.GIT/config',
    'echo x > ../../shop/GIT~1/config',
    // каталога ещё нет — настоящий путь не подскажет, решает само имя
    'mv x.cfg ../../nowhere/.GIT/config',
    // путь не раскрыть вовсе — только по тексту, без регистра
    'echo x >> "$REPO/.Git/config"',
    'echo x > ../../nowhere/GIT~1/config',
    'echo x > ../../shop/.gi?/config',
    'cp hook ../meta/hooks/pre-push',
    "sed -i 's/github/evil/' ../../shop/.git/config",
    "perl -pi -e 's/github/evil/' ../../shop/.git/config",
    "awk -i inplace '{print}' ../../shop/.git/config",
    "python -c \"open('.git/config','a').write('x')\"",
  ])('куда уйдёт пуш меняет человек: %s', (command) => {
    expect(kind(command)).toBe('danger');
    expect(decide(command)).toBe('human');
  });

  it.each([
    // из списка ревью
    'g=git; $g push origin HEAD:main',
    'G=git; "$G" push origin HEAD:main',
    'g=git; ${g} push origin HEAD:main',
    '$(echo git) push origin HEAD:main',
    '`echo git` push origin HEAD:main',
    // не из списка ревью
    '${GIT:-git} push origin HEAD:main',
    'cmd=(git push origin HEAD:main); "${cmd[@]}"',
    'alias g=git; g push origin HEAD:main',
    "alias gp='git push'\ngp origin HEAD:main",
    'alias "$a"; make',
  ])('имя команды из подстановки — человеку: %s', (command) => {
    expect(decide(command)).toBe('human');
  });

  it.each([
    'git send-pack origin HEAD:fix/a',
    'git push origin HEAD:fix/a',
    'git config --get remote.origin.url',
    'git remote -v',
    'echo x > .gitignore',
    'echo x >> .github/x.yml',
    'echo x > "$(git rev-parse --show-toplevel)/.agent/tmp/x.log"',
    'echo x >> "$(git branch --show-current).log"',
    "sed -i 's/a/b/' src/x.ts",
    "perl -pi -e 's/a/b/' src/x.ts",
    "perl -e 'print `git rev-parse HEAD`'",
    // в одинарных кавычках подстановки нет: имя файла буквально
    "echo x > 'notes-$GIT_DIR.txt'",
    'cat ../../shop/.git/config',
    // корпус 24.10: списки файлов дерева и код, читающий `.git`, — работа
    "sed -i 's/a/b/' $(git diff --name-only --diff-filter=U)",
    'node .agent/tmp/resolve.mjs $(git diff --name-only --diff-filter=U)',
    'node tools/ledger.mjs add "HEAD $(git rev-parse --short HEAD) ok"',
    `node -e "const j=require('C:/work/shop/.git/mustfail/journal-1.json'); console.log(j)"`,
    'alias',
    'alias ll; npm run build',
    // слово программы — JSON с «шаблоном» `[core-003]` (диапазон e-0 перевёрнут)
    `node tools/tests-cli.mjs case --json '{"file":"a/b.mjs","testName":"[core-003] x"}'`,
    'npm run build',
  ])('обычная работа остаётся без человека: %s', (command) => {
    expect(decide(command)).not.toBe('human');
  });

  // Раунд 8: PowerShell — любой командлет или псевдоним; решает имя хранилища.
  it.each([
    // из списка координатора
    'powershell -NoProfile -Command "Set-Content -Path .git/config -Value x"',
    `pwsh -c "Add-Content ../../shop/.git/config 'x'"`,
    "pwsh -c 'Out-File -FilePath ../../shop/.git/hooks/pre-push -InputObject x'",
    `pwsh -c "'x' >> .git\\config"`,
    'pwsh -c "sc .git/config x"',
    'pwsh -c "ni ../../shop/.git/hooks/pre-push -Value x -Force"',
    'pwsh -c "copy hook ..\\..\\shop\\.git\\hooks\\pre-push"',
    `pwsh -c "[IO.File]::AppendAllText('../../shop/.git/config', 'x')"`,
    // не из списка
    `pwsh -c "$s = New-Object IO.StreamWriter('../../shop/.git/config', $true); $s.Write('x')"`,
    'pwsh -c "& { Set-Content (Join-Path (git rev-parse --git-common-dir) config) x }"',
    'pwsh -c "Copy-Item -Destination:../../shop/.GIT/config -Path x.cfg"',
    'pwsh -c "Set-Content -LiteralPath ../../nowhere/GIT~1/config x"',
    `pwsh -c "Set-Content (Join-Path $env:GIT_DIR 'config') x"`,
    'pwsh -c "Set-Content ..\\meta\\hooks\\pre-push x"',
    'pwsh -c "Copy-Item x.cfg -Destination:..\\meta\\config"',
    `pwsh -c "Set-Content -Path ('..\\meta\\hooks\\pre-push') x"`,
    'pwsh -NoProfile -File fix.ps1 ../../shop/.git/config',
    'cmd //c "powershell -c Set-Content .git/config x"',
  ])('PowerShell по пути хранилища git — человеку: %s', (command) => {
    expect(kind(command)).toBe('danger');
    expect(decide(command)).toBe('human');
  });

  const tool = (command: string): string =>
    groupDecision(group, { toolName: 'PowerShell', input: { command }, guardedPatterns: [] });

  it('инструмент PowerShell: путь хранилища — человеку, прочее — как раньше', () => {
    expect(tool('Set-Content .git/config x')).toBe('human');
    expect(tool("[IO.File]::WriteAllText('..\\..\\shop\\.git\\hooks\\pre-push', 'x')")).toBe(
      'human',
    );
    expect(tool('ac (Join-Path (git rev-parse --git-path hooks) pre-push) x')).toBe('human');
    expect(tool('Set-Content src/x.ts x')).not.toBe('human');
    expect(tool('git status')).not.toBe('human');
  });

  it.each([
    'pwsh -c "Set-Content out.txt x"',
    'pwsh -c "Set-Content .gitignore x"',
    'pwsh -c "Get-ChildItem .github"',
    'powershell -c "git status"',
    'pwsh -c "(git diff --name-only) | % { Write-Host $_ }"',
    'pwsh -c "Write-Host (git rev-parse --short HEAD)"',
  ])('PowerShell без хранилища — как раньше: %s', (command) => {
    expect(decide(command)).not.toBe('human');
  });

  it('связка каталогов в настоящем пути видна', () => {
    expect(slash(realpathSync.native(join(base, 'shop-worktrees', 'meta')))).toMatch(
      /\/shop\/\.git$/,
    );
  });
});
