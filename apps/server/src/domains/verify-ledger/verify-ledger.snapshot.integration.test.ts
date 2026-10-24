import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Снимок дерева журнала под сбоем `git add`. 23–24.10 журнал 21 раз выключился с
 * «snapshot-failed: Command failed: git … add -A» без причины: stderr git терялся. Замер в
 * одноразовом репозитории: файл, исчезнувший между обходом каталога и чтением, роняет `add`
 * кодом 128 «unable to index file» — так ведут себя временные файлы соседних прогонов.
 * Здесь сбой `add` детерминирован настоящим git: обязательный clean-фильтр из
 * `.git/info/attributes` (его `--attr-source` не отключает) падает по команде теста.
 */
const DIR = resolve(__dirname, '../../../../../tools/verify-ledger');
const PRELOAD = join(DIR, 'preload.cjs').replace(/\\/g, '/');

/** Проверка ставит метку `FAKE_MARK` — между первым и вторым снимком журнала. */
const CHECK = `
import fs from 'node:fs';
if (process.env.FAKE_MARK) fs.writeFileSync(process.env.FAKE_MARK, '1');
console.log('Test Files  1 passed');
`;
/**
 * Фильтр: `once` — падает только на самом первом вызове, `all` — всегда, `after-check` —
 * когда метка проверки уже есть. Не по номеру вызова: `write-tree` перехеширует «racy»
 * запись тем же фильтром, и счёт вызовов плывёт от тика к тику.
 */
const FILTER = `
const fs = require('node:fs');
const [counter, mark, fail] = process.argv.slice(2);
const first = !fs.existsSync(counter);
fs.writeFileSync(counter, '1');
if (fail === 'all' || (fail === 'once' && first) || (fail === 'after-check' && fs.existsSync(mark))) {
  process.stderr.write('filter-cause\\n');
  process.exit(1);
}
process.stdin.pipe(process.stdout);
`;

let root: string;
let repo: string;
let home: string;

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const markFile = () => join(root, 'check.mark').replace(/\\/g, '/');

/** Фильтр на `*.flaky`; `fail` — когда падать (`once`, `all`, `after-check`). */
function flakyFilter(fail: 'once' | 'all' | 'after-check') {
  const script = join(root, 'filter.cjs').replace(/\\/g, '/');
  const counter = join(root, 'filter.seen').replace(/\\/g, '/');
  writeFileSync(script, FILTER);
  writeFileSync(join(repo, '.git/info/attributes'), '*.flaky filter=once\n');
  git('config', 'filter.once.clean', `node "${script}" "${counter}" "${markFile()}" "${fail}"`);
  git('config', 'filter.once.required', 'true');
  // Неотслеживаемый: `add` во временный индекс гонит его через фильтр на каждом снимке.
  writeFileSync(join(repo, 'a.flaky'), 'data\n');
}

const { TZ: _tz, CI: _ci, ...baseEnv } = process.env;

function run(extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['.claude/tools/check.mjs'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...baseEnv,
      NODE_OPTIONS: `--require "${PRELOAD}"`,
      AGENTDECK_VERIFY_LEDGER_HOME: home,
      AGENTDECK_VERIFY_LEDGER: 'on',
      AGENTDECK_VERIFY_LEDGER_LOCK: '',
      ...extra,
    },
    timeout: 30_000,
  });
}

type Event = { kind: string; reason?: string; stderr?: string; attempts?: number };
const events = (): Event[] =>
  existsSync(join(home, 'events.jsonl'))
    ? readFileSync(join(home, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Event)
    : [];
const recordCount = () => {
  const dir = join(repo, '.git', 'agentdeck-verify', 'v1', 'runs');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).reduce((n, d) => n + readdirSync(join(dir, d)).length, 0);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-ledger-snap-'));
  repo = join(root, 'repo');
  home = join(root, 'home');
  mkdirSync(join(repo, '.claude/tools'), { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, '.gitignore'), '.claude/\n');
  writeFileSync(join(repo, 'src.txt'), 'A\n');
  writeFileSync(join(repo, '.claude/tools/check.mjs'), CHECK);
  writeFileSync(
    join(repo, '.claude/tools/verify-checks.json'),
    JSON.stringify({ checks: [{ id: 'fake', script: '.claude/tools/check.mjs' }] }),
  );
  git('add', '-A');
  git('commit', '-qm', 'init');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('verify-ledger: снимок под сбоем git add', () => {
  it('разовый сбой add (файл пропал на лету) — снимок повторяет add, прогон записан', () => {
    flakyFilter('once');
    const r = run();
    expect(r.status).toBe(0);
    const kinds = events().map((e) => e.kind);
    expect(kinds).not.toContain('off');
    expect(kinds).toContain('record');
    expect(recordCount()).toBe(1);
  });

  it('стойкий сбой первого снимка — в ленте причина из stderr git и число попыток', () => {
    flakyFilter('all');
    expect(run().status).toBe(0);
    const off = events().filter((e) => e.kind === 'off');
    expect(off).toHaveLength(1);
    expect(off[0]!.reason).toMatch(/^snapshot-failed: Command failed: git /);
    expect(off[0]!.stderr).toMatch(/clean filter 'once' failed/);
    expect(off[0]!.attempts).toBe(3);
    expect(recordCount()).toBe(0);
  });

  it('сбой второго снимка (на выходе) — событие с причиной, а не тишина', () => {
    // Метку ставит сама проверка: первый снимок проходит, второй падает на всех попытках.
    flakyFilter('after-check');
    expect(run({ FAKE_MARK: markFile() }).status).toBe(0);
    const off = events().filter((e) => e.kind === 'off');
    expect(off).toHaveLength(1);
    expect(off[0]!.reason).toMatch(/^snapshot-failed/);
    expect(off[0]!.stderr).toMatch(/clean filter 'once' failed/);
    expect(off[0]!.attempts).toBe(3);
    expect(recordCount()).toBe(0);
  });
});
