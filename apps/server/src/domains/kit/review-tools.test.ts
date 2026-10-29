import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { canonical } from '../chat/group-command/paths.ts';
import { reviewScratchMark } from '../chat/group-command/review-scratch.ts';
import { builtinKitDir } from './service.ts';

/**
 * Инструменты ревью из набора — настоящие файлы набора. Выбор путей проверки не должен молча
 * сметать ноль файлов, а позиция треда на диапазон строк должна нести line_range с кодами строк
 * GitLab. Против живого GitLab позиция не проверялась: форма — по документации REST.
 */

const TOOLS = join(builtinKitDir(), 'tools');
const root = mkdtempSync(join(tmpdir(), 'kit-review-tools-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (repo: string, ...a: string[]): string =>
  spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).stdout.trim();
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
const nums = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

const put = (repo: string, file: string, lines: string[]): void => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), lines.join('\n') + '\n');
};
const makeRepo = (name: string): string => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  return dir;
};
const commit = (repo: string, msg: string): string => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', msg);
  return git(repo, 'rev-parse', 'HEAD');
};

// `plan` клонирует голову во временный каталог; здесь каждый клон — под корнем этого теста, никогда
// не в общем TEMP (тест не оставляет за собой клонов).
const SCRATCH_ROOT = join(root, 'scratch');
const reviewPlan = (...a: string[]) =>
  spawnSync(
    process.execPath,
    [
      join(TOOLS, 'review-plan.mjs'),
      ...a,
      ...(a[0] === 'plan' && !a.includes('--scratch') && !a.includes('--scratch-root')
        ? ['--scratch-root', SCRATCH_ROOT]
        : []),
    ],
    { encoding: 'utf8' },
  );

const sweep = (await import(pathToFileURL(join(TOOLS, 'review-sweep.mjs')).href)) as {
  resolvePaths: (
    raw: string,
    files: string[],
    viaGit?: (p: string) => number,
  ) => { paths: string[]; unmatched: string[] };
};

describe('review-sweep: --paths', () => {
  const files = ['src/a.go', 'my docs/a.md', 'my docs/b.md', 'other/x.go'];

  it('сопоставляет путь с пробелом целиком', () => {
    expect(sweep.resolvePaths('my docs/a.md', files)).toEqual({
      paths: ['my docs/a.md'],
      unmatched: [],
    });
  });

  it('делит список через запятую и перевод строки', () => {
    expect(sweep.resolvePaths('src/a.go,other/x.go\nmy docs', files).paths).toEqual([
      'src/a.go',
      'other/x.go',
      'my docs',
    ]);
  });

  it('читает список через пробел, самый длинный путь первым', () => {
    expect(sweep.resolvePaths('my docs src/a.go', files)).toEqual({
      paths: ['my docs', 'src/a.go'],
      unmatched: [],
    });
  });

  it('несовпавший путь попадает в unmatched, а не пропадает молча', () => {
    expect(sweep.resolvePaths('src/a.go,nope/missing.go', files)).toEqual({
      paths: ['src/a.go'],
      unmatched: ['nope/missing.go'],
    });
  });

  it('CLI: путь вне диффа — код 2, «swept 0 of N», пустой stdout', () => {
    const repo = makeRepo('sweep');
    put(repo, 'src/a.go', ['package a']);
    const base = commit(repo, 'base');
    put(repo, 'src/a.go', ['package a', 'func F() {}']);
    commit(repo, 'head');
    const r = spawnSync(
      process.execPath,
      [
        join(TOOLS, 'review-sweep.mjs'),
        'sweep',
        '--repo',
        repo,
        '--base',
        base,
        '--paths',
        'nope/x.go',
      ],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/swept 0 of 1 given/);
    expect(r.stdout.trim()).toBe('');
  });

  it('CLI: неизвестная база — код 2, а не «чистый» пустой дифф', () => {
    const repo = makeRepo('sweep-base');
    put(repo, 'a.go', ['package a']);
    commit(repo, 'base');
    const r = spawnSync(
      process.execPath,
      [join(TOOLS, 'review-sweep.mjs'), 'sweep', '--repo', repo, '--base', 'deadbeef00'],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not a commit/);
  });

  it('CLI: голова — дерево (`git write-tree`), неотслеживаемый код читается, а не код 2', () => {
    const repo = makeRepo('sweep-tree');
    put(repo, 'a.go', ['package a']);
    const base = commit(repo, 'base');
    put(repo, 'b.go', ['package a', 'func B() {}']);
    git(repo, 'add', '-A');
    const tree = git(repo, 'write-tree');
    const r = spawnSync(
      process.execPath,
      [join(TOOLS, 'review-sweep.mjs'), 'sweep', '--repo', repo, '--base', base, '--head', tree],
      { encoding: 'utf8' },
    );
    expect(r.stderr).not.toMatch(/is not a commit/);
    expect(r.status).toBe(0);
  });
});

// Хранилища стража — под корнем теста, настоящее состояние набора тест не трогает.
process.env.AGENTDECK_KIT_STATE = join(root, 'kit-state');
process.env.AGENTDECK_KIT_DOC_POLICY_STORE = join(root, 'kit-state', 'doc-hygiene.json');
const docBloatGuard = (
  (await import(
    pathToFileURL(join(builtinKitDir(), 'hooks', 'lib', 'doc-bloat-guard.mjs')).href
  )) as { default: (input: unknown) => string | null }
).default;

describe('doc-bloat-guard: бюджет скилла', () => {
  const write = (rel: string, kb: number): string => {
    const file = join(root, 'bloat', rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'x'.repeat(kb * 1024));
    return file;
  };
  const run = (file: string) => docBloatGuard({ tool_input: { file_path: file } });

  it('файл скилла до 16 КБ — страж молчит', () => {
    expect(run(write('.claude/skills/s/SKILL.md', 10))).toBeNull();
  });

  it('файл скилла больше 16 КБ — страж предупреждает', () => {
    expect(run(write('.claude/skills/big/SKILL.md', 17))).toMatch(/doc-bloat-guard/);
  });

  it('прочий агентский документ того же размера — предупреждение остаётся', () => {
    expect(run(write('proj/CLAUDE.md', 10))).toMatch(/doc-bloat-guard/);
  });
});

describe('review-position', () => {
  const base = nums(40);
  const head = [...base];
  head.splice(29, 1);
  head.splice(20, 0, 'ADDED A', 'ADDED B');
  head.splice(9, 1, 'CHANGED 10a', 'CHANGED 10b');
  const repo = makeRepo('position');
  put(repo, 'src/a.txt', base);
  const B = commit(repo, 'base');
  put(repo, 'src/a.txt', head);
  const H = commit(repo, 'head');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tool prints a free-form position JSON the tests probe by path
  type Out = { status: number | null; stderr: string; json: Record<string, any> | null };
  const pos = (lines: string, ...extra: string[]): Out => {
    const r = spawnSync(
      process.execPath,
      [
        join(TOOLS, 'review-position.mjs'),
        ...['--repo', repo, '--file', 'src/a.txt', '--lines', lines],
        ...['--base-sha', B, '--start-sha', B, '--head-sha', H, ...extra],
      ],
      { encoding: 'utf8' },
    );
    let json: Out['json'];
    try {
      json = JSON.parse(r.stdout) as Out['json'];
    } catch {
      json = null;
    }
    return { status: r.status, stderr: r.stderr, json };
  };
  const code = (o: number, n: number): string => `${sha1('src/a.txt')}_${o}_${n}`;

  it('одна строка — обычная позиция без line_range', () => {
    const r = pos('10');
    expect(r.status).toBe(0);
    expect(r.json?.position).toMatchObject({ new_line: 10, old_line: null, position_type: 'text' });
    expect(r.json?.position.line_range).toBeUndefined();
  });

  it('диапазон добавленных строк — line_range, счётчик старой строки следующий', () => {
    const r = pos('10-11');
    expect(r.json?.position.new_line).toBe(11);
    expect(r.json?.position.line_range.start).toMatchObject({
      line_code: code(11, 10),
      type: 'new',
    });
    expect(r.json?.position.line_range.end.line_code).toBe(code(11, 11));
    expect(r.json?.github).toMatchObject({ start_line: 10, line: 11, side: 'RIGHT' });
  });

  it('чистая вставка: старый счётчик = последняя старая строка + 1', () => {
    const r = pos('22-23');
    expect(r.json?.position.line_range.start.line_code).toBe(code(21, 22));
    expect(r.json?.position.line_range.end.line_code).toBe(code(21, 23));
  });

  it('контекстные строки сдвигаются на прошлые хунки', () => {
    const r = pos('25-26');
    expect(r.json?.position.line_range.start.line_code).toBe(code(22, 25));
    expect(r.json?.position.line_range.end.line_code).toBe(code(23, 26));
  });

  it('удалённая строка — сторона old', () => {
    const r = pos('30', '--side', 'old');
    expect(r.json?.position).toMatchObject({ old_line: 30, new_line: null });
    expect(r.json?.github.side).toBe('LEFT');
  });

  it('строка вне диффа — код 3, подсказка про «вне диффа»', () => {
    const r = pos('15');
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/outside the diff/);
  });

  it('за концом файла — код 2', () => {
    expect(pos('40-60').status).toBe(2);
  });

  it('неизвестный sha — код 2', () => {
    const r = spawnSync(
      process.execPath,
      [
        join(TOOLS, 'review-position.mjs'),
        ...['--repo', repo, '--file', 'src/a.txt', '--lines', '10'],
        ...['--base-sha', 'deadbeef00', '--head-sha', H],
      ],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not a commit/);
  });
});

describe('review-plan: промпт полосы и заготовка отчёта', () => {
  const repo = makeRepo('plan');
  put(repo, 'svc/a.ts', nums(5));
  const base = commit(repo, 'base');
  put(repo, 'svc/a.ts', nums(40));
  put(repo, 'ui/b.tsx', nums(30));
  const head = commit(repo, 'head');
  const out = join(repo, '.plan');
  const run = (...a: string[]) => reviewPlan(...a);
  const planFile = join(out, 'plan.json');
  run('plan', '--repo', repo, '--base', base, '--out', out, '--slug', 'mr-7', '--scope', 'MR !7');

  it('plan --slug пишет промпт первого раунда на каждую полосу', () => {
    const r = run('prompt', '--plan', planFile, '--lane', 'B', '--slug', 'mr-7');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[return-format]');
    expect(r.stdout).toContain('[no-subagents]');
    expect(r.stdout).toContain('.agent/tmp/review-mr-7/lane-B.md');
    expect(r.stdout).toContain(`head ${head}`);
    expect(r.stdout).toContain('svc/a.ts');
    expect(r.stdout).toContain('ui/b.tsx');
    expect(r.stdout).toContain('never run it here');
    expect(r.stdout).toContain('never sleep-poll');
  });

  it('неизвестная полоса — код 2', () => {
    expect(run('prompt', '--plan', planFile, '--lane', 'Z').status).toBe(2);
  });

  it('заготовка несёт все ключи стража, остальное — пустые ⟨fill⟩, которые страж отклоняет', async () => {
    const r = run('skeleton', '--plan', planFile, '--tier', 'T2');
    expect(r.status).toBe(0);
    for (const k of ['promises', 'attacker', 'siblings', 'contract', '**Ledger:**', '**Dropped:**'])
      expect(r.stdout).toContain(k);
    const report = (await import(
      pathToFileURL(join(builtinKitDir(), 'hooks', 'lib', 'review-report.mjs')).href
    )) as { writeProblems: (text: string) => string[] };
    expect(report.writeProblems(r.stdout).join(' ')).toContain('skeleton blank');
  });
});

describe('review-plan: размер по токенам, файлы данных, исполненные раунды', () => {
  const repo = makeRepo('plan-g8');
  const rec = (i: number, extra: Record<string, string> = {}) => ({
    page: `p${i}`,
    rule: 'pair',
    quote: `q${i}`,
    ...extra,
  });
  const json = (v: unknown) => JSON.stringify(v, null, 2).split('\n');
  put(repo, 'scripts/quote-baseline.json', json(Array.from({ length: 30 }, (_, i) => rec(i))));
  put(repo, 'src/a.ts', nums(5));
  put(repo, 'gone.txt', nums(900));
  const base = commit(repo, 'base');
  // Длинные строки: 300 изменённых строк — под лимитом строк, но ≈56k токенов.
  put(
    repo,
    'docs/big.md',
    Array.from({ length: 300 }, (_, i) => `${i} ${'слово '.repeat(60)}`),
  );
  const head30 = Array.from({ length: 30 }, (_, i) => rec(i)).slice(5);
  head30[0] = rec(5, { ticket: 'T-1' });
  head30[1] = rec(6, { ticket: 'T-1' });
  put(repo, 'scripts/quote-baseline.json', json([...head30, rec(100), rec(101), rec(102)]));
  put(repo, 'src/a.ts', nums(40));
  const gone = nums(900);
  gone[799] = 'changed 800';
  put(repo, 'gone.txt', [...gone.slice(0, 99), ...gone.slice(599)]);
  commit(repo, 'head');
  const out = join(repo, '.plan');
  const planFile = join(out, 'plan.json');
  const run = (...a: string[]) => reviewPlan(...a);
  const risk = join(repo, 'risk.txt');
  writeFileSync(
    risk,
    'VERIFICATION TIER: T2 · base abc · files 4 (behavioural 1)\n\nWhat raised the tier:\n  · contract file — docs/big.md\n\nnext\n',
  );
  const made = run(
    'plan',
    ...['--repo', repo, '--base', base, '--out', out, '--slug', 'g8', '--scope', 'MR !8'],
    ...['--tests-record', 'rec/tests-run.txt', '--tests-record', 'rec/content-check.log'],
    ...['--risk', risk],
  );
  type Chunk = {
    id: string;
    tokens?: number;
    kind?: string;
    items: { path: string; from?: number; to?: number }[];
  };
  type Plan = {
    chunks: Chunk[];
    lanes: { id: string; chunks: string[]; rounds: string[][]; roundTokens?: number[] }[];
    rounds: number;
    risk?: { tier: string; markers: string[] };
  };
  const p = (): Plan => JSON.parse(readFileSync(planFile, 'utf8')) as Plan;

  it('чанк и раунд полосы режутся по оценке токенов, а не только по строкам', () => {
    expect(made.status, made.stderr).toBe(0);
    const big = p().chunks.filter((c) => c.items.some((it) => it.path === 'docs/big.md'));
    expect(big.length).toBeGreaterThanOrEqual(3);
    for (const c of p().chunks) expect(c.tokens ?? Infinity).toBeLessThanOrEqual(25000);
    for (const l of p().lanes)
      for (const t of l.roundTokens ?? [Infinity]) expect(t).toBeLessThanOrEqual(50000);
    expect(made.stdout).toMatch(/≈\d+k tokens/);
  });

  // Раунд 50k плюс бриф ≈9.5k оставлял под потолком 60k ≈0k. Планка — литералами: константа,
  // сдвинутая в инструменте, не сдвигает её вместе с собой.
  it('запас: раунд + потолок брифа + 15k рабочего места ≤ 60k; каждый записанный бриф под потолком', async () => {
    const m = (await import(pathToFileURL(join(TOOLS, 'review-plan.mjs')).href)) as {
      LANE_CONTEXT: number;
      BRIEF_TOKENS: number;
      ROUND_TOKENS: number;
      estTokens: (bytes: number, lines: number) => number;
    };
    expect(m.LANE_CONTEXT).toBe(60000);
    expect(m.ROUND_TOKENS + m.BRIEF_TOKENS + 15000).toBeLessThanOrEqual(60000);
    expect(m.ROUND_TOKENS).toBeGreaterThanOrEqual(30000);
    for (const l of p().lanes)
      for (const t of l.roundTokens ?? [Infinity])
        expect(t + m.BRIEF_TOKENS + 15000).toBeLessThanOrEqual(60000);
    const briefs = ['A', 'B'].map((l) => readFileSync(join(out, `lane-${l}-r1.prompt.md`), 'utf8'));
    for (const s of briefs)
      expect(m.estTokens(Buffer.byteLength(s, 'utf8'), s.split('\n').length)).toBeLessThanOrEqual(
        m.BRIEF_TOKENS,
      );
  });

  // Чанк 25k в раунде 35k ложился по одному на раунд: 61 полосо-раунд на 705 файлах, при половине — 45.
  it('чанк — половина раунда: бюджет чанка × 2 ≤ бюджета раунда, каждый чанк плана ≤ ROUND_TOKENS / 2', async () => {
    const m = (await import(pathToFileURL(join(TOOLS, 'review-plan.mjs')).href)) as {
      CHUNK_TOKENS: number;
      ROUND_TOKENS: number;
    };
    expect(m.CHUNK_TOKENS * 2).toBeLessThanOrEqual(m.ROUND_TOKENS);
    expect(m.CHUNK_TOKENS * 2).toBeGreaterThanOrEqual(m.ROUND_TOKENS - 1);
    expect(p().chunks.length).toBeGreaterThan(0);
    for (const c of p().chunks)
      expect(c.tokens ?? Infinity).toBeLessThanOrEqual(m.ROUND_TOKENS / 2);
  });

  it('чистое удаление строк — диапазон N..N+1, а не одна строка', () => {
    // `@@ -100,500 +99,0 @@`: удалённые строки стоят между строками 99 и 100 головы.
    const del = p()
      .chunks.flatMap((c) => c.items)
      .find((it) => it.path === 'gone.txt' && it.from === 99);
    expect(del).toMatchObject({ from: 99, to: 100 });
  });

  it('файл данных — один чанк data у одной полосы, сводка по ключам в её промпте', () => {
    const data = p().chunks.filter((c) => c.kind === 'data');
    expect(data.map((c) => c.items.map((it) => it.path))).toEqual([
      ['scripts/quote-baseline.json'],
    ]);
    const id = data[0]?.id ?? '';
    const owners = p()
      .lanes.filter((l) => l.chunks.includes(id))
      .map((l) => l.id);
    expect(owners).toEqual(['B']);
    const b = run('prompt', '--plan', planFile, '--lane', 'B', '--chunks', id);
    expect(b.stdout).toContain('added 3 · removed 5 · changed 2');
    expect(b.stdout).toContain('[data, yours alone]');
    expect(readFileSync(join(out, `data-${id}.txt`), 'utf8')).toContain('+ page=p100');
  });

  it('check считает исполненные раунды по заголовку отчёта и требует неисполненные', () => {
    const l = p().lanes;
    expect(p().rounds).toBeGreaterThanOrEqual(2);
    const rows = (id: string) =>
      l
        .find((x) => x.id === id)!
        .chunks.flatMap((c) =>
          p()
            .chunks.find((x) => x.id === c)!
            .items.map((it) => `| ${it.path} | read |`),
        );
    const fa = join(repo, 'lane-A.md');
    const fb = join(repo, 'lane-B.md');
    const r1 = (id: string) => (l.find((x) => x.id === id)?.rounds[0] ?? []).join(' ');
    writeFileSync(fa, [`# Lane A r1 — ${r1('A')}`, ...rows('A')].join('\n'));
    writeFileSync(fb, [`# Lane B r1 — ${r1('B')}`, ...rows('B')].join('\n'));
    const r = run('check', '--plan', planFile, fa, fb);
    expect(r.stdout).toContain(`rounds 1 of ${p().rounds}`);
    expect(r.stdout).toMatch(/RERUN lane A: .*round 2 never ran/);
    expect(r.status).toBe(1);
  });

  it('промпт: отчёт одним Write с заголовком раунда, затем Edit; без echo и heredoc', () => {
    const r = run('prompt', '--plan', planFile, '--lane', 'A');
    expect(r.stdout).toContain('one Write whose first line is `# Lane A r1 — ');
    expect(r.stdout).toContain('never echo, a heredoc');
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(20000);
  });

  it('несколько --tests-record — каждый назван базой чистой головы', () => {
    const r = run('prompt', '--plan', planFile, '--lane', 'B');
    expect(r.stdout).toContain('Clean-head baseline');
    expect(r.stdout).toContain('rec/tests-run.txt · rec/content-check.log');
  });

  it('запись прогона run.json — итог в строке промпта, путь остаётся, полосе велено Grep, а не cat', () => {
    const runs = join(repo, '.agent', 'tests', 'runs');
    mkdirSync(runs, { recursive: true });
    const results = Array.from({ length: 11 }, (_, i) => ({
      groupId: 'roles',
      caseId: `roles-${i}`,
      status: i < 10 ? 'failed' : 'passed',
      note: 'x'.repeat(3000),
    }));
    writeFileSync(
      join(runs, 'a.run.json'),
      JSON.stringify({
        status: 'done',
        commit: 'abcdef1234567890',
        results,
        summary: { total: 11, passed: 1, failed: 10, skipped: 0, blocked: 0 },
        tests: { passed: 40, failed: 10, skipped: 1 },
      }),
    );
    const r = run(
      'prompt',
      '--plan',
      planFile,
      '--lane',
      'B',
      '--tests-record',
      '.agent/tests/runs/a.run.json,rec/x.log',
    );
    expect(r.stdout).toContain(
      '.agent/tests/runs/a.run.json (done at abcdef123456: 11 cases — 1 passed, 10 failed, 0 skipped; tests 40 passed, 10 failed, 1 skipped; failed roles:roles-0, roles:roles-1, roles:roles-2, roles:roles-3, roles:roles-4, roles:roles-5, roles:roles-6, roles:roles-7 … +2) · rec/x.log.',
    );
    expect(r.stdout).toContain('never a cat or a whole Read');
  });

  it('plan печатает заглушку как спавн по умолчанию — с литералами стража, без «still pass it verbatim»', () => {
    expect(made.stdout).toContain(
      'spawn: prompt = the stub «Your full brief is <lane prompt file above> — Read it first, in one Read. [return-format]',
    );
    expect(made.stdout).toContain('[no-subagents] Work directly; spawn nothing.');
    expect(made.stdout).not.toContain('still pass it verbatim');
  });

  it('уровень из --risk хранится в плане; status и skeleton читают его без risk-tier', () => {
    expect(p().risk).toMatchObject({ tier: 'T2', markers: ['contract file — docs/big.md'] });
    const s = run('status', '--plan', planFile);
    expect(s.status).toBe(0);
    expect(s.stdout).toContain('tier: T2');
    expect(s.stdout).toContain(`rounds 0 of ${p().rounds}`);
    expect(s.stdout).toContain('next: spawn round 1');
    expect(run('skeleton', '--plan', planFile).stdout).toContain('**Tier:** T2 — contract file');
  });
});

describe('review-plan: промпт сверх потолка', () => {
  it('ядро промпта больше 20000 B — plan и prompt говорят это громко и называют --chunks', () => {
    const repo = makeRepo('plan-wide');
    put(repo, 'README', ['base']);
    const base = commit(repo, 'base');
    for (let i = 0; i < 160; i++)
      put(
        repo,
        `ui/${'nested-feature-folder/'.repeat(4)}component-${String(i).padStart(3, '0')}.tsx`,
        nums(2),
      );
    commit(repo, 'head');
    const out = join(repo, '.plan');
    const run = (...a: string[]) => reviewPlan(...a);
    const made = run(
      'plan',
      '--repo',
      repo,
      '--base',
      base,
      '--out',
      out,
      '--slug',
      'wide',
      '--per-round',
      '20',
    );
    expect(made.status).toBe(0);
    expect(made.stdout).toMatch(/PROMPT OVER CAP: .*lane-\w+-r1\.prompt\.md is \d+ B > 20000 B/);
    expect(made.stdout).toContain('--chunks <fewer ids>');
    const lane = /lane-(\w+)-r1\.prompt\.md is/.exec(made.stdout)?.[1] ?? 'A';
    const p = run('prompt', '--plan', join(out, 'plan.json'), '--lane', lane, '--slug', 'wide');
    expect(p.status).toBe(0);
    expect(p.stderr).toContain('PROMPT OVER CAP: this prompt');
  });
});

// g9: обе полосы читали 144 тестовых файла и 56 переводов, чей ru-двойник в диффе, — 42 полосо-раунда
// там, где хватает ~31; полоса уходила за 160k и теряла журнал при сжатии.
describe('review-plan: тесты и переводы — только полосе TEST, потолок контекста 60k', () => {
  type Chunk = {
    id: string;
    kind?: string;
    lines: number;
    items: { path: string; twin?: string }[];
  };
  type Lane = { id: string; chunks: string[]; rounds: string[][] };
  // Две полосы при ≤100 файлах — кортеж, чтобы A и B не были «possibly undefined».
  type Plan = {
    chunks: Chunk[];
    lanes: [Lane, Lane];
    laneRounds: number;
    parity: string | null;
  };
  const repo = makeRepo('plan-f2');
  put(repo, 'README', ['base']);
  const base = commit(repo, 'base');
  for (const f of ['ui/a.tsx', 'ui/a.test.tsx', 'ui/b.tsx', 'ui/b.test.tsx'])
    put(repo, f, nums(100));
  for (const f of ['docs/ru/x.mdx', 'docs/en/x.mdx', 'docs/uz/x.mdx', 'docs/en/only.mdx'])
    put(repo, f, nums(30));
  commit(repo, 'head');
  const run = (...a: string[]) => reviewPlan(...a);
  const planOf = (out: string, ...extra: string[]) => {
    const r = run(
      'plan',
      '--repo',
      repo,
      '--base',
      base,
      '--out',
      join(repo, out),
      '--per-round',
      '1',
      '--max-rounds',
      '20',
      ...extra,
    );
    return { r, p: JSON.parse(readFileSync(join(repo, out, 'plan.json'), 'utf8')) as Plan };
  };
  const chunkOf = (p: Plan, f: string) => p.chunks.find((c) => c.items.some((it) => it.path === f));
  const plain = planOf('.p0');
  const par = planOf('.p1', '--parity', 'content:check', '--slug', 'f2');

  it('тестовый файл — в своём чанке, вперемешку с кодом зона даёт два чанка, а не по чанку на файл', () => {
    const { p } = plain;
    expect(plain.r.status).toBe(0);
    expect(chunkOf(p, 'ui/a.test.tsx')?.kind).toBe('test');
    expect(chunkOf(p, 'ui/a.tsx')?.kind).toBeUndefined();
    expect(
      p.chunks.every((c) =>
        c.items.every((it) => /\.test\.tsx$/.test(it.path) === (c.kind === 'test')),
      ),
    ).toBe(true);
    expect(p.chunks.filter((c) => c.items[0]?.path.startsWith('ui/'))).toHaveLength(2);
  });

  it('тестовый чанк читает только B; сумма полосо-раундов меньше двух читателей на чанк и печатается', () => {
    const { p, r } = plain;
    const [A, B] = p.lanes;
    const tests = p.chunks.filter((c) => c.kind === 'test').map((c) => c.id);
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.every((id) => B.chunks.includes(id) && !A.chunks.includes(id))).toBe(true);
    expect(A.rounds.length).toBeLessThan(B.rounds.length);
    expect(p.laneRounds).toBe(A.rounds.length + B.rounds.length);
    expect(p.laneRounds).toBeLessThan(2 * p.chunks.length);
    expect(r.stdout).toContain(`lane-rounds ${p.laneRounds}`);
    expect(r.stdout).toContain('translations stay with both lanes: no --parity');
  });

  it('с --parity перевод с ru-двойником в диффе — чанк i18n у B; ru и перевод без двойника читают обе', () => {
    const { p, r } = par;
    const [A, B] = p.lanes;
    const tr = chunkOf(p, 'docs/en/x.mdx');
    expect(r.status).toBe(0);
    expect(tr?.kind).toBe('i18n');
    expect(chunkOf(p, 'docs/uz/x.mdx')).toBe(tr);
    expect(tr?.items.every((it) => it.twin === 'docs/ru/x.mdx')).toBe(true);
    expect(B.chunks).toContain(tr?.id);
    expect(A.chunks).not.toContain(tr?.id);
    expect(chunkOf(p, 'docs/ru/x.mdx')?.kind).toBeUndefined();
    expect(A.chunks).toContain(chunkOf(p, 'docs/en/only.mdx')?.id);
    expect(r.stdout).toMatch(
      /TEST lanes only: 2 test files, 2 translations \(twin in the diff, parity: content:check\)/,
    );
    const readA = (q: Plan) =>
      q.lanes[0].chunks.reduce((s, id) => s + (q.chunks.find((c) => c.id === id)?.lines ?? 0), 0);
    expect(readA(plain.p) - readA(p)).toBe(60);
  });

  it('промпт A запрещает читать тесты, промпт B помечает тесты и переводы своими; в обоих потолок 60k', () => {
    const { p } = par;
    const prompt = (lane: string, chunks: string[]) =>
      run(
        'prompt',
        '--plan',
        join(repo, '.p1', 'plan.json'),
        '--lane',
        lane,
        '--slug',
        'f2',
        '--chunks',
        chunks.join(','),
      );
    const a = prompt('A', p.lanes[0].chunks);
    const b = prompt('B', [chunkOf(p, 'ui/a.test.tsx')!.id, chunkOf(p, 'docs/en/x.mdx')!.id]);
    expect(a.status).toBe(0);
    expect(a.stdout).toMatch(/never read a test file/);
    expect(a.stdout).toContain("a translation's claims are its ru twin's");
    expect(a.stdout).not.toContain('ui/a.test.tsx');
    expect(b.stdout).toMatch(/\[tests, yours alone/);
    expect(b.stdout).toContain(
      '[translations, yours alone]: docs/en/x.mdx ← docs/ru/x.mdx · docs/uz/x.mdx ← docs/ru/x.mdx',
    );
    expect(b.stdout).not.toMatch(/never read a test file/);
    for (const s of [a.stdout, b.stdout]) expect(s).toContain('Context cap ≈60k tokens');
  });

  it('contextLine: бриф и дифф раунда вычтены из 60k, за потолком — вернуть с RERUN по непрочитанному', async () => {
    const { contextLine } = (await import(pathToFileURL(join(TOOLS, 'review-plan.mjs')).href)) as {
      contextLine: (t: number) => string;
    };
    const { twinOf } = (await import(pathToFileURL(join(TOOLS, 'review-plan.mjs')).href)) as {
      twinOf: (f: string, source: string, inDiff: Set<string>) => string | null;
    };
    const set = new Set(['i18n/a.ru.json', 'docs/ru/x.mdx']);
    expect(twinOf('i18n/a.en.json', 'ru', set)).toBe('i18n/a.ru.json');
    expect(twinOf('docs/uz/x.mdx', 'ru', set)).toBe('docs/ru/x.mdx');
    expect(twinOf('i18n/a.ru.json', 'ru', set)).toBeNull();
    expect(twinOf('docs/ru/x.mdx', 'ru', set)).toBeNull();
    expect(twinOf('docs/en/y.mdx', 'ru', set)).toBeNull();
    expect(twinOf('i18n/b.en.json', 'ru', set)).toBeNull();
    const cl = contextLine(35000);
    expect(cl).toMatch(/Context cap ≈60k tokens/);
    expect(cl).toContain('this brief (≤ 10k)');
    expect(cl).toContain("round's diff (≈35k)");
    expect(cl).toContain('leave ≈15k');
    expect(cl).toMatch(/hand back at once.*RERUN/);
  });

  // A без тестов × B с тестами — разные популяции: пересечение мало по построению, N̂ раздут.
  // Такая оценка («осталось ≈87») раньше гнала лишние раунды; раунд советует только одна популяция.
  it('estimate: раунд советует только пара одной популяции; A × B плана и пара без --plan — только справка', () => {
    const est = (...a: string[]) => run('estimate', '--n1', '40', '--n2', '42', '--m', '10', ...a);
    const bare = est();
    expect(bare.stdout).toMatch(/total ≈159\.3, found 72, remaining ≈87\.3/);
    expect(bare.stdout).toContain('population unchecked');
    expect(bare.stdout).not.toContain('another round is worth it');
    const ab = est('--plan', join(repo, '.p0', 'plan.json'), '--pair', 'A,B');
    expect(ab.status, ab.stderr).toBe(0);
    expect(ab.stdout).toMatch(/different populations \(artifacts differ/);
    expect(ab.stdout).toContain('never a reason for another round');
    expect(ab.stdout).not.toContain('another round is worth it');
    const syn = join(repo, 'estimate-plan.json');
    const lane = (id: string, chunks: string[]) => ({ id, artifacts: 'TEST + AUTHZ', chunks });
    writeFileSync(
      syn,
      JSON.stringify({
        lanes: [lane('B1', ['c001', 'c002']), lane('B9', ['c002', 'c001']), lane('B8', ['c001'])],
      }),
    );
    const same = est('--plan', syn, '--pair', 'B1,B9');
    expect(same.stdout).toContain('same population');
    expect(same.stdout).toContain('another round is worth it');
    const sub = est('--plan', syn, '--pair', 'B1,B8');
    expect(sub.stdout).toContain('chunks differ');
    expect(sub.stdout).not.toContain('another round is worth it');
    const bad = est('--plan', syn, '--pair', 'B1,Z');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('no lane Z');
  });
});

// G1: без --scratch промпт полосы говорил `<scratch clone>` — полоса A живого ревью потеряла все
// пробы, две другие строили клон руками через `cp -r`. Теперь клон делает сам `plan`, метку
// `.git/review-plan-scratch.json` читает суд групп панели, а промпт без настоящего клона не печатается.
describe('review-plan: клон для проб делает plan, промпт без клона не печатается', () => {
  const repo = makeRepo('plan-scratch');
  put(repo, 'README', ['base']);
  const base = commit(repo, 'base');
  put(repo, 'svc/a.ts', nums(40));
  put(repo, 'package-lock.json', ['{"lockfileVersion":3}']);
  put(repo, '.gitignore', ['node_modules/']);
  const head = commit(repo, 'head');
  put(repo, 'node_modules/dep/index.js', ['module.exports = 1']);
  const out = join(repo, '.plan');
  const planFile = join(out, 'plan.json');
  const clone = join(SCRATCH_ROOT, 'review-g5', 'clone');
  const made = reviewPlan(
    ...['plan', '--repo', repo, '--base', base, '--out', out],
    ...['--slug', 'g5', '--scope', 'MR !9'],
  );
  const lanePrompt = (id: string) => readFileSync(join(out, `lane-${id}-r1.prompt.md`), 'utf8');

  it('без --scratch plan клонирует голову в <root>/review-<slug>/clone и называет его в каждом промпте', () => {
    expect(made.status, made.stderr).toBe(0);
    expect(made.stdout).toContain(`scratch: ${clone} (created;`);
    expect(made.stdout).toContain(`clean --scratch ${clone}`);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
    for (const id of ['A', 'B']) {
      const text = lanePrompt(id);
      expect(text).not.toContain('<scratch clone>');
      expect(text).toContain(`probes run from ${clone} (a clone at head ${head};`);
    }
  });

  it('node_modules связан из копии при том же lockfile; метку клона узнаёт суд групп панели', () => {
    expect(existsSync(join(clone, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(lanePrompt('A')).toContain('node_modules linked from the checkout: .');
    const mark = reviewScratchMark(join(clone, 'svc', 'a.ts'));
    expect(mark?.source).toBe(canonical(repo));
    expect(mark?.links).toEqual([canonical(join(clone, 'node_modules'))]);
  });

  it('prompt берёт клон из plan.json; второй plan на той же голове переиспользует клон', () => {
    const p = reviewPlan('prompt', '--plan', planFile, '--lane', 'B', '--slug', 'g5');
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toContain(`probes run from ${clone}`);
    expect(reviewPlan('status', '--plan', planFile).stdout).toContain(`scratch: ${clone}`);
    const again = reviewPlan(
      ...['plan', '--repo', repo, '--base', base, '--out', out, '--slug', 'g5'],
    );
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/scratch: .*\(reused;/);
  });

  it('--scratch none — план только для размера: prompt отказывает с кодом 2, без заглушки', () => {
    const sizing = join(repo, '.sizing');
    const r = reviewPlan(
      ...['plan', '--repo', repo, '--base', base, '--out', sizing, '--slug', 'g5'],
      ...['--scratch', 'none'],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('scratch: none — sizing only');
    expect(existsSync(join(sizing, 'lane-A-r1.prompt.md'))).toBe(false);
    const refused = reviewPlan('prompt', '--plan', join(sizing, 'plan.json'), '--lane', 'A');
    expect(refused.status).toBe(2);
    expect(refused.stdout).not.toContain('<scratch');
    expect(refused.stderr).toContain('no scratch clone in the plan');
  });

  it('клон на другой голове — отказ с кодом 2, а не промпт с чужим деревом', () => {
    const r = reviewPlan(
      ...['plan', '--repo', repo, '--base', base, '--head', base, '--out', join(repo, '.old')],
      ...['--slug', 'g5'],
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`scratch ${clone} exists at ${head}`);
    const given = reviewPlan(
      ...['plan', '--repo', repo, '--base', base, '--head', base, '--out', join(repo, '.old')],
      ...['--scratch', clone],
    );
    expect(given.status).toBe(2);
    expect(given.stderr).toContain(`--scratch ${clone} is at ${head}`);
  });

  it('clean: ссылка плана стала обычным каталогом — отказ с кодом 2 до того, как тронута любая ссылка', () => {
    const fake = join(root, 'fake-scratch', 'clone');
    const deps = join(root, 'fake-deps');
    mkdirSync(join(fake, '.git'), { recursive: true });
    mkdirSync(join(fake, 'a'), { recursive: true });
    mkdirSync(join(fake, 'b', 'node_modules'), { recursive: true });
    mkdirSync(deps, { recursive: true });
    symlinkSync(deps, join(fake, 'a', 'node_modules'), 'junction');
    const linked = join(fake, 'a', 'node_modules');
    const plain = join(fake, 'b', 'node_modules');
    const links = [linked, plain];
    writeFileSync(
      join(fake, '.git', 'review-plan-scratch.json'),
      JSON.stringify({ source: repo, head, links, install: [], deps: 'x' }),
    );
    const r = reviewPlan('clean', '--scratch', fake);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`${plain} is no longer a link — nothing removed`);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(existsSync(join(fake, 'b', 'node_modules'))).toBe(true);
  });

  it('неудачный checkout не оставляет полуклона: каталог без метки clean бы не убрал', async () => {
    const rp = (await import(pathToFileURL(join(TOOLS, 'review-plan.mjs')).href)) as {
      scratch: (p: { repo: string; headSha: string }, o: Record<string, string>) => unknown;
    };
    const failRoot = join(root, 'scratch-fail');
    expect(() =>
      rp.scratch({ repo, headSha: 'f'.repeat(40) }, { slug: 'half', 'scratch-root': failRoot }),
    ).toThrow(/scratch clone failed/);
    expect(existsSync(join(failRoot, 'review-half', 'clone'))).toBe(false);
  });

  it('clean снимает ссылки, затем клон — node_modules копии цел; чужой каталог не трогает', () => {
    const foreign = reviewPlan('clean', '--scratch', repo);
    expect(foreign.status).toBe(2);
    expect(foreign.stderr).toContain('not a clone review-plan made');
    expect(existsSync(join(repo, 'svc', 'a.ts'))).toBe(true);
    const r = reviewPlan('clean', '--scratch', clone);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('1 node_modules link unlinked first');
    expect(existsSync(clone)).toBe(false);
    expect(existsSync(join(repo, 'node_modules', 'dep', 'index.js'))).toBe(true);
  });
});
