import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Экономия окна звена группы — через диспетчер `run.mjs`, как его зовёт hooks.json:
 * подталкивание к пакетному чтению до вызова (Read/Grep/Glob в счёт, отказ после
 * проигнорированных строк), потолок чтения целых файлов и полного `git diff` оболочкой,
 * карточка правила ≥ 4k в следующих этапах той же копии. Сессия человека — как была.
 */

const KIT = builtinKitDir();
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-context-economy-'));
const STATE = join(dir, 'state');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CHILD = { AGENTDECK_SPLIT_CHILD: '1', AGENTDECK_USER_MEMORY_OFF: '1' };
const HUMAN = { AGENTDECK_SPLIT_CHILD: '', AGENTDECK_USER_MEMORY_OFF: '' };

type HookOut = {
  hookSpecificOutput?: {
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};

function hook(event: string, payload: object, env: Record<string, string>): HookOut {
  const out = spawnSync(process.execPath, [DISPATCH, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_KIT_STATE: STATE,
      ...env,
    },
    timeout: 15_000,
  }).stdout.trim();
  return out ? (JSON.parse(out) as HookOut) : {};
}

let n = 0;
type Use = { type: 'tool_use'; id: string; name: string; input: object };
const use = (name: string, input: object): Use => ({
  type: 'tool_use',
  id: `tu${++n}`,
  name,
  input,
});
const turn = (uses: Use[], bodies: string[] = []) => {
  const id = `msg${++n}`;
  return [
    ...uses.map((u) => ({ type: 'assistant', message: { id, role: 'assistant', content: [u] } })),
    {
      type: 'user',
      message: {
        role: 'user',
        content: uses.map((u, i) => ({
          type: 'tool_result',
          tool_use_id: u.id,
          content: bodies[i] ?? 'ok',
        })),
      },
    },
  ];
};
const loneReads = (k: number, prefix: string) =>
  Array.from({ length: k }, (_, i) =>
    turn([use('Read', { file_path: `C:/repo/src/${prefix}${i}.ts` })], [`body of ${prefix}${i}`]),
  ).flat();
function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}
const read = (session: string, tp: string, file = 'C:/repo/src/other.ts') => ({
  hook_event_name: 'PreToolUse',
  session_id: session,
  transcript_path: tp,
  cwd: dir,
  tool_name: 'Read',
  tool_input: { file_path: file },
});
const ctx = (o: HookOut) => o.hookSpecificOutput?.additionalContext ?? '';
const denied = (o: HookOut) => o.hookSpecificOutput?.permissionDecision === 'deny';

describe('batch-nudge: серия одиночных чтений в звене группы — до вызова', () => {
  const r3 = loneReads(3, 'a');
  const r9 = [...r3, ...loneReads(6, 'b')];
  const r10 = [...r9, ...loneReads(1, 'c')];

  it('три одиночных Read подряд — строка [batch]; сразу следом — тишина; у человека pre молчит', () => {
    const tp = transcript(r3);
    expect(ctx(hook('pre', read('kbatch000001', tp), CHILD))).toMatch(/\[batch\]/);
    expect(ctx(hook('pre', read('kbatch000001', tp), CHILD))).not.toMatch(/\[batch\]/);
    expect(ctx(hook('pre', read('kbatchhuman1', tp), HUMAN))).not.toMatch(/\[batch\]/);
  });

  it('после двух проигнорированных строк независимое одиночное чтение — отказ, один раз', () => {
    const s = 'kbatchesc001';
    expect(ctx(hook('pre', read(s, transcript(r3)), CHILD))).toMatch(/\[batch\]/);
    expect(ctx(hook('pre', read(s, transcript(r9)), CHILD))).toMatch(/\[batch\]/);
    const tp = transcript(r10);
    const refusal = hook('pre', read(s, tp, 'C:/repo/src/independent.ts'), CHILD);
    expect(denied(refusal)).toBe(true);
    expect(refusal.hookSpecificOutput?.permissionDecisionReason).toMatch(/batch-nudge/);
    expect(denied(hook('pre', read(s, tp, 'C:/repo/src/independent.ts'), CHILD))).toBe(false);
  });

  it('чтение файла, названного предыдущим результатом, не отказывается', () => {
    const s = 'kbatchdep001';
    hook('pre', read(s, transcript(r3)), CHILD);
    hook('pre', read(s, transcript(r9)), CHILD);
    const dep = [...r9, ...turn([use('Grep', { pattern: 'x' })], ['C:/repo/src/found.ts:12: x'])];
    expect(denied(hook('pre', read(s, transcript(dep), 'C:/repo/src/found.ts'), CHILD))).toBe(
      false,
    );
  });

  it('строка [batch] и правило по тому же вызову приходят вместе', () => {
    const out = ctx(
      hook('pre', read('kbatchrule01', transcript(r3), 'C:/repo/src/App.tsx'), CHILD),
    );
    expect(out).toMatch(/\[batch\]/);
    expect(out).toMatch(/^# /m);
  });

  it('post-any: в звене серию Bash-чтений ведёт pre (тишина), у человека строка как была', () => {
    const bash = Array.from({ length: 3 }, (_, i) =>
      turn([use('Bash', { command: `cat f${i}.txt` })]),
    ).flat();
    const payload = (s: string) => ({
      hook_event_name: 'PostToolUse',
      session_id: s,
      transcript_path: transcript(bash),
      cwd: dir,
      tool_name: 'Bash',
      tool_input: { command: 'cat f2.txt' },
      tool_response: { stdout: 'x' },
    });
    expect(ctx(hook('post-any', payload('kpostchild01'), CHILD))).not.toMatch(/\[batch\]/);
    expect(ctx(hook('post-any', payload('kposthuman01'), HUMAN))).toMatch(/\[batch\]/);
  });
});

describe('bash-read-cap: целые файлы и полный diff оболочкой в звене группы', () => {
  const cap = join(dir, 'cap');
  mkdirSync(cap, { recursive: true });
  const body = Array.from(
    { length: 250 },
    (_, i) => `export const v${i} = '${'x'.repeat(60)}';\n`,
  ).join('');
  writeFileSync(join(cap, 'a.ts'), body);
  writeFileSync(join(cap, 'b.ts'), body);
  const empty = transcript([]);
  const bash = (command: string, env: Record<string, string>, cwd = cap) =>
    hook(
      'pre',
      {
        hook_event_name: 'PreToolUse',
        session_id: `kcap${++n}`.padEnd(12, '0'),
        transcript_path: empty,
        cwd,
        tool_name: 'Bash',
        tool_input: { command },
      },
      env,
    );
  const capped = (o: HookOut) =>
    denied(o) && /bash-read-cap/.test(o.hookSpecificOutput?.permissionDecisionReason ?? '');

  it('`cat a b` и цикл `for … cat` выше потолка — отказ; у человека — нет', () => {
    expect(capped(bash('cat a.ts b.ts', CHILD))).toBe(true);
    expect(capped(bash('for f in a.ts b.ts; do cat "$f"; done', CHILD))).toBe(true);
    expect(capped(bash('cat a.ts b.ts', HUMAN))).toBe(false);
  });

  it('диапазоны, конвейер и вывод в файл проходят', () => {
    expect(capped(bash("sed -n '1,40p' a.ts", CHILD))).toBe(false);
    expect(capped(bash('cat a.ts b.ts | grep v1', CHILD))).toBe(false);
    expect(capped(bash('cat a.ts b.ts > both.txt', CHILD))).toBe(false);
  });

  it('прогон проверки по тем же большим файлам (vitest, tsc, eslint) не режется', () => {
    for (const run of [
      'npx vitest run a.ts b.ts',
      'pnpm exec vitest run a.ts b.ts 2>&1 | tail -400',
      'npx tsc --noEmit a.ts b.ts',
      'npx eslint a.ts b.ts',
      'node --test a.ts b.ts; echo done',
    ])
      expect(capped(bash(run, CHILD)), run).toBe(false);
  });

  it('полный `git diff` на 1800 строк — отказ; `--stat` и один путь проходят', () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) =>
      execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'big.ts'), Array.from({ length: 900 }, (_, i) => `a${i}\n`).join(''));
    writeFileSync(join(repo, 'one.ts'), 'x\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    writeFileSync(join(repo, 'big.ts'), Array.from({ length: 900 }, (_, i) => `b${i}\n`).join(''));
    writeFileSync(join(repo, 'one.ts'), 'y\n');
    expect(capped(bash('git diff', CHILD, repo))).toBe(true);
    expect(capped(bash('git diff --stat', CHILD, repo))).toBe(false);
    expect(capped(bash('git diff -- one.ts', CHILD, repo))).toBe(false);
  });
});

describe('rule-injector: правило ≥ 4k в следующем этапе той же копии — карточка', () => {
  const copy = join(dir, 'copyA');
  const other = join(dir, 'copyB');
  for (const r of [copy, other]) mkdirSync(join(r, '.git'), { recursive: true });
  const ask = (session: string, command: string, cwd: string, env: Record<string, string>) =>
    ctx(
      hook(
        'pre',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          session_id: session,
          transcript_path: '',
          cwd,
        },
        env,
      ),
    );

  it('этап 1 — целиком, этап 2 той же копии — карточка с окнами разделов, другая копия — целиком', () => {
    const first = ask('kcopystage01', 'pytest tests/ -q', copy, CHILD);
    expect(first).toMatch(/# Verification depth/);
    expect(first.length).toBeGreaterThan(1000);
    const later = ask('kcopystage02', 'pytest tests/ -q', copy, CHILD);
    expect(later).toMatch(/earlier stage of this copy/);
    expect(later.length).toBeLessThanOrEqual(1000);
    expect(later).toMatch(/offset=\d+ limit=\d+/);
    expect(ask('kcopyother01', 'pytest tests/ -q', other, CHILD)).not.toMatch(/card \(split group/);
  });

  it('правило короче 4k — целиком в каждом этапе; сессия человека — целиком', () => {
    const a = ask('kcopysmall01', 'docker run --rm hello-world', copy, CHILD);
    const b = ask('kcopysmall02', 'docker run --rm hello-world', copy, CHILD);
    expect(a.length).toBeGreaterThan(1000);
    expect(b).toBe(a);
    expect(ask('kcopyhuman01', 'pytest tests/ -q', copy, HUMAN)).not.toMatch(/card \(split group/);
  });
});

/**
 * Карточка экономит токены, только если звено НЕ прочтёт правило, а не прочесть его —
 * и есть потеря качества (владелец, 25.10). Поэтому вызов, ради которого пришла
 * карточка, отказывается, пока сессия не прочла файл правила (любое окно; после
 * сжатия — прочтение после него). Повтор того же вызова без чтения не проходит.
 */
describe('rule-injector: карточка не пропускает свой вызов до чтения правила', () => {
  const copy = join(dir, 'copyGate');
  mkdirSync(join(copy, '.git'), { recursive: true });
  const call = (session: string, tp: string, extra: object = {}, cwd = copy) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'pytest tests/ -q' },
    session_id: session,
    transcript_path: tp,
    cwd,
    ...extra,
  });
  const reason = (o: HookOut) => o.hookSpecificOutput?.permissionDecisionReason ?? '';
  const GATE =
    /^rule-card: .*Read (\S+verification-depth\.md) \(the section covering your work, offset\/limit\) first/s;
  const gated = (o: HookOut) => denied(o) && GATE.test(reason(o));
  const empty = transcript(turn([use('Bash', { command: 'ls' })]));
  const readOf = (file: string, before: object[] = [], after: object[] = []) =>
    transcript([
      ...before,
      ...turn([use('Read', { file_path: file, offset: 1, limit: 40 })]),
      ...after,
    ]);

  it('карточка → отказ вызова; повтор без чтения — снова отказ; Read правила — проходит', () => {
    expect(gated(hook('pre', call('kgatestage01', empty), CHILD))).toBe(false);
    const first = hook('pre', call('kgatestage02', empty), CHILD);
    expect(gated(first)).toBe(true);
    expect(ctx(first)).toMatch(/earlier stage of this copy/);
    const rule = GATE.exec(reason(first))![1]!;
    expect(existsSync(rule)).toBe(true);
    expect(gated(hook('pre', call('kgatestage02', empty), CHILD))).toBe(true);
    // Чтение, которое само триггер (тест-файл), не отказывается; правка того же файла — да.
    const testFile = join(copy, 'src', 'a.test.ts');
    expect(
      denied(
        hook(
          'pre',
          call('kgatestage02', empty, { tool_name: 'Read', tool_input: { file_path: testFile } }),
          CHILD,
        ),
      ),
    ).toBe(false);
    expect(
      gated(
        hook(
          'pre',
          call('kgatestage02', empty, {
            tool_name: 'Edit',
            tool_input: { file_path: testFile, old_string: 'a', new_string: 'b' },
          }),
          CHILD,
        ),
      ),
    ).toBe(true);
    expect(gated(hook('pre', call('kgatestage02', readOf(rule)), CHILD))).toBe(false);
    expect(gated(hook('pre', call('kgatestage02', empty), CHILD))).toBe(false);
  });

  it('сессия человека в той же копии — без карточки и без отказа', () => {
    const human = hook('pre', call('kgatehuman01', empty), HUMAN);
    expect(denied(human)).toBe(false);
    expect(ctx(human)).not.toMatch(/card \(split group/);
  });

  it('карточка после сжатия: чтение до границы не в счёт, после — снимает отказ', () => {
    const other = join(dir, 'copyGate2');
    mkdirSync(join(other, '.git'), { recursive: true });
    const s = 'kgatecompact';
    hook('pre', call(s, empty, {}, other), CHILD);
    // PreCompact пишет текст, не JSON: вывод не нужен, нужен сброс отметок.
    spawnSync(process.execPath, [DISPATCH, 'precompact'], {
      input: JSON.stringify({
        hook_event_name: 'PreCompact',
        session_id: s,
        transcript_path: empty,
      }),
      env: {
        ...process.env,
        AGENTDECK_KIT_VARIANT: '',
        AGENTDECK_HEAVY_QUEUE_DIR: '',
        AGENTDECK_KIT_STATE: STATE,
        ...CHILD,
      },
      timeout: 15_000,
    });
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
    };
    const resend = hook('pre', call(s, empty, {}, other), CHILD);
    expect(gated(resend)).toBe(true);
    const rule = GATE.exec(reason(resend))![1]!;
    expect(gated(hook('pre', call(s, readOf(rule, [], [boundary]), {}, other), CHILD))).toBe(true);
    expect(gated(hook('pre', call(s, readOf(rule, [boundary]), {}, other), CHILD))).toBe(false);
  });
});
