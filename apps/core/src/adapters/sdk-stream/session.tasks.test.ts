import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionFile } from '../../session-host/protocol.ts';
import { CLAUDE_TASKS } from '../claude/task-rule.ts';
import type { AdapterEvent } from '../adapter.types.ts';
import type { SdkRule } from './normalise.ts';
import { SdkSession } from './session.ts';

/**
 * Конец сеанса и строки задач CLI (этап 11, P148): насос, дочитав поток до `exit.json`, отдаёт
 * то, что нормализатор держал до конца, — ДО строки ошибки конца. Субагент, чей конец CLI назвал
 * только `task_updated{status}`, кончается; фоновая оболочка без результата вызова всё равно
 * стартовала. Без этого дерево агентов показывало бы их идущими вечно. Каталог сеанса пишет тест,
 * как хост; правило задач — настоящее правило Claude.
 */

const opened: SdkSession[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const RULE: SdkRule = {
  echo: true,
  mapPermission: (raw) => ({ action: 'exec', target: raw.tool, tool: raw.tool, display: raw.tool }),
  tasks: CLAUDE_TASKS,
};

const EXIT = { v: 1, code: 0, signal: null, stopped: false, at: 1 };

function sessionDir(lines: unknown[]): string {
  const d = mkdtempSync(join(tmpdir(), 'sdk-session-tasks-'));
  writeFileSync(sessionFile(d, 'stdout'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  writeFileSync(sessionFile(d, 'exit'), JSON.stringify(EXIT));
  return d;
}

async function drain(s: SdkSession): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  const timer = setTimeout(() => s.close(), 5_000);
  for await (const e of s.events()) out.push(e);
  clearTimeout(timer);
  return out;
}

describe('sdk-stream session end flushes CLI task lines (stage 11, P148)', () => {
  it('an agent ended only by task_updated ends, a held background shell is released — both before the end error', async () => {
    const s = new SdkSession(
      sessionDir([
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'a1',
          tool_use_id: 'tu-agent',
          task_type: 'local_agent',
          description: 'look around',
        },
        {
          type: 'system',
          subtype: 'task_updated',
          task_id: 'a1',
          patch: { status: 'completed', end_time: 1_700 },
        },
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'b1',
          tool_use_id: 'tu-bash',
          task_type: 'local_bash',
          is_backgrounded: true,
          description: 'npm run watch',
        },
      ]),
      RULE,
      { pollMs: 10 },
    );
    opened.push(s);
    const events = await drain(s);
    const kinds = events.map((e) => e.type);
    // Порядок: начало агента из потока, затем то, что держалось до конца, и только потом конец.
    expect(kinds).toEqual(['agent.spawned', 'agent.ended', 'bg.started', 'error']);
    expect(events[1]).toMatchObject({ type: 'agent.ended', cliTaskId: 'a1', how: 'completed' });
    expect(events[2]).toMatchObject({ type: 'bg.started', itemId: 'b1', toolUseId: 'tu-bash' });
    expect(events[3]).toMatchObject({ type: 'error', code: 'exited' });
  });
});
