import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Экономия окна в звене группы разделения (фаза G, перенос в набор): повторная доставка правила
 * после сжатия — карточкой, ожидание файлов своего фонового агента опросом — отказ без выхода
 * повтором, правила набора на старте звена — карточкой группы. Всё через те же точки входа, что
 * зовёт hooks.json: диспетчер `run.mjs` и `session-rules.mjs`.
 */

const KIT = builtinKitDir();
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const SESSION_RULES = join(KIT, 'hooks', 'session-rules.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-split-economy-'));
const STATE = join(dir, 'state');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Маркеры звена задаются явно в каждом вызове: окружение самого прогона тестов может их нести.
const CHILD = { AGENTDECK_SPLIT_CHILD: '1', AGENTDECK_USER_MEMORY_OFF: '1' };
const HUMAN = { AGENTDECK_SPLIT_CHILD: '', AGENTDECK_USER_MEMORY_OFF: '' };

function spawnHook(args: string[], payload: object, env: Record<string, string>): string {
  const out = spawnSync(process.execPath, args, {
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
  });
  return out.stdout.trim();
}

type HookOut = {
  hookSpecificOutput?: { additionalContext?: string; permissionDecisionReason?: string };
};
const parse = (out: string): HookOut => (out ? (JSON.parse(out) as HookOut) : {});

describe('rule-injector: повторная доставка в звене группы — карточка (G.3)', () => {
  const docker = (session: string, env: Record<string, string>) =>
    parse(
      spawnHook(
        [DISPATCH, 'pre'],
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'docker run --rm hello-world' },
          session_id: session,
          transcript_path: '',
          cwd: dir,
        },
        env,
      ),
    ).hookSpecificOutput?.additionalContext ?? '';
  const compact = (session: string, env: Record<string, string>) =>
    spawnHook(
      [DISPATCH, 'precompact'],
      { hook_event_name: 'PreCompact', session_id: session, transcript_path: '', cwd: dir },
      env,
    );
  const full = readFileSync(
    join(KIT, 'skills', 'situational-rules', 'references', 'docker-shared.md'),
    'utf8',
  ).trim();

  it('первая доставка целиком, повтор до сжатия молчит, после сжатия — карточка с путём к файлу', () => {
    const s = 'splitchild01';
    const first = docker(s, CHILD);
    expect(first).toContain(full.slice(0, 200));
    expect(first.length).toBeGreaterThan(1000);
    expect(docker(s, CHILD)).toBe('');
    compact(s, CHILD);
    const card = docker(s, CHILD);
    expect(card.length).toBeLessThanOrEqual(1000);
    expect(card).toMatch(/— card \(split group/);
    expect(card).toMatch(/Read \S*situational-rules\/references\/docker-shared\.md/);
    expect(card).toMatch(/offset=\d+ limit=\d+/);
  });

  it('сессия человека после сжатия снова получает правило целиком', () => {
    const s = 'humansess001';
    expect(docker(s, HUMAN)).toContain(full.slice(0, 200));
    compact(s, HUMAN);
    const again = docker(s, HUMAN);
    expect(again).toContain(full.slice(0, 200));
    expect(again).not.toMatch(/— card \(split group/);
  });

  it('сжатие убирает чужую недельную отметку `.sent`, свою оставляет', () => {
    const own = 'splitchild02';
    docker(own, CHILD);
    const rules = join(STATE, 'rules');
    const mine = join(rules, `rule-docker-shared-${own}.sent`);
    const stale = join(rules, 'rule-docker-shared-deadsession1.sent');
    writeFileSync(stale, '1');
    const old = (Date.now() - 8 * 24 * 3600e3) / 1000;
    utimesSync(stale, old, old);
    compact(own, CHILD);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });
});

// Хелперы стенограммы — как в layer-b-guards.test.ts: запуск фонового агента и его уведомление.
let n = 0;
const say = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const use = (name: string, input: object, id: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

describe('bg-wait-guard: ожидание файлов своего агента в звене группы (G.4)', () => {
  const lanes = [
    say('проведи ревью'),
    use('Agent', { description: 'review lane A', prompt: '…', run_in_background: true }, 'ag1'),
    result('ag1', 'Async agent launched successfully.\nagentId: a0e1lanea0000001 (internal ID)'),
  ];
  const done = {
    type: 'queue-operation',
    operation: 'remove',
    content: '<task-notification>\n<task-id>a0e1lanea0000001</task-id>\n<status>completed</status>',
  };
  // Дословно из карточки 32 замера: 28 минут хода на опросе двух отчётов своих полос.
  const poll =
    'D=.agent/tmp/review-x; for i in $(seq 1 170); do [ -f $D/lane-A.md ] && [ -f $D/lane-B.md ] && break; sleep 10; done';
  const refused = (records: object[]) => [
    ...records,
    use('Bash', { command: poll }, 'p1'),
    result('p1', '[ctx-guard] bg-wait-guard: …'),
  ];
  const pre = (command: string, records: object[], env: Record<string, string>, extra = {}) =>
    parse(
      spawnHook(
        [DISPATCH, 'pre'],
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          transcript_path: transcript(records),
          session_id: 'kit-split-g4',
          cwd: dir,
          ...extra,
        },
        env,
      ),
    ).hookSpecificOutput?.permissionDecisionReason ?? '';

  it('агент работает — отказ, и повтор той же команды тоже отказ', () => {
    expect(pre(poll, lanes, CHILD)).toMatch(/1700 s sleep loop waiting for files of an agent/);
    expect(pre(poll, refused(lanes), CHILD)).toMatch(/does not lift it/);
  });

  // Группа 1 (23.10, #g1:345 и #g1:354 — дословно): 698 и 722 с хода на опросе отчётов своих
  // полос через `stat -c %Y`; проверка файла была не `[ -f`, и страж знал только её. Теперь
  // любой цикл со сном по файлам агента, пока тот идёт, — отказ, чем бы цикл ни проверял.
  const statLoop =
    'D=.agent/tmp/review-gor1298; for i in $(seq 1 150); do a=$(stat -c %Y $D/lane-A.md 2>/dev/null || echo 0); b=$(stat -c %Y $D/lane-B.md 2>/dev/null || echo 0); now=$(date +%s); if [ $a -gt 0 ] && [ $b -gt 0 ] && [ $((now-a)) -gt 240 ] && [ $((now-b)) -gt 240 ]; then echo "both stable after $i"; break; fi; sleep 10; done; ls -la $D/';
  const g1 = [
    statLoop,
    'D=.agent/tmp/review-gor1298; for i in $(seq 1 170); do a=$(stat -c %Y $D/lane-A-r2.md 2>/dev/null || echo 0); b=$(stat -c %Y $D/lane-B-r2.md 2>/dev/null || echo 0); now=$(date +%s); if [ $a -gt 0 ] && [ $b -gt 0 ] && [ $((now-a)) -gt 240 ] && [ $((now-b)) -gt 240 ]; then echo "stable after $i"; break; fi; sleep 10; done; ls -la $D/*.md',
    'for i in $(seq 1 60); do n=$(ls .agent/tmp/review-x/*.md 2>/dev/null | wc -l); [ "$n" -ge 2 ] && break; sleep 10; done',
    'while ! grep -q "Журнал" .agent/tmp/review-x/lane-A.md 2>/dev/null; do sleep 20; done',
    "for i in $(seq 1 90); do node -e \"process.exit(require('fs').existsSync('.agent/tmp/review-x/lane-A.md')?0:1)\" && break; sleep 10; done",
  ];

  it('опрос любым способом (stat, ls, grep, node) — отказ без выхода повтором', () => {
    for (const command of g1) {
      expect(pre(command, lanes, CHILD), command).toMatch(
        /sleep loop waiting for files of an agent/,
      );
    }
    expect(
      pre(
        statLoop,
        [
          ...lanes,
          use('Bash', { command: statLoop }, 'p2'),
          result('p2', '[ctx-guard] bg-wait-guard: …'),
        ],
        CHILD,
      ),
    ).toMatch(/does not lift it/);
  });

  it('вне группы опрос своего агента циклом ≥ 60 с — отказ с выходом повтором', () => {
    expect(pre(statLoop, lanes, HUMAN)).toMatch(/while an agent this session spawned is running/);
    expect(
      pre(
        statLoop,
        [
          ...lanes,
          use('Bash', { command: statLoop }, 'p3'),
          result('p3', '[ctx-guard] bg-wait-guard: …'),
        ],
        HUMAN,
      ),
    ).toBe('');
    expect(pre(statLoop, [...lanes, done], HUMAN)).toBe('');
  });

  it('проходит: агент уже сообщил, вне группы, без агентов, короткий цикл, в субагенте', () => {
    expect(pre(poll, [...lanes, done], CHILD)).toBe('');
    expect(pre(poll, lanes, HUMAN)).not.toMatch(/split-group run launched/);
    expect(pre(poll, [say('проведи ревью')], CHILD)).toBe('');
    const short =
      'for i in {1..3}; do [ -f .agent/tmp/review-x/lane-A.md ] && break; sleep 5; done';
    expect(pre(short, lanes, CHILD)).toBe('');
    expect(pre(poll, lanes, CHILD, { agent_id: 'sub1' })).toBe('');
  });
});

describe('session-rules: карточка группы вместо правил набора (G.2)', () => {
  const start = (env: Record<string, string>, source = 'startup') =>
    parse(spawnHook([SESSION_RULES], { hook_event_name: 'SessionStart', source }, env))
      .hookSpecificOutput?.additionalContext ?? '';
  const standard = readFileSync(join(KIT, 'rules', 'standard.md'), 'utf8').trim();
  const localRule = readFileSync(join(KIT, 'rules', 'local.md'), 'utf8').trim();

  it('звено без памяти пользователя получает карточку и после сжатия; правил целиком нет', () => {
    for (const source of ['startup', 'compact']) {
      const ctx = start(CHILD, source);
      expect(ctx).toMatch(/^Kit root/);
      expect(ctx).toContain('# Group rules card');
      // Самопроверка доставки (g1 26.10, F6/F7): выход 0 — доказательство, факт — в строку до прогона.
      expect(ctx).toContain('exit 0 is the proof for the MR description and threads');
      expect(ctx).toContain('run the check once, after the last row edit');
      expect(ctx).not.toContain(standard.slice(0, 200));
      expect(ctx.length).toBeLessThan(3000);
    }
  });

  it('локальный вариант: карточка, затем local.md последним словом', () => {
    const ctx = start({ ...CHILD, AGENTDECK_KIT_VARIANT: 'local' });
    expect(ctx).toContain('# Group rules card');
    expect(ctx.endsWith(localRule)).toBe(true);
    expect(ctx).not.toContain(standard.slice(0, 200));
  });

  it('без обоих маркеров — правила целиком, карточки нет', () => {
    for (const env of [
      HUMAN,
      { ...HUMAN, AGENTDECK_SPLIT_CHILD: '1' },
      { ...HUMAN, AGENTDECK_USER_MEMORY_OFF: '1' },
    ]) {
      const ctx = start(env);
      expect(ctx).toContain(standard.slice(0, 200));
      expect(ctx).not.toContain('# Group rules card');
    }
  });

  it('нет файла карточки — правила целиком, а не пусто', () => {
    // Копия набора во временной папке: встроенный набор не трогается.
    const copy = join(dir, 'kit-copy', 'hooks');
    mkdirSync(join(copy, 'cards'), { recursive: true });
    mkdirSync(join(dir, 'kit-copy', 'rules'), { recursive: true });
    writeFileSync(join(copy, 'session-rules.mjs'), readFileSync(SESSION_RULES));
    writeFileSync(join(copy, 'cards', 'group-rules.md'), '# Group rules card\n');
    writeFileSync(join(dir, 'kit-copy', 'rules', 'standard.md'), standard);
    const run = () =>
      parse(spawnHook([join(copy, 'session-rules.mjs')], { source: 'startup' }, CHILD))
        .hookSpecificOutput?.additionalContext ?? '';
    expect(run()).toContain('# Group rules card');
    renameSync(join(copy, 'cards', 'group-rules.md'), join(copy, 'cards', 'gone.md'));
    expect(run()).toContain(standard.slice(0, 200));
  });
});
