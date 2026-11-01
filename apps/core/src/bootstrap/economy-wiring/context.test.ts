import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../../adapters/adapter.types.ts';
import type { BriefPart } from '../../context/brief/index.ts';
import { BriefOverBudget, platformRulesPart } from '../../context/brief/index.ts';
import type { BaseKey } from '../../context/base/index.ts';
import { DELTA_TAG, sentAfter } from '../../context/sent/index.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { createContextWiring } from './context.ts';

/**
 * Проводка контекста (зона C) на поддельной задаче: свёртка набора отданного повторена тем же
 * `sentAfter`, что даст редьюсер зоны L, — второй вызов той же сессии видит, что уже ушло (P13).
 */

interface Row {
  kind: string;
  data: Record<string, unknown>;
}

function fakeTask() {
  const rows: Row[] = [];
  const state = {
    sent: {} as Record<string, Record<string, string>>,
    bases: [] as BaseKey[],
  };
  const task = {
    state,
    append(row: Row) {
      rows.push(row);
      if (row.kind === 'brief.sent') {
        const sid = row.data.sessionId as string;
        state.sent[sid] = sentAfter(
          state.sent[sid] ?? {},
          row.data.sections as { id: string; sha256: string; bytes: number }[],
        );
      }
      if (row.kind === 'context.base') state.bases.push(row.data as unknown as BaseKey);
    },
  };
  return { task: task as unknown as LiveTask, rows };
}

const part = (id: BriefPart['id'], text: string): BriefPart => ({ id, text, from: 'test' });
const key: BaseKey = {
  adapter: 'claude',
  cliVersion: '2.1.310',
  stepKind: 'work',
  layerHash: 'l',
  mcpHash: 'm',
};
const dirs: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-wiring-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('createContextWiring.opening', () => {
  const rules = platformRulesPart('work', '.agentdeck/notebook.agent.md')!;
  const parts = [part('task', 'T'), part('step', 'do'), rules];

  it('first call sends the brief and journals brief.sent; same parts again send nothing', () => {
    const { task, rows } = fakeTask();
    const w = createContextWiring({ homeRoot: home() });
    const first = w.opening(task, 's1', parts, 'work')!;
    expect(first.form).toBe('brief');
    expect(first.text).toContain('## reminder');
    expect(rows.map((r) => r.kind)).toEqual(['brief.sent']);
    expect(w.opening(task, 's1', parts, 'work')).toBeNull();
    expect(rows).toHaveLength(1);
  });

  it('a changed section goes as a delta; the rules section is never re-sent', () => {
    const { task } = fakeTask();
    const w = createContextWiring({ homeRoot: home() });
    w.opening(task, 's1', parts, 'work');
    const next = w.opening(task, 's1', [...parts, part('failing', 'unit: red')], 'work')!;
    expect(next.form).toBe('delta');
    expect(next.text.startsWith(`<${DELTA_TAG}>`)).toBe(true);
    expect(next.sections.map((s) => s.id)).toEqual(['failing']);
    expect(next.text).not.toContain('## reminder');
  });

  it('another session of the same task gets its own full brief', () => {
    const { task } = fakeTask();
    const w = createContextWiring({ homeRoot: home() });
    w.opening(task, 's1', parts, 'work');
    expect(w.opening(task, 's2', parts, 'work')?.form).toBe('brief');
  });

  it('refusal names the bin before any session; a brief within budget is no refusal', () => {
    const w = createContextWiring({ homeRoot: home() });
    expect(w.refusal([part('step', 'x'.repeat(5000))], 'work')).toMatch(
      /brief over budget for step kind work: step \(test\) fills the step bin/,
    );
    expect(w.refusal(parts, 'work')).toBeNull();
  });

  it('over budget throws BriefOverBudget and journals nothing', () => {
    const { task, rows } = fakeTask();
    const w = createContextWiring({ homeRoot: home() });
    expect(() => w.opening(task, 's1', [part('step', 'x'.repeat(5000))], 'work')).toThrow(
      BriefOverBudget,
    );
    expect(rows).toEqual([]);
  });
});

describe('createContextWiring.pack', () => {
  it('the same pack is not re-sent; a changed diff resends only that block', () => {
    const { task } = fakeTask();
    const w = createContextWiring({ homeRoot: home() });
    const input = {
      unitId: 'u1',
      baseRef: 'main',
      files: [{ path: 'a.txt', added: 1, deleted: 0, binary: false, diff: '+a' }],
      requirements: [{ id: 'r', ordinal: 1, text: 'a', verdict: 'unknown' }],
      records: [],
    };
    expect(w.pack(task, 's1', input)?.sections).toHaveLength(3);
    expect(w.pack(task, 's1', input)).toBeNull();
    const moved = { ...input, files: [{ ...input.files[0]!, diff: '+b' }] };
    expect(w.pack(task, 's1', moved)?.sections.map((s) => s.id)).toEqual(['review-pack:diff']);
  });
});

describe('createContextWiring.base and drift', () => {
  it('measures once, caches to the home, journals context.base once per task and key', async () => {
    const root = home();
    const { task, rows } = fakeTask();
    const w = createContextWiring({ homeRoot: root, now: () => 5 });
    let probes = 0;
    const probe = async () => {
      probes += 1;
      return { bodies: [JSON.stringify({ sys: 's'.repeat(400), m: 'MARK' })], brief: 'MARK' };
    };
    const a = await w.base(task, key, probe);
    const b = await w.base(task, key, probe);
    expect(a.ok && b.ok).toBe(true);
    expect(probes).toBe(1);
    expect(rows.filter((r) => r.kind === 'context.base')).toHaveLength(1);
    const cached = JSON.parse(readFileSync(join(root, 'cache', 'base-context.json'), 'utf8'));
    expect(cached.version).toBe(1);
  });

  it('first usage beyond 20 % raises context-drift and forgets the base; later turns are not judged', async () => {
    const root = home();
    const { task, rows } = fakeTask();
    const w = createContextWiring({ homeRoot: root });
    const probe = async () => ({ bodies: ['{"m":"MARK"}'], brief: 'MARK' });
    await w.base(task, key, probe);
    w.expect('s1', key, 1000, 400);
    const binding = { sessionId: 's1' } as SessionBinding;
    const usage = (input: number) =>
      ({ type: 'usage', input, output: 0, cacheRead: 0, cacheWrite: 0 }) as unknown as AdapterEvent;
    w.onEvent(task, binding, usage(2000));
    w.onEvent(task, binding, usage(9000));
    const drift = rows.filter((r) => r.kind === 'signal');
    expect(drift).toHaveLength(1);
    expect(drift[0]!.data).toMatchObject({ signal: 'context-drift', subject: 's1' });
    await new Promise((r) => setTimeout(r, 20));
    const cached = JSON.parse(readFileSync(join(root, 'cache', 'base-context.json'), 'utf8'));
    expect(Object.keys(cached.bases)).toEqual([]);
  });

  it('usage within 20 % raises nothing', () => {
    const { task, rows } = fakeTask();
    const w = createContextWiring({ homeRoot: home() });
    w.expect('s1', key, 1000, 400);
    w.onEvent(
      task,
      { sessionId: 's1' } as SessionBinding,
      {
        type: 'usage',
        input: 1050,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      } as unknown as AdapterEvent,
    );
    expect(rows).toEqual([]);
  });
});
