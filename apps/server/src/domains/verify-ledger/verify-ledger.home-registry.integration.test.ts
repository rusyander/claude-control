import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Реестр проверок в доме журнала (`<дом>/verify-checks.json`, блок по общему каталогу git):
 * проверка проекта, куда реестр положить нельзя, повторяется так же, как проверка из
 * `.claude/tools/verify-checks.json`. Репозиторий — по форме монорепо, где скрипт пакета
 * документации читает каталоги соседних пакетов; копия — настоящий `git worktree`.
 * Прогоны — живой node с настоящим `--require` preload и настоящим git.
 */
const DIR = resolve(__dirname, '../../../../../tools/verify-ledger');
const PRELOAD = join(DIR, 'preload.cjs').replace(/\\/g, '/');
const load = createRequire(__filename);
type Match = { id: string; noSkip: string | null; entry: { registryRaw: string } | null } | null;
const { recognize } = load(join(DIR, 'checks.cjs')) as {
  recognize: (argv: string[], cwd: string, env?: NodeJS.ProcessEnv) => Match;
};

const SCRIPT = 'inst-docs-ui/scripts/check_content.mjs';

/** Проверка-образец: читает соседние пакеты (отслеживаемые и игнорируемый) и печатает итог. */
const CHECK = `
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').trim();
const locales = fs.readdirSync(path.join(root, 'inst-admin-ui/src/shared/i18n/locales/en')).map((f) => read('inst-admin-ui/src/shared/i18n/locales/en/' + f)).join(',');
console.log('content ok: ' + [locales, read('shared/i18n/messages.go'), read('inst-auth/internal/db/db.go'), read('inst-admin-ui/generated/perm.txt')].join(' | '));
`;

let root: string;
let repo: string;
let copy: string;
let home: string;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function put(rel: string, body: string, base = repo) {
  mkdirSync(join(base, rel, '..'), { recursive: true });
  writeFileSync(join(base, rel), body);
}

const ENTRY = {
  id: 'docs-content-check',
  script: SCRIPT,
  noSkipFlags: ['--prune-quote-baseline'],
  inputs: ['inst-admin-ui/generated'],
};

function homeRegistry(checks: object[] = [ENTRY], commonDir = join(repo, '.git')) {
  writeFileSync(
    join(home, 'verify-checks.json'),
    JSON.stringify({
      repos: [
        { commonDir: join(root, 'elsewhere/.git'), checks: [{ ...ENTRY, id: 'foreign' }] },
        { commonDir, checks },
      ],
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-ledger-home-'));
  repo = join(root, 'mono');
  copy = join(root, 'mono-worktrees', 'fix-one');
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  put('.gitattributes', '* text=auto eol=lf\n');
  put('.gitignore', '.claude/\nnode_modules/\ngenerated/\n');
  put(
    'inst-docs-ui/package.json',
    JSON.stringify({
      name: 'docs',
      scripts: { 'content:check': 'node scripts/check_content.mjs' },
    }),
  );
  put(SCRIPT, CHECK);
  put('inst-docs-ui/content/page.mdx', '# page\n');
  put('inst-admin-ui/src/shared/i18n/locales/en/common.json', '{"a":"A"}\n');
  put('shared/i18n/messages.go', 'package i18n // v1\n');
  put('inst-auth/internal/db/db.go', 'package db // perms v1\n');
  put('inst-admin-ui/generated/perm.txt', 'generated v1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  mkdirSync(join(root, 'mono-worktrees'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'fix-one', copy);
  put('inst-admin-ui/generated/perm.txt', 'generated v1\n', copy);
  homeRegistry();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const envFor = (): NodeJS.ProcessEnv => ({ ...process.env, AGENTDECK_VERIFY_LEDGER_HOME: home });
const argvOf = (base: string, ...args: string[]) => ['node', join(base, SCRIPT), ...args];

describe('verify-ledger: реестр проверок в доме журнала', () => {
  it('проверка из реестра дома узнаётся в основной папке и в копии того же репозитория', () => {
    const inMain = recognize(argvOf(repo), join(repo, 'inst-docs-ui'), envFor());
    expect(inMain?.id).toBe('docs-content-check');
    expect(inMain?.noSkip).toBeNull();
    // Ключ берёт блок своего репозитория, а не весь файл дома.
    expect(JSON.parse(inMain!.entry!.registryRaw).commonDir).toBe(join(repo, '.git'));
    expect(recognize(argvOf(copy), join(copy, 'inst-docs-ui'), envFor())?.id).toBe(
      'docs-content-check',
    );
    expect(
      recognize(argvOf(repo, '--prune-quote-baseline'), join(repo, 'inst-docs-ui'), envFor())
        ?.noSkip,
    ).toBe('docs-content-check flag');
  });

  it('блок чужого репозитория не применяется; битый файл дома — не проверка, без сбоя', () => {
    homeRegistry([ENTRY], join(root, 'elsewhere/.git'));
    expect(recognize(argvOf(repo), join(repo, 'inst-docs-ui'), envFor())).toBeNull();
    writeFileSync(join(home, 'verify-checks.json'), '{ broken');
    expect(recognize(argvOf(repo), join(repo, 'inst-docs-ui'), envFor())).toBeNull();
  });

  it('реестр проекта побеждает дом на том же id; на чужом id дом действует', () => {
    const project = (checks: object[]) =>
      put('.claude/tools/verify-checks.json', JSON.stringify({ checks }));
    project([{ id: 'docs-content-check', never: true }]);
    expect(recognize(argvOf(repo), join(repo, 'inst-docs-ui'), envFor())).toBeNull();
    project([{ ...ENTRY, noSkipFlags: ['--strict'] }]);
    const own = recognize(argvOf(repo, '--strict'), join(repo, 'inst-docs-ui'), envFor());
    expect(own?.noSkip).toBe('docs-content-check flag');
    expect(own?.entry?.registryRaw).toBe(
      readFileSync(join(repo, '.claude/tools/verify-checks.json'), 'utf8'),
    );
    project([{ id: 'other', script: 'tools/other.mjs' }]);
    expect(recognize(argvOf(repo), join(repo, 'inst-docs-ui'), envFor())?.entry?.registryRaw).toBe(
      JSON.stringify({ commonDir: join(repo, '.git'), checks: [ENTRY] }),
    );
  });
});

type Run = { code: number | null; out: string; err: string };
const { TZ: _tz, CI: _ci, ...baseEnv } = process.env;
const ledgerEnv = () => ({
  ...baseEnv,
  NODE_OPTIONS: `--require "${PRELOAD}"`,
  AGENTDECK_VERIFY_LEDGER_HOME: home,
  AGENTDECK_VERIFY_LEDGER: 'on',
  AGENTDECK_VERIFY_LEDGER_LOCK: '',
});

function run(base = repo, args: string[] = []): Run {
  const r = spawnSync(process.execPath, ['scripts/check_content.mjs', ...args], {
    cwd: join(base, 'inst-docs-ui'),
    encoding: 'utf8',
    env: ledgerEnv(),
    timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Как в жизни: `npm run content:check` — npm сам node, проверка — его дочерний node. */
function npmRun(base = repo): Run {
  const r = spawnSync('npm', ['run', '--silent', 'content:check'], {
    cwd: join(base, 'inst-docs-ui'),
    encoding: 'utf8',
    env: ledgerEnv(),
    shell: process.platform === 'win32',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const reused = (r: Run) => r.err.includes('[verify-ledger] reused green');

describe('verify-ledger: проверка из реестра дома живым preload', () => {
  it('первый прогон пишется, неизменное дерево повторяется, правка входа вне пакета — прогон', () => {
    const first = run();
    expect(first.code).toBe(0);
    expect(reused(first)).toBe(false);
    const second = run();
    expect(reused(second)).toBe(true);
    expect(second.out).toBe(first.out);

    // Отслеживаемый файл соседнего пакета, который читает проверка.
    put('inst-admin-ui/src/shared/i18n/locales/en/common.json', '{"a":"B"}\n');
    const afterLocale = run();
    expect(reused(afterLocale)).toBe(false);
    expect(afterLocale.out).toContain('{"a":"B"}');
    expect(reused(run())).toBe(true);

    put('shared/i18n/messages.go', 'package i18n // v2\n');
    expect(reused(run())).toBe(false);

    // Игнорируемый git вход соседа: дерево его не видит, видит объявленный `inputs`.
    put('inst-admin-ui/generated/perm.txt', 'generated v2\n');
    const afterIgnored = run();
    expect(reused(afterIgnored)).toBe(false);
    expect(afterIgnored.out).toContain('generated v2');

    // Ключ, который пишет файлы, — никогда не повтор.
    expect(reused(run(repo, ['--prune-quote-baseline']))).toBe(false);
    expect(reused(run(repo, ['--prune-quote-baseline']))).toBe(false);
  });

  it('копия того же репозитория повторяет зелёный основной папки на том же дереве', () => {
    expect(reused(run(repo))).toBe(false);
    const inCopy = run(copy);
    expect(reused(inCopy)).toBe(true);
    expect(inCopy.code).toBe(0);
  });

  it('через `npm run content:check`: запись, затем повтор', () => {
    const first = npmRun();
    expect(first.code).toBe(0);
    expect(first.out).toContain('content ok');
    expect(reused(first)).toBe(false);
    const second = npmRun();
    expect(reused(second)).toBe(true);
    expect(second.out).toContain('content ok');
  });
});
