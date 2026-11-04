import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * lane-budget набора (PostToolUse, только субагент-полоса deep-review): одна строка у потолка контекста
 * из брифа, одна жёстче на потолке +25k, тишина при решении владельца в брифе; строка [lane-batch] после
 * трёх ходов по одному чтению, не чаще раза на 15 вызовов. Транскрипты разложены как у CLI:
 * `<tmp>/<сессия>.jsonl` (родитель) + `<tmp>/<сессия>/subagents/agent-<id>.{jsonl,meta.json}`.
 */

const KIT = process.env.AGENTDECK_KIT_UNDER_TEST || builtinKitDir();
const dir = mkdtempSync(join(tmpdir(), 'kit-lane-budget-'));
const STATE = join(dir, 'state');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Use = { name: string; input: object };
type Turn = { recs: object[]; ids: string[] };
let lane: {
  default: (input: object) => string | null;
  capOf: (brief: string, env: Record<string, string>) => number | null;
  hasOverride: (brief: string) => boolean;
  isRead: (use: Use) => boolean;
};

beforeAll(async () => {
  // Каталог состояния набора читается при загрузке kit-paths — до импорта модуля.
  process.env.AGENTDECK_KIT_STATE = STATE;
  lane = await import(pathToFileURL(join(KIT, 'hooks', 'lib', 'lane-budget.mjs')).href);
});

let n = 0;
const PARENT = `lbt-parent-${Math.random().toString(36).slice(2, 8)}`;
const parentPath = join(dir, `${PARENT}.jsonl`);
writeFileSync(parentPath, '');

const usage = (ctx: number) => ({
  input_tokens: 2,
  cache_creation_input_tokens: 1000,
  cache_read_input_tokens: ctx - 1002,
  output_tokens: 50,
});
/** Один ход: вызовы и их результаты; контекст — сумма входных токенов. */
const turn = (uses: Use[], ctx = 30_000): Turn => {
  const id = `msg_${++n}`;
  const tus = uses.map((u) => ({ type: 'tool_use', id: `tu${++n}`, name: u.name, input: u.input }));
  const recs = tus.map((tu) => ({
    type: 'assistant',
    message: { id, role: 'assistant', content: [tu], usage: usage(ctx) },
  }));
  const res = tus.map((tu) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: 'x' }] },
  }));
  return { recs: [...recs, ...res], ids: tus.map((t) => t.id) };
};
const bash = (command: string): Use => ({ name: 'Bash', input: { command } });
const read = (file: string): Use => ({ name: 'Read', input: { file_path: file } });
const probe = (ctx: number) => turn([bash('go test ./internal/...')], ctx);

/** Субагент на диске: meta (null — нет), бриф в своём файле, ходы. Отдаёт вход хука его последнего вызова. */
function agent(o: { desc?: string | null; brief?: string; first?: string; turnsList: Turn[] }) {
  const id = `a${(++n).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const sub = join(dir, PARENT, 'subagents');
  mkdirSync(sub, { recursive: true });
  let first = o.first;
  if (o.brief !== undefined) {
    mkdirSync(join(dir, 'plan', id), { recursive: true });
    const bp = join(dir, 'plan', id, 'lane-A-r1.prompt.md');
    writeFileSync(bp, o.brief);
    first ??= `Your full brief is ${bp} — Read it first, in one Read. [return-format] … [no-subagents] …`;
  }
  const recs: object[] = [{ type: 'user', message: { role: 'user', content: first ?? 'do it' } }];
  let last: string | undefined;
  for (const t of o.turnsList) {
    recs.push(...t.recs);
    last = t.ids.at(-1);
  }
  const own = join(sub, `agent-${id}.jsonl`);
  const write = () => writeFileSync(own, `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  write();
  const desc = o.desc === undefined ? 'deep-review r1 lane A' : o.desc;
  if (desc !== null) {
    writeFileSync(
      join(sub, `agent-${id}.meta.json`),
      JSON.stringify({ agentType: 'lane-high', description: desc }),
    );
  }
  const input: Record<string, unknown> = {
    tool_name: 'Bash',
    tool_input: { command: 'x' },
    session_id: PARENT,
    transcript_path: parentPath,
    agent_id: id,
    tool_use_id: last,
    cwd: dir,
  };
  const more = (...ts: Turn[]) => {
    for (const t of ts) {
      recs.push(...t.recs);
      input.tool_use_id = t.ids.at(-1);
    }
    write();
    return input;
  };
  return { input, more, own };
}

const BRIEF70 =
  "You are lane A.\nContext cap ≈70k tokens: this brief (≤ 10k) + the round's diff (≈19k) leave ≈32k. Past ≈70k, hand back at once.";
const OVERRIDE = `${BRIEF70}\nOwner decision for this review: NO rerun rounds — read ALL chunks anyway, in order.`;
const isCap = (s: string | null) => /\[lane-budget\] Context ≈\d+k has reached/.test(s ?? '');
const isFirm = (s: string | null) => /\[lane-budget\] Context ≈\d+k is ≈\d+k past/.test(s ?? '');
const isBatch = (s: string | null) => /\[lane-batch\]/.test(s ?? '');

describe('lane-budget: чистые части', () => {
  it('потолок — из брифа, переменная окружения сильнее, без строки — null', () => {
    expect(lane.capOf(BRIEF70, {})).toBe(70_000);
    expect(lane.capOf('nothing', {})).toBeNull();
    expect(lane.capOf(BRIEF70, { LANE_CONTEXT_CAP: '100k' })).toBe(100_000);
    expect(lane.capOf('', { LANE_CONTEXT_CAP: '85' })).toBe(85_000);
  });
  it('решение владельца узнаётся, обычный абзац потолка — нет', () => {
    expect(lane.hasOverride('NO rerun rounds')).toBe(true);
    expect(lane.hasOverride(BRIEF70)).toBe(false);
  });
  it('чтение: Read и git show | sed — да; go test и перенаправление в файл — нет', () => {
    expect(lane.isRead(read('a'))).toBe(true);
    expect(lane.isRead(bash('cd "C:/x" && git -C "C:/x" show HEAD:a.go | sed -n 1,80p'))).toBe(
      true,
    );
    expect(lane.isRead(bash('go test ./internal/...'))).toBe(false);
    expect(lane.isRead(bash('git show HEAD:a.go > out.txt'))).toBe(false);
  });
});

describe('lane-budget: потолок контекста полосы', () => {
  it('ниже — тишина; у потолка — одна строка; +25k — строка жёстче; дальше тишина', () => {
    const a = agent({ brief: BRIEF70, turnsList: [probe(30_000), probe(50_000)] });
    expect(lane.default(a.input)).toBeNull();
    const at = lane.default(a.more(probe(72_000)));
    expect(isCap(at)).toBe(true);
    expect(at).toMatch(/RERUN rounds/);
    expect(lane.default(a.more(probe(80_000)))).toBeNull();
    expect(isFirm(lane.default(a.more(probe(96_000))))).toBe(true);
    expect(lane.default(a.more(probe(130_000)))).toBeNull();
  });
  it('без строки потолка — 95k по умолчанию', () => {
    const a = agent({ brief: 'You are lane B.', turnsList: [probe(90_000)] });
    expect(lane.default(a.input)).toBeNull();
    expect(isCap(lane.default(a.more(probe(96_000))))).toBe(true);
  });
  it('решение владельца в брифе — тишина и на 150k', () => {
    const a = agent({ brief: OVERRIDE, turnsList: [probe(150_000)] });
    expect(lane.default(a.input)).toBeNull();
  });
  it('без meta, но с открывающей строкой заглушки планировщика — это полоса', () => {
    const a = agent({ desc: null, brief: BRIEF70, turnsList: [probe(72_000)] });
    expect(isCap(lane.default(a.input))).toBe(true);
  });
});

describe('lane-budget: вне полос молчит', () => {
  it('субагент «review:» и планировщик, называющий файлы брифов', () => {
    const r = agent({ desc: 'review: style pass', brief: BRIEF70, turnsList: [probe(150_000)] });
    expect(lane.default(r.input)).toBeNull();
    const p = agent({
      desc: 'deep-review plan prompt/pack/rounds',
      first: 'Write lane-A-r1.prompt.md and lane-B-r1.prompt.md for …',
      turnsList: [probe(150_000)],
    });
    expect(lane.default(p.input)).toBeNull();
  });
  it('главный поток', () => {
    const a = agent({ brief: BRIEF70, turnsList: [probe(150_000)] });
    const main: Record<string, unknown> = { ...a.input, transcript_path: parentPath };
    delete main.agent_id;
    expect(lane.default(main)).toBeNull();
  });
});

describe('lane-budget: серия одиночных чтений', () => {
  it('три подряд — строка; четвёртое — тихо; через 15 вызовов — снова', () => {
    const a = agent({
      brief: BRIEF70,
      turnsList: [
        turn([read('a')]),
        turn([bash('git -C /c/x show HEAD:b.go | sed -n 1,40p')]),
        turn([read('c')]),
      ],
    });
    expect(isBatch(lane.default(a.input))).toBe(true);
    expect(lane.default(a.more(turn([read('d')])))).toBeNull();
    let last: string | null = null;
    for (let i = 0; i < 13; i += 1) last = lane.default(a.more(turn([read(`e${i}`)])));
    expect(last).toBeNull();
    expect(isBatch(lane.default(a.more(turn([read('f')]))))).toBe(true);
  });
  it('ход с параллельными чтениями в окне — тихо', () => {
    const a = agent({
      brief: BRIEF70,
      turnsList: [turn([read('a')]), turn([read('b'), read('c')]), turn([read('d')])],
    });
    expect(lane.default(a.input)).toBeNull();
  });
});

describe('lane-budget: через диспетчер набора, как его зовёт hooks.json', () => {
  it('post-any отдаёт строку потолка в additionalContext', () => {
    const a = agent({ brief: BRIEF70, turnsList: [probe(72_000)] });
    const out = spawnSync(process.execPath, [join(KIT, 'hooks', 'lib', 'run.mjs'), 'post-any'], {
      input: JSON.stringify(a.input),
      encoding: 'utf8',
      env: { ...process.env, AGENTDECK_KIT_STATE: join(dir, 'state-dispatch') },
      timeout: 15_000,
    }).stdout.trim();
    const ctx = out
      ? ((JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } })
          .hookSpecificOutput?.additionalContext ?? '')
      : '';
    expect(isCap(ctx)).toBe(true);
  });
});
