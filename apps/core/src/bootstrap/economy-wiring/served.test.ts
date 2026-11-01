import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../../adapters/index.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { journalServed } from './served.ts';

/**
 * P119 через судью этапа 8: первое имя модели сеанса — `signal model-served`; другое, чем просили,
 * — вердикт `routeMismatchVerdict` → `judgeSignal` по каталогу → `decision{class:'observer', key}`
 * и `signal route-mismatch` с действием каталога и `cause` = строка решения.
 */

const BINDING = { taskId: 't1', unitId: 'u1', stepId: 'st1', sessionId: 's1' } as SessionBinding;

function fakeTask(modelAsked: string | null, modelServed: string | null = null) {
  const lines: JournalLine[] = [];
  const task = {
    taskId: 't1',
    state: {
      sessions: { s1: { modelAsked, modelServed, route: { id: 'api-key:anthropic' } } },
    },
    append(input: Record<string, unknown>) {
      const line = { ...input, seq: lines.length + 1 } as unknown as JournalLine;
      lines.push(line);
      return line;
    },
  } as unknown as LiveTask;
  return { task, lines };
}

const usage = (model: string, subagent = false) =>
  ({ type: 'usage', model, subagent }) as unknown as Extract<AdapterEvent, { type: 'usage' }>;

describe('stage 8 journalServed goes through the observer judge', () => {
  it('another model than asked → model-served, then decision{observer, key} and route-mismatch with cause', () => {
    const { task, lines } = fakeTask('claude-opus-4-1');
    expect(journalServed(task, BINDING, usage('claude-sonnet-4-5'))).toBe(true);
    expect(
      lines.map((l) => [
        l.kind,
        (l.data as { signal?: string; class?: string }).signal ??
          (l.data as { class?: string }).class,
      ]),
    ).toEqual([
      ['signal', 'model-served'],
      ['decision', 'observer'],
      ['signal', 'route-mismatch'],
    ]);
    const [served, decision, mismatch] = lines as [
      JournalLine<'signal'>,
      JournalLine<'decision'>,
      JournalLine<'signal'>,
    ];
    expect(decision.data).toMatchObject({
      inputs: [served.seq],
      output: {
        fired: true,
        signal: 'route-mismatch',
        severity: 'warn',
        action: 'show',
        key: 'route-mismatch:s1',
      },
    });
    expect(mismatch).toMatchObject({
      cause: decision.seq,
      stepId: 'st1',
      sessionId: 's1',
      data: { severity: 'warn', action: 'show' },
    });
  });

  it('the asked model served → only model-served; subagent turns and a second name write nothing', () => {
    const asked = fakeTask('claude-opus-4-1');
    expect(journalServed(asked.task, BINDING, usage('claude-opus-4-1'))).toBe(true);
    expect(asked.lines.map((l) => l.kind)).toEqual(['signal']);
    const sub = fakeTask('claude-opus-4-1');
    expect(journalServed(sub.task, BINDING, usage('claude-haiku-4-5', true))).toBe(false);
    const known = fakeTask('claude-opus-4-1', 'claude-opus-4-1');
    expect(journalServed(known.task, BINDING, usage('claude-sonnet-4-5'))).toBe(false);
    expect([...sub.lines, ...known.lines]).toEqual([]);
  });
});
