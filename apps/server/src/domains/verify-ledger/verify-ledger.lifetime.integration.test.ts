import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeGroupCopy } from '../chat/split-cleanup.ts';
import { removeWorktree } from '../project-git/worktrees.ts';
import { pruneLedgerForRemovedCopy } from './verify-ledger.ts';

/**
 * Срок жизни записей журнала проверок и уборка хранилища (владелец 24.10: записи живут,
 * пока жива работа, — до уборки группы или сдачи задачи), плюс прогон, во время которого
 * соседний агент правил дерево вне области проверки. Живые процессы node с настоящим
 * `--require` preload и настоящим git; снаружи подменён только сам инструмент —
 * поддельный `tsc` (и `vitest`) в `node_modules` пакета печатает итог и считает, сколько
 * раз его действительно запускали. `VL_DIR` — каталог журнала под проверкой (прогон
 * на прежнем коде для «красного до»).
 */
const DIR = process.env.VL_DIR
  ? resolve(process.env.VL_DIR)
  : resolve(__dirname, '../../../../../tools/verify-ledger');
const PRELOAD = join(DIR, 'preload.cjs').replace(/\\/g, '/');
const load = createRequire(__filename);
const ledger = load(join(DIR, 'ledger.cjs')) as {
  repoOf: (cwd: string) => { top: string; store: string };
  canonical: (value: unknown) => string;
  prune?: (
    repo: object,
    opts: { now?: number; cap?: number; dry?: boolean },
  ) => { drop: { dead: number; lru: number }; bytes: { before: number; after: number } };
};

/** Поддельный инструмент: читает исходник пакета, по желанию правит файл посреди прогона. */
const FAKE_TOOL = `
const fs = require('node:fs');
// Управление вне ключа — файл вне репозитория (окружение входит в ключ журнала).
const ctl = e0 => (e0.FAKE_CTL && fs.existsSync(e0.FAKE_CTL) ? JSON.parse(fs.readFileSync(e0.FAKE_CTL, 'utf8')) : {});
const e = { ...process.env, ...ctl(process.env) };
const src = fs.readFileSync('src.ts', 'utf8').trim();
if (e.FAKE_EDIT) fs.writeFileSync(e.FAKE_EDIT, e.FAKE_EDIT_BODY ?? 'edited ' + Date.now() + '\\n');
if (e.FAKE_EDIT_MTIME) fs.utimesSync(e.FAKE_EDIT, Number(e.FAKE_EDIT_MTIME), Number(e.FAKE_EDIT_MTIME));
fs.appendFileSync(e.FAKE_COUNT, 'x');
console.log('checked ' + src);
process.exitCode = Number(e.FAKE_EXIT || 0);
`;

let root: string;
let repo: string;
let home: string;
let count: string;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function pkg(base: string, name: string, src: string) {
  mkdirSync(join(base, name, 'node_modules/typescript/bin'), { recursive: true });
  mkdirSync(join(base, name, 'node_modules/vitest'), { recursive: true });
  writeFileSync(join(base, name, 'package.json'), `{"name":"${name}","private":true}\n`);
  writeFileSync(join(base, name, 'src.ts'), `${src}\n`);
  writeFileSync(join(base, name, 'node_modules/typescript/bin/tsc'), FAKE_TOOL);
  writeFileSync(
    join(base, name, 'node_modules/vitest/vitest.mjs'),
    `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n${FAKE_TOOL}`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-ledger-life-'));
  repo = join(root, 'repo');
  home = join(root, 'home');
  count = join(root, 'count.txt');
  process.env.AGENTDECK_VERIFY_LEDGER_HOME = home;
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'package.json'), '{"name":"root","private":true}\n');
  pkg(repo, 'pkg-a', 'A');
  pkg(repo, 'pkg-b', 'B');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Run {
  code: number | null;
  out: string;
  err: string;
}

/** Один настоящий прогон проверки в пакете `cwd` (по умолчанию `repo/pkg-a`). */
function check(env: Record<string, string> = {}, cwd = join(repo, 'pkg-a'), tool = 'tsc'): Run {
  const script =
    tool === 'tsc' ? 'node_modules/typescript/bin/tsc' : 'node_modules/vitest/vitest.mjs';
  const args = tool === 'tsc' ? ['--noEmit'] : ['run'];
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `--require "${PRELOAD}"`,
      AGENTDECK_VERIFY_LEDGER_HOME: home,
      AGENTDECK_VERIFY_LEDGER: 'on',
      AGENTDECK_VERIFY_LEDGER_LOCK: '',
      FAKE_COUNT: count,
      FAKE_CTL: join(root, 'ctl.json'),
      ...env,
    },
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
/** Поведение следующих прогонов мимо ключа журнала. */
const outside = (vars: Record<string, string>) =>
  writeFileSync(join(root, 'ctl.json'), JSON.stringify(vars));

const realRuns = () => (existsSync(count) ? readFileSync(count, 'utf8').length : 0);
const reused = (r: Run) => r.err.includes('[verify-ledger] reused green');
const events = () =>
  existsSync(join(home, 'events.jsonl'))
    ? readFileSync(join(home, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind: string; reason?: string; kept?: string })
    : [];

const recordFiles = (from = repo) => {
  const dir = join(ledger.repoOf(from).store, 'v1', 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((d) => readdirSync(join(dir, d)).map((n) => join(dir, d, n)));
};

/**
 * Записи хранилища в прошлое (`hours`) и, по желанию, без знания о работе (`dropWork` —
 * как записи до 24.10). Подпись пересчитывается ключом этого дома: иначе журнал не
 * счёл бы правленую запись своей.
 */
function age(hours: number, opts: { dropWork?: boolean; only?: (r: never) => boolean } = {}) {
  const key = readFileSync(join(home, 'key'));
  for (const file of recordFiles()) {
    const { hmac: _h, ...body } = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (opts.only && !opts.only(body as never)) continue;
    body.startedAt = Number(body.startedAt) - hours * 3600e3;
    if (opts.dropWork) delete body.wt;
    const hmac = createHmac('sha256', key).update(ledger.canonical(body)).digest('hex');
    writeFileSync(file, JSON.stringify({ ...body, hmac }));
  }
}

describe('журнал проверок: запись живёт, пока жива работа', () => {
  it('зелёный старше 72 ч из живой копии на живой ветке — повтор, а не прогон', () => {
    expect(check().code).toBe(0);
    age(80);
    const again = check();
    expect(again.code).toBe(0);
    expect(reused(again)).toBe(true);
    expect(realRuns()).toBe(1);
  });

  it('срок — от последнего использования: повтор 10 ч назад продлевает зелёный 100-часовой давности', () => {
    check();
    check(); // повтор — использование ключа
    expect(realRuns()).toBe(1);
    // Работа записей неизвестна (как до 24.10): решает только срок.
    age(100, { dropWork: true, only: (r: { reusedFrom?: string }) => !r.reusedFrom });
    age(10, { dropWork: true, only: (r: { reusedFrom?: string }) => Boolean(r.reusedFrom) });
    expect(reused(check())).toBe(true);
    expect(realRuns()).toBe(1);
  });

  it('работа неизвестна и ключ не тронут 72 ч — прогон заново', () => {
    check();
    check();
    age(80, { dropWork: true });
    expect(reused(check())).toBe(false);
    expect(realRuns()).toBe(2);
    expect(events().some((e) => e.kind === 'miss' && e.reason === 'stale')).toBe(true);
  });

  it('ветка записи удалена — работа мертва, срок снова решает', () => {
    git(repo, 'checkout', '-qb', 'feat');
    check();
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-D', 'feat');
    age(80);
    // Записи пишет и повтор — но его здесь нет: единственная запись — с удалённой ветки.
    const again = check();
    expect(reused(again)).toBe(false);
    expect(realRuns()).toBe(2);
  });
});

describe('журнал проверок: уборка хранилища', () => {
  it('уборка копии группы снимает ключи, которых касалась только она, общие — оставляет', () => {
    const copy = join(root, 'copy');
    git(repo, 'worktree', 'add', '-q', '-b', 'group-1', copy);
    pkg(copy, 'pkg-a', 'A'); // node_modules копии (вне git)
    pkg(copy, 'pkg-b', 'B');
    git(copy, 'checkout', '-q', '--', '.');
    // Общий ключ: копия записала, основная папка повторила.
    check({}, join(copy, 'pkg-a'));
    expect(reused(check())).toBe(true);
    // Ключ только копии.
    writeFileSync(join(copy, 'pkg-a', 'src.ts'), 'A2\n');
    check({}, join(copy, 'pkg-a'));
    const before = recordFiles().map((f) => JSON.parse(readFileSync(f, 'utf8')) as { key: string });
    const keys = [...new Set(before.map((r) => r.key))];
    expect(keys).toHaveLength(2);

    git(repo, 'worktree', 'remove', '--force', copy);
    const result = pruneLedgerForRemovedCopy({ projectPath: repo, copyPath: copy, sourceDir: DIR });
    expect(result?.drop.dead).toBe(1);
    const left = recordFiles().map((f) => JSON.parse(readFileSync(f, 'utf8')) as { key: string });
    expect(new Set(left.map((r) => r.key)).size).toBe(1);
    // Общий ключ жив: основная папка повторяет его по-прежнему.
    expect(reused(check())).toBe(true);
    expect(realRuns()).toBe(2);
  });

  it('removeGroupCopy убирает копию настоящим git и снимает её ключи журнала', async () => {
    // Длинная форма пути: git пишет список копий так, а temp на Windows — «RUSYAN~1».
    const copy = join(realpathSync.native(root), 'copy');
    git(repo, 'worktree', 'add', '-q', '-b', 'group-1', copy);
    pkg(copy, 'pkg-a', 'A');
    pkg(copy, 'pkg-b', 'B');
    git(copy, 'checkout', '-q', '--', '.');
    check({}, join(copy, 'pkg-a'));
    expect(reused(check())).toBe(true);
    writeFileSync(join(copy, 'pkg-a', 'src.ts'), 'A2\n');
    check({}, join(copy, 'pkg-a'));
    // Чистая копия: уборка группы идёт без --force.
    git(copy, 'checkout', '-q', '--', '.');
    const keysOf = () =>
      new Set(
        recordFiles().map((f) => (JSON.parse(readFileSync(f, 'utf8')) as { key: string }).key),
      );
    expect(keysOf().size).toBe(2);

    await expect(
      removeGroupCopy({ projectPath: repo, path: copy, branch: 'group-1', keepBranch: true }),
    ).resolves.toBe('mr');
    expect(existsSync(copy)).toBe(false);
    expect(keysOf().size).toBe(1);
    expect(reused(check())).toBe(true);
  });

  // Копию убирают и мимо группы: закрытое ревью и маршруты человека зовут
  // `removeWorktree` сами, а каталог, пропавший с диска, снимается `worktree prune`.
  it.each(['removed', 'prunable'] as const)(
    'removeWorktree снимает ключи журнала копии и без группы (%s)',
    async (mode) => {
      const copy = join(realpathSync.native(root), 'copy');
      git(repo, 'worktree', 'add', '-q', '-b', 'review-1', copy);
      pkg(copy, 'pkg-a', 'A');
      pkg(copy, 'pkg-b', 'B');
      git(copy, 'checkout', '-q', '--', '.');
      writeFileSync(join(copy, 'pkg-a', 'src.ts'), 'A2\n');
      check({}, join(copy, 'pkg-a'));
      git(copy, 'checkout', '-q', '--', '.');
      const keysOf = () =>
        new Set(
          recordFiles().map((f) => (JSON.parse(readFileSync(f, 'utf8')) as { key: string }).key),
        );
      check();
      expect(keysOf().size).toBe(2);

      if (mode === 'prunable') rmSync(copy, { recursive: true, force: true });
      await removeWorktree(repo, copy, true);
      expect(existsSync(copy)).toBe(false);
      expect(keysOf().size).toBe(1);
    },
  );

  it('сверх предела уходит ключ, дольше всех не использованный; вывод и артефакты — с ним', () => {
    for (const src of ['A1', 'A2', 'A3']) {
      writeFileSync(join(repo, 'pkg-a', 'src.ts'), `${src}\n`);
      check();
    }
    // Самый старый — A1: его используют снова, теперь дольше всех не использован A2.
    writeFileSync(join(repo, 'pkg-a', 'src.ts'), 'A1\n');
    expect(reused(check())).toBe(true);
    const store = ledger.repoOf(repo);
    const later = Date.now() + 3600e3; // вне окна «соседний процесс ещё пишет»
    const dry = ledger.prune?.(store, { now: later, dry: true });
    expect(dry).toBeDefined();
    const total = dry?.bytes.before ?? 0;
    const result = ledger.prune?.(store, { now: later, cap: Math.floor(total * 0.9) });
    expect(result?.drop.lru).toBeGreaterThanOrEqual(1);
    expect(result?.bytes.after).toBeLessThanOrEqual(total * 0.9 * 0.75 + 1);
    const outDir = join(store.store, 'v1', 'out');
    const runIds = new Set(
      recordFiles().map((f) => (JSON.parse(readFileSync(f, 'utf8')) as { runId: string }).runId),
    );
    // Вывод остался только у оставшихся записей.
    for (const name of readdirSync(outDir)) expect(runIds.has(name.split('.')[0] ?? '')).toBe(true);
    // Использованный последним A1 жив, A2 ушёл.
    expect(reused(check())).toBe(true);
    writeFileSync(join(repo, 'pkg-a', 'src.ts'), 'A2\n');
    expect(reused(check())).toBe(false);
  });

  it('постаревший ключ мёртвой работы уходит при уборке, живой — остаётся', () => {
    check();
    writeFileSync(join(repo, 'pkg-a', 'src.ts'), 'A9\n');
    check();
    age(80, { only: (r: { parts: { tree: string } }) => Boolean(r.parts) });
    // Первую запись — как до 24.10, без работы: ей только срок.
    const [first = ''] = recordFiles().sort();
    const key = readFileSync(join(home, 'key'));
    const { hmac: _h, ...body } = JSON.parse(readFileSync(first, 'utf8')) as Record<
      string,
      unknown
    >;
    delete body.wt;
    writeFileSync(
      first,
      JSON.stringify({
        ...body,
        hmac: createHmac('sha256', key).update(ledger.canonical(body)).digest('hex'),
      }),
    );
    const result = ledger.prune?.(ledger.repoOf(repo), { now: Date.now() + 80 * 3600e3 });
    expect(result?.drop.dead).toBe(1);
    expect(recordFiles()).toHaveLength(1);
  });
});

describe('журнал проверок: дерево сменилось посреди прогона', () => {
  it('сосед правил другой пакет — запись остаётся, следующий прогон — повтор', () => {
    outside({ FAKE_EDIT: '../pkg-b/src.ts' });
    const first = check();
    expect(first.code).toBe(0);
    expect(events().some((e) => e.kind === 'record' && e.kept === 'outside-scope')).toBe(true);
    outside({});
    expect(reused(check())).toBe(true);
    expect(realRuns()).toBe(1);
  });

  it('правка внутри пакета посреди прогона — записи нет', () => {
    check({ FAKE_EDIT: 'extra.ts' });
    expect(events().some((e) => e.kind === 'off' && e.reason === 'tree-changed')).toBe(true);
    expect(events().some((e) => e.kind === 'record')).toBe(false);
  });

  it('файл пакета переписан тем же содержимым посреди прогона (правка с откатом) — записи нет', () => {
    check({ FAKE_EDIT: 'src.ts', FAKE_EDIT_BODY: 'A\n' });
    // Содержимое то же, mtime сдвинут: проверка могла прочесть промежуточное.
    expect(events().some((e) => e.kind === 'off' && e.reason === 'tree-changed')).toBe(true);
    expect(events().some((e) => e.kind === 'record')).toBe(false);
  });

  it('файл пакета подменён тем же размером и с тем же временем записи — записи нет', () => {
    // Сверка времени и размера такую подмену не видит; её видит только ключ по содержимому.
    const at = 1_700_000_000;
    utimesSync(join(repo, 'pkg-a', 'src.ts'), at, at);
    check({ FAKE_EDIT: 'src.ts', FAKE_EDIT_BODY: 'Z\n', FAKE_EDIT_MTIME: String(at) });
    expect(readFileSync(join(repo, 'pkg-a', 'src.ts'), 'utf8')).toBe('Z\n');
    expect(events().some((e) => e.kind === 'off' && e.reason === 'tree-changed')).toBe(true);
    expect(events().some((e) => e.kind === 'record')).toBe(false);
  });

  it('vitest — область всё дерево: правка соседнего пакета посреди прогона — записи нет', () => {
    check({ FAKE_EDIT: '../pkg-b/src.ts' }, join(repo, 'pkg-a'), 'vitest');
    expect(events().some((e) => e.kind === 'off' && e.reason === 'tree-changed')).toBe(true);
    expect(events().some((e) => e.kind === 'record')).toBe(false);
  });
});

describe('журнал проверок: каталог вне git', () => {
  it('ключа нет — каждый прогон настоящий, в ленте «not-git» с каталогом прогона', () => {
    pkg(root, 'plain', 'P');
    const plain = join(root, 'plain');
    expect(check({}, plain, 'vitest').code).toBe(0);
    expect(reused(check({}, plain, 'vitest'))).toBe(false);
    expect(realRuns()).toBe(2);
    const off = events().filter((e) => e.kind === 'off') as { reason?: string; cwd?: string }[];
    expect(off).toHaveLength(2);
    for (const e of off) {
      expect(e.reason).toBe('not-git');
      expect(String(e.cwd).replace(/\\/g, '/').toLowerCase()).toContain('/plain');
    }
  });
});
