import { describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { KillPoint } from './__fixtures__/e2e/e2e.types.ts';
import { journalKillHit, PERMIT_KILL_POINTS } from './__fixtures__/e2e/kill-match.ts';

/**
 * Точки смерти P10 на решениях о праве ложатся на те же вызовы инструментов, что до дороги сессии.
 * Порядок строк — как его пишет дорога в живом прогоне (журнал чистого прогона P10): у Claude хук
 * ядра (PreToolUse) решает вызов ДО вопроса CLI инструментом права, у Qwen — ПОСЛЕ.
 */

const decision = (seq: number, road: 'hook' | undefined, tool: string, call: string): JournalLine =>
  ({
    seq,
    kind: 'decision',
    data: { class: 'permit', output: { tool, target: call, ...(road ? { road } : {}) } },
  }) as unknown as JournalLine;

const CALLS = [
  ['Write', 'hello.txt'],
  ['Bash', 'git add hello.txt'],
  ['Bash', 'git commit -m add-hello'],
] as const;

/** Claude: хук, затем вопрос; Qwen: вопрос, затем хук. Заявление шага — только хуком. */
function order(hookFirst: boolean): JournalLine[] {
  const pairs = CALLS.flatMap(([tool, call]) =>
    hookFirst
      ? [['hook', tool, call] as const, [undefined, tool, call] as const]
      : [[undefined, tool, call] as const, ['hook', tool, call] as const],
  );
  return [...pairs, ['hook', 'mcp__agentdeck__step_done', 'step_done'] as const].map(
    ([road, tool, call], i) => decision(i + 1, road, tool, call),
  );
}

function landsOn(lines: JournalLine[], kill: Extract<KillPoint, { at: 'journal' }>): string {
  const hit = journalKillHit(kill);
  const line = lines.find((l) => hit(l, { actions: {} } as never));
  return (line?.data as { output: { target: string } } | undefined)?.output.target ?? 'none';
}

describe('P10 permit kill points land on distinct tool calls', () => {
  it.each([
    ['claude (hook first)', true],
    ['qwen (question first)', false],
  ])(
    '%s: permit 1–3 count the CLI’s questions (three different calls), the hook has its own point',
    (_name, hookFirst) => {
      const lines = order(hookFirst);
      expect(PERMIT_KILL_POINTS.map((p) => [p.name, landsOn(lines, p.kill)])).toEqual([
        ['permit decision 1', 'hello.txt'],
        ['permit decision 2', 'git add hello.txt'],
        ['permit decision 3', 'git commit -m add-hello'],
        ['hook decision 1', 'hello.txt'],
      ]);
    },
  );

  it('counting every permit decision (no road filter) would collapse 1–2 onto one call and miss the commit — the weakened check', () => {
    for (const hookFirst of [true, false]) {
      const blind = [1, 2, 3].map((nth) =>
        landsOn(order(hookFirst), {
          at: 'journal',
          kind: 'decision',
          nth,
          decisionClass: 'permit',
        }),
      );
      expect(blind).toEqual(['hello.txt', 'hello.txt', 'git add hello.txt']);
    }
  });
});
