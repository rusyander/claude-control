import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Неявный вердикт review-sync набора: коммит после просмотренной головы, менявший строки в ±3 от места
 * опубликованной находки, пишется строкой `addressed by <sha7>`; калибровка (published · accepted ·
 * addressed · declined · other · silent, precision) — на отчёт и по --all. Настоящий git на синтетическом
 * репозитории во временном каталоге; подменена только кузница — `glab` заменён скриптом через
 * AGENTDECK_GLAB_CMD (транспорт набора), он же считает вызовы: --offline не должен сделать ни одного.
 * Порт ~/.claude/tools/tests/review-sync-implicit.test.mjs на английскую лексику отчёта набора.
 */

const TOOL = join(
  process.env.AGENTDECK_KIT_UNDER_TEST || builtinKitDir(),
  'tools',
  'review-sync.mjs',
);
const repo = mkdtempSync(join(tmpdir(), 'kit-review-sync-implicit-'));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const G = (...args: string[]): string => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const numbered = (n: number, tag: string): string[] =>
  Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`);
const readRows = (rel: string): string[] =>
  readFileSync(join(repo, rel), 'utf8').replace(/\n$/, '').split('\n');
const put = (rel: string, rows: string[]): void => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), rows.join('\n') + '\n');
};
const edit = (rel: string, fn: (r: string[]) => string[]): void => put(rel, fn(readRows(rel)));
const setLine =
  (n: number, s: string) =>
  (rows: string[]): string[] =>
    rows.map((r, i) => (i === n - 1 ? s : r));
const commit = (msg: string): string => {
  G('add', '-A', 'src');
  G('commit', '-q', '-m', msg);
  return G('rev-parse', 'HEAD');
};

G('init', '-q', '-b', 'main');
G('config', 'user.name', 'T');
G('config', 'user.email', 't@example.invalid');
G('config', 'core.autocrlf', 'false');
G('config', 'commit.gpgsign', 'false');
put('src/a.ts', numbered(60, 'a'));
put('src/b.ts', numbered(30, 'b'));
put('src/c.ts', numbered(20, 'c'));
put('src/old.ts', numbered(20, 'o'));
put('src/svc1/internal/store/chats.ts', numbered(10, 's')); // same 3-component tail as svc2's
put('src/svc2/internal/store/chats.ts', numbered(10, 's'));
const BASE = commit('base');
G('checkout', '-q', '-b', 'feat/x');
edit('src/c.ts', (r) => [...r, 'c tail']);
const H = commit('feature — the reviewed head');
edit('src/a.ts', (r) => [...numbered(10, 'new'), ...r]); // C1: 10 lines above everything in a.ts
const C1 = commit('c1 insert on top of a.ts');
edit('src/a.ts', setLine(25, 'far change')); // C2: nowhere near a site
commit('c2 far change');
edit('src/a.ts', setLine(52, 'fix at 42 (was 42 before C1)')); // C3: orig line 42, within 3 of a.ts:40
const C3 = commit('c3 near a.ts:40 after the shift');
G('mv', 'src/old.ts', 'src/new.ts'); // C4: pure rename
commit('c4 rename');
edit('src/new.ts', setLine(10, 'fix in the renamed file')); // C5: within 3 of old.ts:11
const C5 = commit('c5 change in the renamed file');
G('checkout', '-q', 'main');
edit('src/b.ts', (r) => [...numbered(5, 'main'), ...setLine(15, 'main changed 15')(r)]);
commit('main: b.ts shifted and line 15 changed');
G('checkout', '-q', 'feat/x');
G('merge', '-q', '--no-ff', '-m', 'Merge main into feat/x', 'main'); // touches b.ts:15, never attributed
edit('src/b.ts', setLine(25, 'fix at orig 20')); // C6: orig b.ts:20, after the merge's shift by 5
const C6 = commit('c6 near b.ts:20 through the merge');
edit('src/c.ts', setLine(9, 'fix at 9')); // C7: distance 3 from c.ts:12, distance 4 from c.ts:5
const C7 = commit('c7 c.ts line 9');
const TIP = C7;
G('checkout', '-q', '-b', 'feat/y'); // stacked on the MR: its commit must not count for MR !7
edit('src/c.ts', setLine(5, 'stacked follow-up at c.ts:5'));
commit('stacked follow-up');
G('checkout', '-q', '-b', 'side', H); // diverges at the head: MR !99 has no merge commit naming its branch
edit('src/a.ts', setLine(1, 'side'));
edit('src/svc1/internal/store/chats.ts', setLine(5, 'side fix'));
const SIDE = commit('side');
G('checkout', '-q', 'main');
G(
  'merge',
  '-q',
  '--no-ff',
  '-m',
  "Merge branch 'feat/x' into 'main'\n\nSee merge request grp/proj!7",
  'feat/x',
);
const s7 = (sha: string): string => sha.slice(0, 7);

// ---------- reports ----------
const reviews = join(repo, '.agent', 'reviews');
mkdirSync(reviews, { recursive: true });
const web = (iid: number): string => `https://git.example/grp/proj/-/merge_requests/${iid}`;
const F = (
  id: string,
  where: string,
  note: number | null,
  extra: string[] = [],
  status = 'open',
) => [
  `## ${id} 🟡 thesis of finding ${id} about the behaviour at this site`,
  '',
  `- **Where:** \`${where}\``,
  ...(note ? [`- **Thread:** ${web(7)}#note_${note}`] : []),
  ...extra,
  `- **Status:** ${status}`,
  '',
];
const HEADER = (iid: number, shaLine: string) => [
  `# Review: MR !${iid} test — base ${s7(BASE)}`,
  '',
  shaLine,
  '**Tier:** T1 — test',
  '**Summary:** 🔴 0 · 🟡 8 · 🟢 0 — blocking: none',
  '**Score:** raised 8 · published 7 · confirmed by author awaiting replies',
  '',
];
const REPORT7 = [
  // `current head` is the tip: read as the reviewed head it would leave 0 commits after it.
  ...HEADER(7, `**Base:** ${BASE} · **reviewed head:** ${H} · **current head:** ${TIP}`),
  ...F('F-01', 'src/a.ts:40', 701),
  ...F('F-02', 'src/a.ts:2', 702, [
    '- **Synced:** 2026-10-01 — thread open; author replies 1, last (declined): "Disagree, by design"',
  ]),
  ...F('F-03', 'src/.../old.ts:11', 703),
  ...F('F-04', 'src/b.ts:15', 704, [
    '- **Synced:** 2026-10-01 — thread resolved @author; author did not reply',
  ]),
  ...F('F-05', 'src/b.ts:20', 705),
  ...F('F-06', 'src/c.ts:5', 706),
  ...F('F-07', 'src/c.ts:12', 707, [], 'accepted'),
  ...F('F-08', 'src/a.ts:2', null),
].join('\n');
const LANE7 = [
  ...HEADER(
    7,
    `**Base · review · current head:** ${s7(BASE)} · ${H.slice(0, 12)} · ${TIP.slice(0, 12)}`,
  ),
  ...F('F-01', 'src/a.ts:40', 701),
  ...F('F-05', 'src/b.ts:20', 705),
].join('\n');
const REPORT99 = [...HEADER(99, `**reviewed head:** ${H}`), ...F('F-01', 'src/a.ts:40', 9901)].join(
  '\n',
);
const REPORT98 = [
  ...HEADER(98, '**reviewed head:** deadbeef1234'),
  ...F('F-01', 'src/a.ts:40', 9801),
].join('\n');
const f7 = join(reviews, 'mr-7.agent.md');
const f7lane = join(reviews, 'mr-7-lane-b.agent.md');
const f99 = join(reviews, 'mr-99.agent.md');
const f98 = join(reviews, 'mr-98.agent.md');
writeFileSync(f7, REPORT7);
writeFileSync(f7lane, LANE7);
writeFileSync(f99, REPORT99);
writeFileSync(f98, REPORT98);
const block = (t: string, id: string): string => {
  const s = t.indexOf(`## ${id} `);
  const e = t.indexOf('\n## ', s + 1);
  return t.slice(s, e < 0 ? undefined : e);
};

// ---------- fake glab: logs every call; serves MR 7 for the networked case ----------
const fake = join(repo, '.fake');
mkdirSync(fake, { recursive: true });
const HITS = join(fake, 'hits.log');
const ours = (id: number, line: number, body: string, replies: string[] = []) => ({
  id: `d${id}`,
  notes: [
    {
      id,
      body,
      system: false,
      resolvable: true,
      resolved: false,
      author: { username: 'me' },
      created_at: '2026-10-01T10:00:00Z',
      position: { new_path: 'src/a.ts', new_line: line },
    },
    ...replies.map((r, i) => ({
      id: id * 10 + i,
      body: r,
      system: false,
      resolvable: true,
      resolved: false,
      author: { username: 'author' },
      created_at: '2026-10-02T10:00:00Z',
    })),
  ],
});
const ROUTES = {
  mr: { iid: 7, state: 'opened', web_url: web(7), author: { username: 'author' }, sha: TIP },
  discussions: [ours(701, 40, 'F-01 🟡 thesis', ['Done']), ours(704, 15, 'F-04 🟡 thesis')],
};
writeFileSync(join(fake, 'routes.json'), JSON.stringify(ROUTES));
const GLAB = join(fake, 'glab.mjs');
writeFileSync(
  GLAB,
  [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    'const here = dirname(fileURLToPath(import.meta.url));',
    'const args = process.argv.slice(2);',
    "appendFileSync(join(here, 'hits.log'), args.join(' ') + '\\n');",
    "if (args[0] === 'auth') process.exit(0);",
    "const routes = JSON.parse(readFileSync(join(here, 'routes.json'), 'utf8'));",
    "const path = args.at(-1).split('?')[0];",
    'const body = /merge_requests\\/7$/.test(path) ? routes.mr',
    '  : /merge_requests\\/7\\/discussions$/.test(path) ? routes.discussions',
    '  : /merge_requests\\/7\\/commits$/.test(path) ? [] : null;',
    "if (body == null) { process.stdout.write('HTTP/1.1 404 Not Found\\r\\n\\r\\n{}'); process.exit(1); }",
    "process.stdout.write('HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n' + JSON.stringify(body));",
  ].join('\n'),
);
const run = (args: string[]): { code: number | null; out: string } => {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_GLAB_CMD: JSON.stringify([process.execPath, GLAB]),
      GITLAB_HOST: 'git.example',
    },
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const hits = (): string[] =>
  existsSync(HITS) ? readFileSync(HITS, 'utf8').split('\n').filter(Boolean) : [];
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4)
  .toISOString()
  .slice(0, 10);
const addressedLine = (sha: string): string =>
  `- **Synced:** ${today} — addressed by ${s7(sha)} (lines changed)`;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('review-sync набора: неявный вердикт по коммитам', () => {
  it('--offline, один отчёт: место проводится через сдвиги, переименование и слияние', () => {
    const r = run([f7, '--offline']);
    expect(r.code, r.out).toBe(0);
    // reviewed head, не current head; ветка — та, что названа в merge-коммите GitLab (не feat/y, не side)
    expect(r.out).toContain(`commits: feat/x: 7 commits after ${s7(H)}`);
    expect(r.out).toMatch(new RegExp(`F-01: addressed by ${s7(C3)} `));
    expect(r.out).toMatch(new RegExp(`F-02: addressed by ${s7(C1)} `));
    expect(r.out).toMatch(new RegExp(`F-03: addressed by ${s7(C5)} .*src/new\\.ts`));
    expect(r.out).toMatch(/F-04: no commit at the site → silent/);
    expect(r.out).toMatch(new RegExp(`F-05: addressed by ${s7(C6)} `));
    expect(r.out).toMatch(/F-06: no commit at the site → unknown/);
    expect(r.out).toMatch(new RegExp(`F-07: addressed by ${s7(C7)} `));
    expect(r.out).not.toMatch(/F-08/);
    expect(r.out).toContain(
      'calibration: published 7 · accepted 1 · addressed 3 · declined 1 · other 0 · silent 1 (14%) · reply unknown 1 · precision 57% = (accepted+addressed)/published',
    );
    expect(r.out).toMatch(/would write 5 line\(s\)/);
    expect(readFileSync(f7, 'utf8')).toBe(REPORT7);
  });

  it('--all --offline: копия полосы считается один раз, причины отсутствия данных названы', () => {
    const r = run(['--all', reviews, '--offline']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(
      /mr-7-lane-b\.agent\.md \(MR !7, offline\): findings 2 · published 2 · commits: feat\/x: 7 commits after/,
    );
    expect(r.out).toMatch(
      /mr-99\.agent\.md .*commits: n\/a — ambiguous refs hold the reviewed head: .*feat\/x/,
    );
    expect(r.out).toMatch(
      /mr-98\.agent\.md .*commits: n\/a — reviewed head deadbeef1234 is not in the local repo/,
    );
    expect(r.out).toContain(
      'CALIBRATION published 9 · accepted 1 · addressed 3 · declined 1 · other 0 · silent 1 (11%) · reply unknown 3 · precision 44% = (accepted+addressed)/published · commit data n/a in 2 of 4 reports',
    );
    expect(readFileSync(f7, 'utf8')).toBe(REPORT7);
    expect(readFileSync(f7lane, 'utf8')).toBe(LANE7);
  });

  it('--ref снимает неоднозначность для одного отчёта; полный путь сильнее совпадения хвоста', () => {
    const r = run([f99, '--offline', '--ref', 'feat/x']);
    expect(r.out).toMatch(
      new RegExp(`commits: feat/x: 7 commits after .*\\n[\\s\\S]*F-01: addressed by ${s7(C3)}`),
    );
    const fx = join(repo, '.agent', 'mr-96.agent.md');
    writeFileSync(
      fx,
      [
        ...HEADER(96, `**reviewed head:** ${H}`),
        ...F('F-01', 'src/svc1/internal/store/chats.ts:5', 9601),
      ].join('\n'),
    );
    const s = run([fx, '--offline', '--ref', 'side']);
    expect(s.out).toMatch(new RegExp(`F-01: addressed by ${s7(SIDE)} .*src/svc1/`));
  });

  it('--offline --write: строки на своих местах, Status не трогается, повтор ничего не меняет', () => {
    const r = run([f7, '--offline', '--write']);
    const t = readFileSync(f7, 'utf8');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/· written/);
    expect(block(t, 'F-01')).toContain(`#note_701\n${addressedLine(C3)}\n- **Status:** open`);
    expect(block(t, 'F-02')).toContain(`"Disagree, by design"\n${addressedLine(C1)}\n`);
    expect(block(t, 'F-04')).not.toMatch(/addressed by/);
    expect(block(t, 'F-06')).not.toMatch(/addressed by/);
    expect(block(t, 'F-07')).toContain(addressedLine(C7));
    expect(block(t, 'F-07')).toMatch(/\*\*Status:\*\* accepted/);
    expect((t.match(/\*\*Status:\*\* open/g) || []).length).toBe(7);
    expect(t).not.toMatch(/Status:\*\* (?:fixed|addressed)/);
    expect(block(t, 'F-08')).toBe(block(REPORT7, 'F-08'));
    expect(t.split('\n').length).toBe(REPORT7.split('\n').length + 5);
    // Дата первого обнаружения переживает повтор: строка с тем же sha не переписывается на сегодня.
    const dated = t.replace(addressedLine(C3), addressedLine(C3).replace(today, '2026-01-01'));
    writeFileSync(f7, dated);
    const again = run([f7, '--offline', '--write']);
    expect(again.out).toMatch(/· no change/);
    expect(readFileSync(f7, 'utf8')).toBe(dated);
    const re = run([f7, '--offline']);
    expect(re.out).toMatch(
      /F-01: addressed by \S+ \S+ \(src\/a\.ts:\d+-\d+\) — already recorded → addressed/,
    );
    expect(re.out).toMatch(/F-02: .* → declined/);
  });

  it('голый `head <sha>` — просмотренная голова, а `current head` перед ним — нет', () => {
    const fx = join(repo, '.agent', 'mr-7-bare.agent.md');
    writeFileSync(
      fx,
      [
        ...HEADER(7, `**Base:** ${BASE} · **current head:** ${TIP} · **head:** ${H}`),
        ...F('F-01', 'src/a.ts:40', 701),
      ].join('\n'),
    );
    const r = run([fx, '--offline']);
    expect(r.out).toContain(`commits: feat/x: 7 commits after ${s7(H)}`);
    expect(r.out).toMatch(new RegExp(`F-01: addressed by ${s7(C3)} `));
  });

  it('строка addressed НАД строкой треда не читается как ответ автора', () => {
    const fx = join(repo, '.agent', 'mr-7-order.agent.md');
    writeFileSync(
      fx,
      REPORT7.replace(
        '- **Synced:** 2026-10-01 — thread resolved @author; author did not reply',
        '- **Synced:** 2026-01-01 — addressed by deadbee (lines changed)\n- **Synced:** 2026-10-01 — thread resolved @author; author did not reply',
      ),
    );
    expect(run([fx, '--offline']).out).toMatch(/F-04: no commit at the site → silent/);
  });

  it('--json --offline несёт калибровку и источник коммитов; --offline не зовёт glab', () => {
    const r = run([f7, '--offline', '--json']);
    const j = JSON.parse(r.out) as {
      reports: { calibration?: { addressed: number }; commits?: string }[];
    };
    expect(j.reports[0]?.calibration?.addressed).toBe(3);
    expect(j.reports[0]?.commits ?? '').toMatch(/^feat\/x: 7 commits/);
    expect(hits()).toEqual([]);
  });

  it('с кузницей: вершина — head sha самого MR; порядок Thread → Synced треда → addressed', () => {
    const netDir = join(repo, '.agent', 'net');
    mkdirSync(netDir, { recursive: true });
    const fn = join(netDir, 'mr-7.agent.md');
    writeFileSync(fn, REPORT7);
    const r = run([fn, '--me', 'me', '--project', 'grp/proj', '--write']);
    const t = readFileSync(fn, 'utf8');
    expect(hits().length, r.out).toBeGreaterThan(0);
    expect(r.out).toContain(`commits: MR head ${s7(TIP)}: 7 commits after ${s7(H)}`);
    expect(r.out).toMatch(
      new RegExp(`F-01: .*author replied 1 \\(accepted\\) → accepted → addressed by ${s7(C3)}`),
    );
    expect(r.out).toContain(
      'calibration: published 2 · accepted 1 · addressed 0 · declined 0 · other 0 · silent 1 (50%) · precision 50% = (accepted+addressed)/published',
    );
    expect(block(t, 'F-01')).toMatch(
      new RegExp(
        `- \\*\\*Synced:\\*\\* ${today} — thread open[^\\n]*\\n${esc(addressedLine(C3))}\\n`,
      ),
    );
    expect(block(t, 'F-01')).toMatch(/\*\*Status:\*\* accepted/);
    expect(t).not.toMatch(/fixed/);
    const again = run([fn, '--me', 'me', '--project', 'grp/proj', '--write']);
    expect(again.out).toMatch(/· no change/);
    expect((readFileSync(fn, 'utf8').match(/addressed by/g) || []).length).toBe(1);

    // Сначала запись --offline (у F-01 только строка addressed от 2026-01-01), потом с кузницей:
    // строка треда встаёт прямо над ней, а не поверх.
    const fo = join(netDir, 'mr-7-after-offline.agent.md');
    writeFileSync(fo, readFileSync(f7, 'utf8'));
    run([fo, '--me', 'me', '--project', 'grp/proj', '--write']);
    const b1 = block(readFileSync(fo, 'utf8'), 'F-01');
    expect(b1).toMatch(
      new RegExp(
        `- \\*\\*Synced:\\*\\* ${today} — thread open[^\\n]*\\n- \\*\\*Synced:\\*\\* 2026-01-01 — addressed by ${s7(C3)} \\(lines changed\\)\\n`,
      ),
    );
    expect((b1.match(/addressed by/g) || []).length).toBe(1);
  });
});
