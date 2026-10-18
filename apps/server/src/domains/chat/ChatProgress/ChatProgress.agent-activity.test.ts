import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgress, withAgentActivity } from './ChatProgress.ts';
import type { TranscriptRecord } from '../ChatHistory/ChatHistory.ts';

/**
 * Фоновый субагент между ходами (живой прогон 14.10): полоса звала его
 * «работает» часами, хотя он стоял. Теперь видно, что он фоновый и когда писал
 * в последний раз — по его собственному транскрипту рядом с главным.
 */

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const launch: TranscriptRecord[] = [
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tu-agent',
          name: 'Agent',
          input: { subagent_type: 'lane-high', description: 'Fetch MR !990', prompt: 'x' },
        },
      ],
    },
  } as TranscriptRecord,
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu-agent',
          content: 'Async agent launched successfully. agentId: a53c (internal)',
        },
      ],
    },
  } as TranscriptRecord,
];

describe('субагент в фоне', () => {
  it('расписка о запуске помечает его фоновым и оставляет идущим', () => {
    const [agent] = buildProgress(launch).agents;
    expect(agent).toMatchObject({ id: 'tu-agent', status: 'running', background: true });
  });

  it('время последней записи берётся из его транскрипта по toolUseId из meta.json', () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-activity-'));
    const main = join(root, 'sess.jsonl');
    const dir = join(root, 'sess', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(main, '');
    writeFileSync(join(dir, 'agent-a53c.meta.json'), JSON.stringify({ toolUseId: 'tu-agent' }));
    writeFileSync(join(dir, 'agent-a53c.jsonl'), '{}\n');
    const at = new Date('2026-10-14T15:45:13.000Z');
    utimesSync(join(dir, 'agent-a53c.jsonl'), at, at);
    // Чужой субагент без файла журнала — не повод терять остальных.
    writeFileSync(join(dir, 'agent-zzz.meta.json'), JSON.stringify({ toolUseId: 'other' }));

    const agents = withAgentActivity(buildProgress(launch).agents, main);
    expect(agents[0]?.lastActivityAt).toBe(at.toISOString());
  });

  /** Транскрипт субагента: строки JSONL, как их пишет CLI. */
  function subagent(lines: object[]): string {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-now-'));
    const main = join(root, 'sess.jsonl');
    const dir = join(root, 'sess', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(main, '');
    writeFileSync(join(dir, 'agent-a53c.meta.json'), JSON.stringify({ toolUseId: 'tu-agent' }));
    writeFileSync(join(dir, 'agent-a53c.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
    return main;
  }
  const call = (id: string, input: object, timestamp: string) => ({
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }] },
  });
  const answer = (id: string, timestamp: string) => ({
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });

  it('живое ревью 18.10: строка называет текущий вызов субагента и с какого времени', () => {
    const main = subagent([
      call('b1', { command: 'git diff', description: 'Diff' }, '2026-10-18T08:00:00.000Z'),
      answer('b1', '2026-10-18T08:00:02.000Z'),
      call(
        'b2',
        { command: 'node mustfail.mjs', description: 'Mustfail' },
        '2026-10-18T08:01:00.000Z',
      ),
    ]);
    const [agent] = withAgentActivity(buildProgress(launch).agents, main);
    expect(agent?.activity).toEqual({
      name: 'Bash',
      summary: 'Mustfail',
      startedAt: '2026-10-18T08:01:00.000Z',
    });
  });

  it('сон перед чтением вывода — ожидание, а не работа', () => {
    const main = subagent([
      call(
        's1',
        { command: 'sleep 60 && tail out.log', description: 'Wait' },
        '2026-10-18T08:02:00.000Z',
      ),
    ]);
    const [agent] = withAgentActivity(buildProgress(launch).agents, main);
    expect(agent?.activity?.waiting).toBe(true);
  });

  it('у законченного субагента текущего вызова нет', () => {
    const main = subagent([call('b9', { command: 'ls' }, '2026-10-18T08:03:00.000Z')]);
    const done = buildProgress(launch).agents.map((a) => ({ ...a, status: 'done' as const }));
    expect(withAgentActivity(done, main)[0]?.activity).toBeUndefined();
  });

  it('запуск субагента помнит своё время — сколько он уже работает', () => {
    const stamped = launch.map((r) => ({ ...r, timestamp: '2026-10-18T07:58:00.000Z' }));
    expect(buildProgress(stamped).agents[0]?.startedAt).toBe('2026-10-18T07:58:00.000Z');
  });

  it('папки субагентов нет — список как был', () => {
    const agents = buildProgress(launch).agents;
    expect(withAgentActivity(agents, join(tmpdir(), 'nope-xyz.jsonl'))).toBe(agents);
  });
});
