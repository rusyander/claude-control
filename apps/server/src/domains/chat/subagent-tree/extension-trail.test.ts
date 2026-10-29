import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptRecord } from '../ChatHistory/ChatHistory.ts';
import { resetAgentDigestCache } from './agent-digest.ts';
import {
  ExtensionTrail,
  MainExtensionTrail,
  hookScriptName,
  mcpName,
  type ExtensionSnapshot,
} from './extension-trail.ts';
import { IncrementalLogs } from './incremental-log.ts';
import { readAgentExtensions, readChatProgressWithTree } from './subagent-tree.ts';

/**
 * Скиллы, хуки и MCP агента по записям транскрипта. Формы записей сняты с
 * настоящих транскриптов claude 2.1.3xx (вставки `hook_*`, отказ PreToolUse
 * результатом вызова); данные выдуманы.
 */

const at = (second: number): string => `2026-10-25T10:00:${String(second).padStart(2, '0')}.000Z`;

const toolUse = (
  id: string,
  name: string,
  input: object,
  second: number,
  extra: object = {},
): TranscriptRecord => ({
  type: 'assistant',
  timestamp: at(second),
  ...extra,
  message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

const toolResult = (
  id: string,
  text: string,
  second: number,
  isError = false,
  extra: object = {},
): TranscriptRecord => ({
  type: 'user',
  timestamp: at(second),
  ...extra,
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: text,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  },
});

const hook = (attachment: object, second: number, extra: object = {}): TranscriptRecord =>
  ({ type: 'attachment', timestamp: at(second), ...extra, attachment }) as TranscriptRecord;

function trailOf(records: TranscriptRecord[]) {
  const trail = new ExtensionTrail();
  for (const record of records) trail.add(record);
  return trail.snapshot();
}

describe('след скиллов, хуков и MCP', () => {
  it('скилл: идёт до результата, затем ok со временем от вызова и аргументами', () => {
    const running = trailOf([
      toolUse('s1', 'Skill', { skill: 'deep-review', args: 'ветка\nвторая строка' }, 1),
    ]);
    expect(running.items).toEqual([
      { kind: 'skill', name: 'deep-review', at: at(1), outcome: 'running', detail: 'ветка' },
    ]);
    const done = trailOf([
      toolUse('s1', 'Skill', { skill: 'deep-review', args: 'ветка' }, 1),
      toolResult('s1', 'Launching skill: deep-review', 4),
    ]);
    expect(done.items[0]).toMatchObject({ outcome: 'ok', durationMs: 3000 });
    expect(done.summary).toEqual([
      { kind: 'skill', name: 'deep-review', count: 1, lastAt: at(1), totalMs: 3000 },
    ]);
  });

  it('MCP: имя «сервер/инструмент», ошибка результата — error и счёт ошибок', () => {
    const snap = trailOf([
      toolUse('p1', 'mcp__telegram-inbox__telegram_send_message', { text: 'x' }, 1),
      toolResult('p1', 'chat not found', 2, true),
    ]);
    expect(snap.items[0]).toMatchObject({
      kind: 'mcp',
      name: 'telegram-inbox/telegram_send_message',
      outcome: 'error',
      durationMs: 1000,
    });
    expect(snap.summary[0]).toMatchObject({ errors: 1, count: 1 });
  });

  it('MCP, оборванный паузой: «прервано», не ошибка и не в счёт ошибок', () => {
    const snap = trailOf([
      toolUse('p2', 'mcp__telegram-inbox__telegram_send_message', { text: 'x' }, 1),
      toolResult(
        'p2',
        "[Tool call interrupted: the session ended before this call's result was recorded.]",
        5,
        true,
      ),
    ]);
    expect(snap.items[0]).toMatchObject({ outcome: 'interrupted', durationMs: 4000 });
    // Сводка не передаёт нулевой счёт ошибок.
    expect(snap.summary[0]).toMatchObject({ count: 1 });
    expect(snap.summary[0]?.errors).toBeUndefined();
  });

  it('hook_success: имя скрипта из команды, замер CLI; код 2 — отказ, иной ненулевой — ошибка', () => {
    const snap = trailOf([
      hook(
        {
          type: 'hook_success',
          hookName: 'SessionStart:startup',
          hookEvent: 'SessionStart',
          command: 'node "C:/Users/u/.claude/hooks/context-budget.mjs"',
          stdout: '[context-budget] rules re-sent\nвторая',
          exitCode: 0,
          durationMs: 332,
        },
        1,
      ),
      hook(
        {
          type: 'hook_success',
          hookName: 'Stop',
          command: 'node /h/tests-hook.mjs stop',
          exitCode: 2,
        },
        2,
      ),
      hook({ type: 'hook_success', hookName: 'Stop', command: 'bash ./lint.sh', exitCode: 1 }, 3),
    ]);
    expect(snap.items).toEqual([
      {
        kind: 'hook',
        name: 'context-budget',
        at: at(1),
        durationMs: 332,
        outcome: 'ok',
        detail: 'SessionStart:startup · [context-budget] rules re-sent',
      },
      { kind: 'hook', name: 'tests-hook', at: at(2), outcome: 'denied', detail: 'Stop' },
      { kind: 'hook', name: 'lint', at: at(3), outcome: 'error', detail: 'Stop' },
    ]);
  });

  it('hook_additional_context: имя — метка, заголовок карточки до « — » или событие', () => {
    const snap = trailOf([
      hook(
        {
          type: 'hook_additional_context',
          hookName: 'PostToolUse:Bash',
          content: ['[batch] 3 turns in a row each ran one shell'],
        },
        1,
      ),
      hook(
        {
          type: 'hook_additional_context',
          hookName: 'PreToolUse:Edit',
          content: ['# Doc placement — a Markdown file is about to be written'],
        },
        2,
      ),
      hook(
        {
          type: 'hook_additional_context',
          hookName: 'UserPromptSubmit',
          content: ['Situation match — skills that fit'],
        },
        3,
      ),
    ]);
    expect(snap.items.map((item) => [item.name, item.outcome])).toEqual([
      ['batch', 'context'],
      ['Doc placement', 'context'],
      ['UserPromptSubmit', 'context'],
    ]);
    expect(snap.items[0]?.detail).toBe(
      'PostToolUse:Bash · [batch] 3 turns in a row each ran one shell',
    );
  });

  it('отказы: hook_blocking_error по команде и PreToolUse результатом вызова', () => {
    const snap = trailOf([
      hook(
        {
          type: 'hook_blocking_error',
          hookName: 'Stop',
          hookEvent: 'Stop',
          blockingError: {
            blockingError: 'Tests block: cases not run\nподробно',
            command: 'node "C:\\work\\tools\\tests-hook.mjs" stop',
          },
        },
        1,
      ),
      toolUse('r1', 'Read', { file_path: 'a.ts' }, 2),
      toolResult(
        'r1',
        'PreToolUse:Read hook error: [ctx-guard] search-discipline: 12 read-only calls',
        3,
        true,
      ),
      toolResult(
        'r2',
        'PreToolUse:mcp__gl__get_mr hook error: [mcp-guard] write needs a yes',
        4,
        true,
      ),
    ]);
    expect(snap.items).toEqual([
      {
        kind: 'hook',
        name: 'tests-hook',
        at: at(1),
        outcome: 'denied',
        detail: 'Stop · Tests block: cases not run',
      },
      {
        kind: 'hook',
        name: 'search-discipline',
        at: at(3),
        outcome: 'denied',
        detail: 'PreToolUse:Read · [ctx-guard] search-discipline: 12 read-only calls',
      },
      {
        kind: 'hook',
        name: 'mcp-guard',
        at: at(4),
        outcome: 'denied',
        detail: 'PreToolUse:mcp__gl__get_mr · [mcp-guard] write needs a yes',
      },
    ]);
    expect(snap.summary.find((row) => row.name === 'search-discipline')?.denied).toBe(1);
  });

  it('ошибка обычного вызова и чужие вставки — не срабатывания', () => {
    const snap = trailOf([
      toolUse('b1', 'Bash', { command: 'false' }, 1),
      toolResult('b1', 'Exit code 1', 2, true),
      toolResult('x9', 'Exit code 1\nPreToolUse:Read hook error: внутри вывода', 3, true),
      hook({ type: 'queued_command', prompt: 'слова человека' }, 4),
      toolUse('t1', 'Skill', {}, 5),
    ]);
    expect(snap.items).toEqual([]);
    expect(snap.total).toBe(0);
  });

  it('сводка: скиллы, MCP, хуки; внутри — по числу срабатываний', () => {
    const snap = trailOf([
      hook({ type: 'hook_success', hookName: 'PreToolUse:Bash', command: 'node a.mjs' }, 1),
      hook({ type: 'hook_success', hookName: 'PreToolUse:Bash', command: 'node b.mjs' }, 2),
      hook({ type: 'hook_success', hookName: 'PreToolUse:Bash', command: 'node b.mjs' }, 3),
      toolUse('p1', 'mcp__srv__tool', {}, 4),
      toolUse('s1', 'Skill', { skill: 'x' }, 5),
    ]);
    expect(snap.summary.map((row) => `${row.kind}:${row.name}:${row.count}`)).toEqual([
      'skill:x:1',
      'mcp:srv/tool:1',
      'hook:b:2',
      'hook:a:1',
    ]);
  });

  it('окно срабатываний — последние 400, счёт всех остаётся', () => {
    const records = Array.from({ length: 405 }, (_, index) =>
      hook({ type: 'hook_success', hookName: 'Stop', command: `node h${index}.mjs` }, index % 60),
    );
    const snap = trailOf(records);
    expect(snap.items).toHaveLength(400);
    expect(snap.items[0]?.name).toBe('h5');
    expect(snap.total).toBe(405);
  });

  it('главный агент не берёт записи ходов субагентов (isSidechain)', () => {
    const trail = new MainExtensionTrail();
    trail.add(toolUse('s1', 'Skill', { skill: 'own' }, 1));
    trail.add(toolUse('s2', 'Skill', { skill: 'side' }, 2, { isSidechain: true }));
    expect(trail.snapshot().items.map((item) => item.name)).toEqual(['own']);
  });

  it('имена: скрипт хука и инструмент MCP', () => {
    expect(hookScriptName('node "C:\\Users\\u\\.claude\\hooks\\git-guard.mjs" pre')).toBe(
      'git-guard',
    );
    expect(hookScriptName('python3 /opt/hooks/lint_check.py')).toBe('lint_check');
    expect(hookScriptName('my-hook --fast')).toBe('my-hook');
    expect(hookScriptName('  ')).toBeUndefined();
    expect(mcpName('mcp__gitlab-acme__get_merge_request')).toBe('gitlab-acme/get_merge_request');
    expect(mcpName('mcp__srv__a__b')).toBe('srv/a__b');
    expect(mcpName('mcp__srv')).toBeUndefined();
    expect(mcpName('Read')).toBeUndefined();
  });
});

describe('дочитывание транскрипта с хвоста', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-incremental-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('большой файл: первое чтение — только хвост без оборванной строки, дальше — дописанное', () => {
    const path = join(dir, 'main.jsonl');
    const lines = Array.from(
      { length: 40 },
      (_, index) => `${JSON.stringify(toolUse(`s${index}`, 'Skill', { skill: `k${index}` }, 1))}\n`,
    );
    writeFileSync(path, lines.join(''));
    const logs = new IncrementalLogs<MainExtensionTrail, ExtensionSnapshot>({
      create: () => new MainExtensionTrail(),
      limit: 4,
      tailBytes: 600,
    });
    const first = logs.read(path);
    const names = first?.items.map((item) => item.name) ?? [];
    expect(logs.isPartial(path)).toBe(true);
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThan(40);
    // Хвост — подряд до последней записи: ни одной оборванной строки не разобрано наполовину.
    expect(names.at(-1)).toBe('k39');
    const from = Number(names[0]?.slice(1));
    expect(names).toEqual(Array.from({ length: 40 - from }, (_, index) => `k${from + index}`));
    appendFileSync(path, `${JSON.stringify(toolUse('s40', 'Skill', { skill: 'k40' }, 2))}\n`);
    expect(logs.read(path)?.items.at(-1)?.name).toBe('k40');
  });

  it('оборванная первая строка хвоста отбрасывается, даже если её остаток — целая запись', () => {
    const path = join(dir, 'cut.jsonl');
    const ghost = JSON.stringify(toolUse('g', 'Skill', { skill: 'ghost' }, 1));
    const real = `${JSON.stringify(toolUse('r', 'Skill', { skill: 'real' }, 2))}\n`;
    // Начало хвоста приходится ровно на «{» внутри первой строки.
    writeFileSync(path, `prefix-not-json ${ghost}\n${real}`);
    const tailBytes = Buffer.byteLength(`${ghost}\n${real}`);
    const logs = new IncrementalLogs<MainExtensionTrail, ExtensionSnapshot>({
      create: () => new MainExtensionTrail(),
      limit: 4,
      tailBytes,
    });
    expect(logs.read(path)?.items.map((item) => item.name)).toEqual(['real']);
  });

  it('файл меньше хвоста читается целиком и не помечается неполным', () => {
    const path = join(dir, 'small.jsonl');
    writeFileSync(path, `${JSON.stringify(toolUse('s0', 'Skill', { skill: 'k0' }, 1))}\n`);
    const logs = new IncrementalLogs<MainExtensionTrail, ExtensionSnapshot>({
      create: () => new MainExtensionTrail(),
      limit: 4,
      tailBytes: 1 << 20,
    });
    expect(logs.read(path)?.items.map((item) => item.name)).toEqual(['k0']);
    expect(logs.isPartial(path)).toBe(false);
  });
});

describe('скиллы, хуки и MCP в дереве агентов', () => {
  let root: string;
  let projects: string;

  beforeEach(() => {
    resetAgentDigestCache();
    root = mkdtempSync(join(tmpdir(), 'cc-ext-tree-'));
    projects = join(root, 'projects');
    const agents = join(projects, 'proj', 'sess', 'subagents');
    mkdirSync(agents, { recursive: true });
    const main = [
      toolUse('s1', 'Skill', { skill: 'deep-review' }, 1),
      toolResult('s1', 'Launching skill: deep-review', 2),
      toolUse('a1', 'Agent', { description: 'Найти', subagent_type: 'Explore', prompt: 'x' }, 3),
    ];
    writeFileSync(
      join(projects, 'proj', 'sess.jsonl'),
      main.map((record) => `${JSON.stringify(record)}\n`).join(''),
    );
    writeFileSync(
      join(agents, 'agent-ab12.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: 'Найти', toolUseId: 'a1' }),
    );
    const sub = [
      {
        type: 'user',
        isSidechain: true,
        timestamp: at(3),
        message: { role: 'user', content: 'x' },
      },
      hook(
        {
          type: 'hook_success',
          hookName: 'PreToolUse:Grep',
          command: 'node g.mjs',
          durationMs: 40,
        },
        4,
        { isSidechain: true },
      ),
      toolUse('p1', 'mcp__srv__find', {}, 5, { isSidechain: true }),
    ];
    writeFileSync(
      join(agents, 'agent-ab12.jsonl'),
      sub.map((record) => `${JSON.stringify(record)}\n`).join(''),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('прогресс: сводка главного агента и узла субагента', () => {
    const progress = readChatProgressWithTree(projects, 'sess');
    expect(progress.extensions).toEqual([
      { kind: 'skill', name: 'deep-review', count: 1, lastAt: at(1), totalMs: 1000 },
    ]);
    const node = progress.agents.find((agent) => agent.agentId === 'ab12');
    expect(node?.extensions?.map((row) => `${row.kind}:${row.name}`)).toEqual([
      'mcp:srv/find',
      'hook:g',
    ]);
  });

  it('хронология: главный без agentId, субагент по id; чужой id — undefined', () => {
    expect(readAgentExtensions(projects, 'sess', undefined)).toMatchObject({
      total: 1,
      items: [{ kind: 'skill', name: 'deep-review', outcome: 'ok' }],
    });
    expect(readAgentExtensions(projects, 'sess', 'ab12')).toMatchObject({
      agentId: 'ab12',
      total: 2,
      items: [
        { kind: 'hook', name: 'g', durationMs: 40, outcome: 'ok' },
        { kind: 'mcp', name: 'srv/find', outcome: 'running' },
      ],
    });
    expect(readAgentExtensions(projects, 'sess', '../x')).toBeUndefined();
    expect(readAgentExtensions(projects, 'nope', undefined)).toBeUndefined();
  });
});
