import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Карточки правил сразу после сжатия. Звено g9 (26.10): после каждого сжатия первая
 * пачка параллельных Edit отказывалась целиком (8 отказов в 21:32Z, 6 в 21:19Z) —
 * карточка приходила только с первым отказанным Edit, и все соседи по пачке получали
 * тот же отказ. Теперь на SessionStart:compact звено разделения получает правила с запретом,
 * которые были нужны его вызовам в закончившемся поколении: окно, которое потребовал бы
 * запрет, приходит текстом (g9 review F3) и считается чтением; окно, что не влезло, — карточкой
 * со взведённым запретом. Через диспетчер `run.mjs`, как его зовёт hooks.json.
 */

const KIT = builtinKitDir();
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-compact-cards-'));
const STATE = join(dir, 'state');
// Копия вне временного каталога: правка во временном — черновик, правило о UI её не касается.
const copy = mkdtempSync(join(process.cwd(), 'node_modules', '.kit-compact-cards-'));
mkdirSync(join(copy, '.git'), { recursive: true });
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(copy, { recursive: true, force: true });
});

const BASE = {
  ...process.env,
  AGENTDECK_KIT_VARIANT: '',
  AGENTDECK_HEAVY_QUEUE_DIR: '',
  AGENTDECK_KIT_STATE: STATE,
  AGENTDECK_USER_MEMORY_OFF: '',
};
const envOf = (child: boolean) => ({ ...BASE, AGENTDECK_SPLIT_CHILD: child ? '1' : '' });

type HookOut = {
  hookSpecificOutput?: {
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};
function hook(event: string, payload: object, child = true): HookOut {
  const out = spawnSync(process.execPath, [DISPATCH, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: envOf(child),
    timeout: 15_000,
  }).stdout.trim();
  return out && event !== 'precompact' ? (JSON.parse(out) as HookOut) : {};
}
const ctx = (o: HookOut) => o.hookSpecificOutput?.additionalContext ?? '';
const reason = (o: HookOut) => o.hookSpecificOutput?.permissionDecisionReason ?? '';
const denied = (o: HookOut) => o.hookSpecificOutput?.permissionDecision === 'deny';

let n = 0;
function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}
const use = (name: string, input: object) => ({
  type: 'assistant',
  cwd: copy,
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: `tu${++n}`, name, input }],
  },
});
const BOUNDARY = { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' };

const RULE_FILE = join(KIT, 'skills', 'situational-rules', 'references', 'visible-fix-shots.md');
const UI = join(copy, 'inst-admin-ui/src/pages/users/CreateRolePage/index.tsx');
const uiEdit = { file_path: UI, old_string: 'a', new_string: 'b' };
const testEdit = { file_path: join(copy, 'src/x.test.ts'), old_string: 'a', new_string: 'b' };
const DOCKER = 'docker run --rm alpine';
const pre = (session: string, tool: string, input: object, tp: string, child = true) =>
  hook(
    'pre',
    {
      hook_event_name: 'PreToolUse',
      session_id: session,
      transcript_path: tp,
      cwd: copy,
      tool_name: tool,
      tool_input: input,
    },
    child,
  );
const sent = (session: string, rule: string) =>
  existsSync(join(STATE, 'rules', `rule-${rule}-${session}.sent`));
const gateRules = (session: string): string[] => {
  try {
    return Object.keys(
      JSON.parse(readFileSync(join(STATE, 'rules', `rule-cards-${session}.json`), 'utf8')),
    ).sort();
  } catch {
    return [];
  }
};

/**
 * Поколение 0: docker (docker-shared). Поколение 1: правка UI и правка теста
 * (verification-depth — правило метода, без запрета). Затем настоящий PreCompact и
 * SessionStart:compact.
 */
function session(
  s: string,
  { child = true, precompact = true, boundaryWritten = false, marks = [] as string[] } = {},
) {
  const gen0 = [use('Bash', { command: DOCKER })];
  const gen1 = [use('Edit', uiEdit), use('Edit', testEdit)];
  const live = transcript([...gen0, BOUNDARY, ...gen1]);
  pre(s, 'Bash', { command: DOCKER }, live, child);
  const first = pre(s, 'Edit', uiEdit, live, child);
  pre(s, 'Edit', testEdit, live, child);
  if (precompact)
    hook(
      'precompact',
      { hook_event_name: 'PreCompact', session_id: s, transcript_path: live },
      child,
    );
  // Отметки «правило уже доходило» на диске и у человека (копия, где работала группа).
  for (const rule of marks) writeFileSync(join(STATE, 'rules', `rule-${rule}-${s}.sent`), '1');
  const tp = boundaryWritten ? transcript([...gen0, BOUNDARY, ...gen1, BOUNDARY]) : live;
  const start = ctx(
    hook(
      'session',
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: s,
        transcript_path: tp,
        cwd: copy,
      },
      child,
    ),
  );
  return { first, start, after: [...gen0, BOUNDARY, ...gen1, BOUNDARY] };
}

describe('rule-injector: карточки правил сразу после сжатия у звена разделения', () => {
  // С g9 review F3 (26.10) окно, которое потребовал бы запрет, приходит ТЕКСТОМ: это и есть чтение —
  // запрет не взводится, первая правка после сжатия проходит (карточка остаётся окну, что не влезло).
  it('g9: SessionStart:compact приносит текст окна нужного правила, запрет не взводится', () => {
    const g = session('kcompact-a');
    expect(ctx(g.first)).toContain('Before/after');
    expect(g.start).toContain('rule text after compaction');
    expect(g.start).toContain('# Before/after shots');
    expect(g.start).not.toContain('rule-cards after compaction');
    expect(g.start.length).toBeLessThan(6000);
    expect(gateRules('kcompact-a')).toEqual([]);
    // Не нужное в закончившемся поколении и правило метода не приходят.
    expect(sent('kcompact-a', 'docker-shared')).toBe(true);
    expect(sent('kcompact-a', 'verification-depth')).toBe(true);
    expect(g.start).not.toMatch(/^- (docker-shared|verification-depth)/m);
  });

  it('правка после сжатия проходит без Read и без повторной карточки', () => {
    const g = session('kcompact-b');
    const edit = pre('kcompact-b', 'Edit', uiEdit, transcript(g.after));
    expect(denied(edit), reason(edit)).toBe(false);
    expect(ctx(edit)).not.toMatch(/— card \(split group/);
    expect(readFileSync(RULE_FILE, 'utf8')).toContain('# Before/after shots');
  });

  it('журнал доставок: карточка после сжатия — не повтор; без PreCompact — ничего', async () => {
    session('kcompact-d');
    const log = join(STATE, 'rules', 'rule-deliveries.jsonl');
    const own = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { s: string; rule: string })
      .filter((e) => e.s === 'kcompact-d')
      .map((e) => e.rule);
    expect(own.filter((r) => r === 'visible-fix-shots')).toHaveLength(2);
    expect(own.indexOf('#compact')).toBeLessThan(own.lastIndexOf('visible-fix-shots'));
    const prev = process.env.AGENTDECK_KIT_STATE;
    process.env.AGENTDECK_KIT_STATE = STATE;
    try {
      const lib = (await import(
        pathToFileURL(join(KIT, 'hooks', 'lib', 'rule-injector.mjs')).href
      )) as { ruleRepeats: (now?: number, file?: string) => string | null };
      expect(lib.ruleRepeats(Date.now(), log) ?? '').not.toMatch(/visible-fix-shots/);
    } finally {
      if (prev === undefined) delete process.env.AGENTDECK_KIT_STATE;
      else process.env.AGENTDECK_KIT_STATE = prev;
    }
    // Отметки не сняты (сжатия не было) — внутри поколения ничего не шлётся повторно.
    expect(session('kcompact-e', { precompact: false }).start).not.toContain(
      'rule-cards after compaction',
    );
  });

  it('новая граница уже записана — то же правило; сессия человека — ничего', () => {
    const b = session('kcompact-f', { boundaryWritten: true });
    expect(b.start).toContain('rule text after compaction');
    expect(b.start).toContain('# Before/after shots');
    // Отметки на диске есть — человека не пускает одна проверка звена разделения.
    const h = session('kcompact-g', { child: false, marks: ['visible-fix-shots'] });
    expect(h.start).not.toContain('rule-cards after compaction');
    expect(h.start).not.toContain('rule text after compaction');
    expect(gateRules('kcompact-g')).toEqual([]);
  });
});

/**
 * Окно чтения не больше предела Read. Звено g9 (26.10 03:04): отказ назвал offset=1 limit=103 у правила
 * 27 162 байта = 10 961 токен, Read отказал («exceeds maximum allowed tokens»), ход пропал, а повтор
 * с allow_large положил 27k в окно. Теперь каждое окно карточки и отказа помещается в один Read, а
 * отказанный Read ничего не снимает.
 */
describe('rule-injector: окно чтения в карточке и отказе не больше предела Read', () => {
  const big = (k: number) =>
    Array.from({ length: k }, (_, i) => `- line ${i} ${'x'.repeat(150)}`).join('\n');
  const bytesOf = (lines: string[], a: number, b: number) =>
    lines.slice(a - 1, b).reduce((t, l) => t + Buffer.byteLength(l, 'utf8') + 1, 0);
  const partsOf = (text: string) =>
    [...text.matchAll(/offset=(\d+) limit=(\d+)/g)].map((m) => [
      Number(m[1]),
      Number(m[1]) + Number(m[2]) - 1,
    ]);
  const flat = join(dir, 'flat-rule.md');
  writeFileSync(flat, `# Flat rule\n${big(200)}\n`);
  const flatLines = readFileSync(flat, 'utf8').split('\n');
  const n = readFileSync(flat, 'utf8').replace(/\s+$/, '').split('\n').length;
  const readOf = (id: string, input: object) => ({
    type: 'assistant',
    cwd: copy,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: flat, ...input } }],
    },
  });
  const resultOf = (id: string, isError: boolean) => ({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }],
    },
  });
  // Звено с картой docker-shared, указывающей на правило больше предела; правило уже доставлено
  // в этом поколении (штамп), так что отказ называет окно, а не прикладывает текст.
  const armed = (s: string) => {
    mkdirSync(join(STATE, 'rules'), { recursive: true });
    writeFileSync(join(STATE, 'rules', `rule-docker-shared-${s}.stamp`), '1');
    writeFileSync(join(STATE, 'rules', `rule-docker-shared-${s}.sent`), '1');
    writeFileSync(
      join(STATE, 'rules', `rule-cards-${s}.json`),
      JSON.stringify({ 'docker-shared': { file: flat, head: '# Flat rule — card' } }),
    );
  };
  const docker = (s: string, records: object[]) =>
    pre(s, 'Bash', { command: DOCKER }, transcript(records));
  const named = (o: HookOut) =>
    /flat-rule\.md first — one whole window of: ([^\n(]*)/.exec(reason(o))?.[1] ?? '';

  it('отказ называет окно целого файла частями, каждая влезает в Read; чтение всех частей снимает запрет', () => {
    expect(bytesOf(flatLines, 1, n)).toBeGreaterThan(16_000);
    armed('kreadcap-a');
    const deny = docker('kreadcap-a', []);
    expect(denied(deny)).toBe(true);
    const line = named(deny);
    const parts = partsOf(line);
    expect(parts.length, line).toBeGreaterThanOrEqual(2);
    expect(line.split(' + ')).toHaveLength(parts.length);
    expect(reason(deny)).toContain('Read every part');
    expect(parts[0]![0]).toBe(1);
    expect(parts.at(-1)![1]).toBe(n);
    parts.forEach((p, i) => {
      if (i) expect(p[0]).toBe(parts[i - 1]![1]! + 1);
      expect(bytesOf(flatLines, p[0]!, p[1]!)).toBeLessThanOrEqual(16_000);
    });

    armed('kreadcap-b');
    const reads = parts.flatMap(([a, b], i) => [
      readOf(`kp${i}`, { offset: a, limit: b! - a! + 1 }),
      resultOf(`kp${i}`, false),
    ]);
    expect(denied(docker('kreadcap-b', reads))).toBe(false);
    armed('kreadcap-c');
    expect(denied(docker('kreadcap-c', reads.slice(0, 2)))).toBe(true);
  });

  it('Read, отказанный по пределу, ничего не снимает; тот же Read с allow_large — снимает', () => {
    armed('kreadcap-d');
    expect(
      denied(docker('kreadcap-d', [readOf('kw', { offset: 1, limit: n }), resultOf('kw', true)])),
    ).toBe(true);
    armed('kreadcap-e');
    expect(
      denied(
        docker('kreadcap-e', [
          readOf('kl', { offset: 1, limit: n, allow_large: true }),
          resultOf('kl', false),
        ]),
      ),
    ).toBe(false);
  });

  it('карточка: раздел больше предела — частями; файл без разделов — частями; малый — как был', async () => {
    const lib = (await import(
      pathToFileURL(join(KIT, 'hooks', 'lib', 'rule-injector.mjs')).href
    )) as {
      cardOf: (body: string, file: string, name?: string) => string;
    };
    const sec = join(dir, 'big-section.md');
    writeFileSync(sec, `# Big\nlead\n## Small\na\n## Huge\n${big(200)}\n`);
    const secLines = readFileSync(sec, 'utf8').split('\n');
    const card = lib.cardOf(readFileSync(sec, 'utf8'), sec, 'big');
    const huge = /Huge (offset=\d+ limit=\d+(?: \+ offset=\d+ limit=\d+)+)/.exec(card)?.[1] ?? '';
    const hp = partsOf(huge);
    expect(hp.length, card).toBeGreaterThanOrEqual(2);
    expect(hp[0]![0]).toBe(5);
    hp.forEach(([a, b]) => expect(bytesOf(secLines, a!, b!)).toBeLessThanOrEqual(16_000));
    expect(card).toMatch(/Small offset=3 limit=2 ·/);
    expect(lib.cardOf(readFileSync(flat, 'utf8'), flat, 'flat')).toMatch(
      /before acting — the whole file, in parts: offset=1 limit=\d+ \+ offset=/,
    );
    const small = join(dir, 'small-rule.md');
    writeFileSync(small, '# Small\nlead line\n');
    expect(lib.cardOf('# Small\nlead line\n', small, 'small')).toMatch(
      /Read \S+small-rule\.md before acting\n/,
    );
  });
});

/**
 * Скрипт node вне src/ — только раздел о коде. Звено g8 (26.10 02:42): две правки
 * `inst-docs-ui/scripts/check_content.mjs` отказаны, и модель прочла «Code standards», «UI imports»
 * и «State (Zustand)» — 8,8 тыс. знаков, где снимает запрет один: строка `.js` в таблице видов
 * (import|state|types) называет разделы только о React. Отказ с несколькими окнами говорит, что
 * хватит ОДНОГО, и первое — лучшее.
 */
describe('rule-injector: правка скрипта node вне src/ требует один раздел о коде', () => {
  const rule = join(dir, 'sectioned-rule.md');
  writeFileSync(
    rule,
    // Тела по 3 000 знаков: правило больше места в отказе, иначе отказ прикладывает его целиком.
    `# Frontend\nlead\n## Code standards\n${'a'.repeat(3000)}\n## UI imports\n${'b'.repeat(3000)}\n` +
      `## State (Zustand)\n${'c'.repeat(3000)}\n## Styling & theme\nbuild regenerates x.cjs\n`,
  );
  const CODE = [3, 4];
  const editOf = (file_path: string) => ({ tool_name: 'Edit', tool_input: { file_path } });
  const libOf = async () =>
    (await import(pathToFileURL(join(KIT, 'hooks', 'lib', 'rule-injector.mjs')).href)) as {
      needOf: (file: string, input: object) => number[][] | null;
    };

  it('scripts/**, tools/**, .mjs/.cjs вне src/ → только «Code standards»; модуль в src/ — как был', async () => {
    const { needOf } = await libOf();
    for (const p of [
      'inst-docs-ui/scripts/check_content.mjs',
      'd:/w/repo/tools/sync.ts',
      'cp-admin-ui/vite-plugin.cjs',
      'C:\\w\\inst-docs-ui\\scripts\\x.js',
    ])
      expect(needOf(rule, editOf(p)), p).toEqual([CODE]);
    expect(needOf(rule, editOf('cp-admin-ui/src/api/client.mjs'))).toEqual([CODE, [5, 6], [7, 8]]);
    // Лучшее первым: заголовок вида выше тела, которое только называет расширение.
    const ranked = join(dir, 'ranked-rule.md');
    writeFileSync(ranked, '# R\nlead\n## Misc\nevery .tsx page\n## Components\nb\n');
    expect(needOf(ranked, editOf('src/App.tsx'))).toEqual([
      [5, 6],
      [3, 4],
    ]);
  });

  // Запрет hook-authoring указывает на правило с разделами; правило уже доставлено (штамп).
  const armed = (s: string) => {
    mkdirSync(join(STATE, 'rules'), { recursive: true });
    writeFileSync(join(STATE, 'rules', `rule-hook-authoring-${s}.stamp`), '1');
    writeFileSync(join(STATE, 'rules', `rule-hook-authoring-${s}.sent`), '1');
    writeFileSync(
      join(STATE, 'rules', `rule-cards-${s}.json`),
      JSON.stringify({ 'hook-authoring': { file: rule, head: '# Frontend — card' } }),
    );
  };
  const windowsIn = (o: HookOut) =>
    /sectioned-rule\.md first — one whole window of: ([^\n]*)/.exec(reason(o))?.[1] ?? '';

  it('отказ: несколько окон — «любое ОДНО снимает запрет, первое — лучшее»; скрипт — одно окно', () => {
    // docker run: правка файла нет → подходит любой раздел, отказ называет четыре окна.
    mkdirSync(join(STATE, 'rules'), { recursive: true });
    writeFileSync(join(STATE, 'rules', 'rule-docker-shared-knode-a.stamp'), '1');
    writeFileSync(join(STATE, 'rules', 'rule-docker-shared-knode-a.sent'), '1');
    writeFileSync(
      join(STATE, 'rules', 'rule-cards-knode-a.json'),
      JSON.stringify({ 'docker-shared': { file: rule, head: '# Frontend — card' } }),
    );
    const many = windowsIn(pre('knode-a', 'Bash', { command: DOCKER }, transcript([])));
    expect(many.split(' · '), many).toHaveLength(4);
    expect(many).toMatch(
      /any ONE of these lifts the gate \(the first is the best match\): read only that one/,
    );
    armed('knode-b');
    const hookTs = join(copy, '.claude', 'hooks', 'x.mjs');
    const script = pre(
      'knode-b',
      'Edit',
      { file_path: hookTs, old_string: 'a', new_string: 'b' },
      transcript([]),
    );
    expect(denied(script), reason(script)).toBe(true);
    expect(windowsIn(script), reason(script)).toMatch(/^offset=3 limit=2 \(a fragment/);
    expect(windowsIn(script)).not.toMatch(/any ONE/);
    armed('knode-c');
    const bash = pre(
      'knode-c',
      'Bash',
      { command: `cat > ${hookTs.split('\\').join('/')} <<'EOF'\nx\nEOF` },
      transcript([]),
    );
    const w = windowsIn(bash);
    expect(denied(bash), reason(bash)).toBe(true);
    expect(w).toMatch(/^offset=3 limit=2 \(a fragment/);
  });
});
