import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_REQUEST_DEFAULTS } from '@agentdeck/contracts/split-groups';
import { groupDecision, type GroupAutoApprove } from '../group-permissions.ts';
import { groupCommandVerdict, type GroupCommandScope } from './group-command.ts';

/**
 * Обходы из ревью 23.10 (`.agent/reviews/group-safe-commands.agent.md`,
 * F-01…F-29, F-77): каждая команда ниже раньше проходила без карточки.
 * Проверяется настоящий путь решения — `groupDecision` маршрута прав, а не
 * только разбор. Каталог оболочки известен (корень копии), чтобы F-29 не
 * прятал остальные исправления.
 */
const COPY = 'C:/work/shop-worktrees/fix-PROJ-77-bypass';
const OWN = 'fix-PROJ-77/bypass';
const SCRATCH = 'C:/Users/me/AppData/Local/Temp/claude/proj/session-a/scratchpad';
const SCOPE: GroupCommandScope = {
  worktree: COPY,
  branch: OWN,
  ignored: ['secrets'],
  cwd: COPY,
  scratchpad: SCRATCH,
};

const GROUP: GroupAutoApprove = {
  rows: { ...GROUP_REQUEST_DEFAULTS },
  allowEdits: true,
  worktree: COPY,
  ignored: ['secrets'],
  ownBranch: OWN,
  shellCwd: COPY,
  // Дерево чистое: карточку даёт сама команда, а не непрочитанное дерево
  // (`treeBlocks`), — иначе F-19 зеленел бы и без проверки пуша в main.
  tree: { dirty: false },
  parentChatId: 'p',
  groupIndex: 0,
};

const decide = (command: string): string =>
  groupDecision(GROUP, { toolName: 'Bash', input: { command }, guardedPatterns: [] });
const kind = (command: string, scope: GroupCommandScope = SCOPE): string =>
  groupCommandVerdict(command, scope).kind;

describe('обходы ревью 23.10 — человеку', () => {
  it.each([
    ['F-01', 'rm -rf /c'],
    ['F-01', 'rm -rf /d /tmp/x'],
    ['F-02', "trap -- 'rm -rf ~; git push --force origin main' EXIT"],
    ['F-02', 'D=.agent/tmp/x; trap \'rm -rf "$D"\' EXIT; D=/c/Users/me'],
    ['F-03', 'X=.agent/tmp/x; bash -c \'rm -rf "$X/c/Users/me"\''],
    ['F-04', `cd /c/Users/me; cd ${COPY} | cat; rm -rf .ssh`],
    ['F-05', 'rm -rf .g*'],
    ['F-05', 'rm -rf .gi?'],
    ['F-05', 'rm -rf .cl*'],
    ['F-06', 'echo $((rm -rf ~); (true))'],
    ['F-07', 'ruby -E utf-8 -e \'system("rm -rf ~")\''],
    ['F-07', "node -pe \"require('fs').rmSync('/etc',{recursive:true})\""],
    ['F-08', 'python -c "import shutil; shutil.rmtree(\'/etc\')"'],
    ['F-08', 'python -c "import os; os.system(\'rm -rf build\')"'],
    ['F-09', 'find ~ -name package.json -execdir rm -rf src \\;'],
    ['F-10', 'find ~ -empty -delete'],
    ['F-10', 'find / -name "*.log" -delete'],
    ['F-10', 'find ~ -name node_modules -exec rm -rf {} +'],
    ['F-11', 'find / -exec rm -rf + {} +'],
    ['F-11', 'find / -maxdepth 1 -exec rm -rf {}/ \\;'],
    ['F-12', 'cmd /c del /q a,C:/Users/me/file.txt'],
    ['F-13', 'cmd /c rd /s/q C:/Users/me'],
    ['F-14', 'TMPDIR=$HOME; rm -rf $TMPDIR/src'],
    ['F-15', '\\rm -rf ~'],
    ['F-15', '/bin/rm -rf ~'],
    ['F-15', 'setsid rm -rf ~'],
    ['F-15', 'coproc rm -rf ~'],
    ['F-15', 'busybox rm -rf ~'],
    ['F-15', 'sudo -u root rm -rf ~'],
    ['F-15', "ssh host 'rm -rf ~'"],
    ['F-15', 'pnpm exec rimraf ~'],
    ['F-15', 'function f { rm -rf ~; }; f'],
    ['F-15', "alias ll='rm -rf ~'"],
    ['F-15', '$RM -rf dist'],
    ['F-15', 'LD_PRELOAD=./x.so ls'],
    ['F-16', 'declare -n D=HOME; rm -rf "$D"'],
    ['F-16', 'S=.agent/tmp/x; printf -v S %s /c/Users/me; rm -rf "$S"'],
    ['F-16', 'S=.agent/tmp/x; mapfile -t S < list.txt; rm -rf "$S"'],
    ['F-16', "mapfile -C 'rm -rf ~' x < list.txt"],
    ['F-16', 'IFS=:; S=dist:/c/Users/me; rm -rf $S'],
    ['F-16', 'CDPATH=/c/Users; cd me; rm -rf .ssh'],
    ['F-16', "declare -i n='a[$(rm -rf ~)]'"],
    ['F-16', 'source ./env.sh; rm -rf src'],
    ['F-16', 'hash -p ./x ls; ls'],
    ['F-17', 'sort --compress-program=./x.sh big.txt'],
    ['F-18', 'npm run dev & P=$!; kill -9 -1 $P'],
    ['F-19', 'git checkout -Cmain && git push origin HEAD'],
    ['F-19', 'git checkout - && git push origin HEAD'],
  ])('%s: %s', (_id, command) => {
    expect(kind(command)).toBe('danger');
    expect(decide(command)).toBe('human');
  });

  it('F-19: `checkout main --` — смена ветки, пуш HEAD следом к человеку', () => {
    expect(decide('git checkout main -- && git push origin HEAD')).toBe('human');
  });

  it('F-17: `shuf -o` пишет файл — уже не чтение', () => {
    expect(kind('shuf -o README.md a')).toBe('other');
  });

  it('F-07: подгрузка модуля рядом с кодом — непроверенное звено, его слова судят правила чата', () => {
    const verdict = groupCommandVerdict('node -r ./x.js -e 1', SCOPE);
    expect(verdict).toMatchObject({ kind: 'other', texts: ['node -r ./x.js -e 1'] });
  });

  it('F-24: раннер пакетов с ключами — погашение порта, его сверит маршрут прав', () => {
    for (const command of ['npx -y kill-port 5178', 'pnpm dlx kill-port 5178']) {
      expect(groupCommandVerdict(command, SCOPE)).toMatchObject({
        kind: 'routine',
        kills: { pids: [], ports: [5178] },
      });
      expect(decide(command)).toBe('human');
    }
  });
});

describe('F-29: каталог оболочки CLI неизвестен', () => {
  const blind: GroupCommandScope = { worktree: COPY, branch: OWN, ignored: ['secrets'] };

  it('относительное невременное удаление — человеку, временное и абсолютное в копии — само', () => {
    expect(kind('rm -rf ../x', blind)).toBe('danger');
    expect(kind('rm -rf src', blind)).toBe('danger');
    expect(kind('rm -rf dist .agent/tmp/x', blind)).toBe('routine');
    expect(kind(`rm -rf "${COPY}/src"`, blind)).toBe('routine');
    // Каталог известен — то же удаление своё.
    expect(kind('rm -rf src')).toBe('routine');
  });
});

describe('F-77: удаление вне копии — только своё временное', () => {
  it.each([
    'rm -rf /tmp/*',
    'rm -rf /tmp/agent-probe',
    'rm -rf "$TMPDIR/agent-probe"',
    'cd /tmp && rm -rf agent-probe',
    // Рабочая папка другой сессии CLI.
    'rm -rf C:/Users/me/AppData/Local/Temp/claude/proj/session-b/scratchpad/x',
  ])('человеку: %s', (command) => {
    expect(kind(command)).toBe('danger');
  });

  it.each([
    `rm -rf ${SCRATCH}/probe`,
    'd=$(mktemp -d) && cd "$d" && rm -rf x',
    'T=$(mktemp -d); trap \'rm -rf "$T"\' EXIT; git status',
  ])('само: %s', (command) => {
    expect(groupCommandVerdict(command, SCOPE)).toMatchObject({ kind: 'routine', deletes: true });
  });

  it('запись во временный каталог системы — по-прежнему не к человеку', () => {
    expect(kind('git status > /tmp/status.txt')).toBe('routine');
  });
});

describe('F-74a: неотслеживаемое и неигнорируемое в своей копии', () => {
  it('удаление — само, строкой «удаление файлов»; локальный слой — человеку', () => {
    expect(groupCommandVerdict('rm -f notes-draft.md', SCOPE)).toMatchObject({
      kind: 'routine',
      deletes: true,
    });
    // Игнорируемое с именем секрета и `.env` — не своё (R-C02).
    expect(kind('rm -rf secrets')).toBe('danger');
    expect(kind('rm -f .env.local')).toBe('danger');
  });
});

describe('F-14: `$TMPDIR` не задан у панели', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('запись в `$TMPDIR/…` без переменной — уже не временное', () => {
    vi.stubEnv('TMPDIR', '/tmp');
    expect(kind('git status > "$TMPDIR/s.txt"')).toBe('routine');
    vi.stubEnv('TMPDIR', '');
    expect(kind('git status > "$TMPDIR/s.txt"')).toBe('other');
  });
});

describe('F-25: каталог копии — ссылка наружу', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  it('удаление внутрь ссылки — человеку; сама ссылка — своё', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-bypass-link-'));
    made.push(root);
    const copy = join(root, 'copy');
    const outside = join(root, 'original-node_modules');
    mkdirSync(copy);
    mkdirSync(join(outside, 'lodash'), { recursive: true });
    symlinkSync(outside, join(copy, 'node_modules'), 'junction');
    const scope: GroupCommandScope = { worktree: copy, branch: OWN, ignored: [], cwd: copy };
    expect(kind('rm -rf node_modules/*', scope)).toBe('danger');
    expect(kind('rm -rf node_modules/lodash', scope)).toBe('danger');
    expect(kind('rm -rf node_modules', scope)).toBe('routine');
  });
});

describe('безопасное после исправлений — по-прежнему само', () => {
  it.each([
    "bash -c 'rm -rf dist'",
    'export X=.agent/tmp/x; bash -c \'rm -rf "$X"\'',
    'PATH=$PATH:./bin ls',
    // F-15, решение владельца 23.10: `PATH` впереди — каталог инструментов
    // (`export PATH="/c/Program Files/nvm/v22:$PATH"` — частое начало команд
    // корпуса), а не подмена имён; карточки на нём были ложными.
    'PATH=./bin:$PATH ls',
    'export PATH=./bin:$PATH; ls',
    'pnpm test -t "kills the process"',
    'find . -name "*.log" -delete',
    'find . -name __pycache__ -exec rm -rf {} +',
    'cmd /c rd /s/q build',
    "node -e \"require('fs').rmSync('dist', {recursive: true})\"",
  ])('не человеку: %s', (command) => {
    expect(kind(command)).not.toBe('danger');
  });
});

/**
 * Холодная атака 23.10 (`review-fix-zone-BA2L-attack`, R-01…R-07): каждая
 * команда ниже раньше проходила сама — `groupDecision` давал `auto`.
 */
describe('холодная атака 23.10 — человеку', () => {
  it.each([
    // R-01: строка `-S` слитно, в связке, длинным ключом — исполнится мимо суда.
    ['R-01', "env -S'git push origin main'"],
    ['R-01', "env -S'rm -rf ~'"],
    ['R-01', "env -iS'rm -rf ~'"],
    ['R-01', "env -vS'rm -rf ~'"],
    ['R-01', "env --split-string='rm -rf ~'"],
    ['R-01', "env --split='rm -rf ~'"],
    ['R-01', "env -u X -S'rm -rf ~'"],
    ['R-01', "env -S'-C/c/Users git reset --hard'"],
    ['R-01', "env -S'git\\_push\\_origin\\_main'"],
    ['R-01', "timeout 5 env -S'git push origin main'"],
    // R-02: подкоманда git — со входа: пуш, затирание без снимка.
    ['R-02', 'xargs git'],
    ['R-02', "printf 'push origin main' | xargs git"],
    ['R-02', "printf 'reset --hard' | xargs git"],
    ['R-02', "echo 'clean -fdx' | xargs git"],
    ['R-02', 'printf x | xargs -I{} git {}'],
    ['R-02', 'xargs -0r git'],
    ['R-02', 'xargs -a list.txt git'],
    ['R-02', "printf x | xargs -I{} sh -c 'git {}'"],
    ['R-02', "printf x | xargs -I{} sh -c 'rm -rf {}'"],
    // R-04: команда уходит из копии, снимок взят бы с копии.
    ['R-04', 'env -C/c/Users git reset --hard'],
    ['R-04', 'env -C /c/Users git reset --hard'],
    ['R-04', 'env --chdir=/c/Users git reset --hard'],
    ['R-04', 'env --ch=/c/Users git reset --hard'],
    ['R-04', 'env -iC/c/Users git reset --hard'],
    ['R-04', 'nice -n5 env -C/c/Users git reset --hard'],
    ['R-04', 'pwsh -wd /c/Users -c "Remove-Item -Recurse -Force dist"'],
    ['R-04', 'sudo -D /c/Users git reset --hard'],
    ['R-04', 'sudo --chdir=/c/Users git reset --hard'],
    ['R-04', 'ssh host git reset --hard'],
    ['R-04', 'docker exec c git reset --hard'],
    ['R-04', 'wsl --cd /x git reset --hard'],
    // R-05: `-EncodedCommand` любым однозначным началом, через `/`, не первым ключом.
    ['R-05', 'powershell -enco ZwBpAHQA'],
    ['R-05', 'powershell /e ZwBpAHQA'],
    ['R-05', 'powershell -EncodedArguments ZwBpAHQA'],
    ['R-05', 'powershell -nop -enco ZwBpAHQA'],
    ['R-05', 'powershell /nop /e ZwBpAHQA'],
    ['R-05', 'pwsh --encodedcommand ZwBpAHQA'],
    ['R-05', 'powershell –e ZwBpAHQA'],
    // R-07: `C:dist` — от корня диска (MSYS) или от каталога диска (PowerShell), не от копии.
    ['R-07', 'powershell -c "Remove-Item -Recurse -Force C:dist"'],
    ['R-07', 'rm -rf C:dist'],
    // Связка ключей `flock`, которой разбор не знает: строку не снять, удаление видно.
    ['R-01', "flock -xc 'rm -rf ~' /tmp/l"],
  ])('%s: %s', (_id, command) => {
    expect(kind(command)).toBe('danger');
    expect(decide(command)).toBe('human');
  });

  it.each([
    "env -S'pnpm test'",
    "env -iS'echo hi'",
    'env -u X pnpm test',
    'env A=1 pnpm test',
    'env -C src git status',
    'env -C src git reset --hard',
    'git ls-files | xargs grep foo',
    'git ls-files -z | xargs -0 wc -l',
    'git diff --name-only | xargs git add',
    'ls | xargs cat',
    'powershell -NoProfile -c "Remove-Item -Recurse -Force dist"',
    'powershell -ExecutionPolicy Bypass -c "Remove-Item -Recurse -Force dist"',
    'rm -rf dist',
    'sudo git status',
    'ssh host ls',
    'docker exec c ls',
    // Корпус 23.10: `docker rm` — контейнер, а не файл; `{}` в сценарии — чтение.
    'docker rm -f stand-pg stand-redis',
    'find utils -type f | xargs -I{} sh -c \'echo "== {}"; cat {}\'',
  ])('ближайшая безопасная форма — само: %s', (command) => {
    expect(kind(command)).not.toBe('danger');
    expect(decide(command)).toBe('auto');
  });

  it('R-06: `powershell -File x.ps1` — сценарий из файла, как `bash x.sh`', () => {
    for (const command of ['powershell -File x.ps1', 'pwsh -f x.ps1', 'bash x.sh']) {
      expect(kind(command)).toBe('other');
      expect(decide(command)).toBe('auto');
    }
  });
});
