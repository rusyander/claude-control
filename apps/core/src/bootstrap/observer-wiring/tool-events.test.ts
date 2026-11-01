import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import type {
  AdapterEvent,
  CliAdapter,
  PermissionAsk,
  RawToolCall,
  SessionHandle,
} from '../../adapters/index.ts';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { currentOs } from '../../platform/os-kind.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import { createSessionRuntime } from '../session-runtime.ts';
import { canonicalPath } from './effect-class.ts';
import type { ObserverTap } from './observer-wiring.types.ts';
import { argvDigestOf, createToolEventTap, errorDigestOf } from './tool-events.ts';

/**
 * Кран фактов вызовов (этап 8, зона W) через НАСТОЯЩИЙ рантайм сессии и журнал задачи: пара
 * `tool.requested` → `tool.result` — одна строка `tool.event` с классом, каноническими целью и
 * каталогом, отпечатками argv, файла и ошибки, исходом из структурного поля. История
 * прикреплённой заново сессии и уже записанный вызов второй строкой не становятся.
 */

const CONTEXT: PermitContext = {
  copyRoot: '/copy',
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

const OS = currentOs();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const requested = (
  toolUseId: string,
  name: string,
  input: unknown,
  parentToolUseId?: string | null,
): AdapterEvent => ({
  type: 'tool.requested',
  toolUseId,
  name,
  input,
  cliInitiated: false,
  ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
});

const result = (
  toolUseId: string,
  outcome?: { exitCode: number | null; errorText: string | null },
): AdapterEvent => ({
  type: 'tool.result',
  toolUseId,
  isError: outcome !== undefined && (outcome.exitCode ?? 1) !== 0,
  cliInitiated: false,
  ...(outcome ? { outcome: { ...outcome, bytes: null } } : {}),
});

const bash = (id: string, command: string, exitCode = 0, errorText: string | null = null) => [
  requested(id, 'Bash', { command }),
  result(id, { exitCode, errorText }),
];

function adapterOf(events: AdapterEvent[]): CliAdapter {
  return {
    id: 'fake',
    events: async function* () {
      for (const event of events) yield event;
    },
    mapPermission: () => ({ action: 'other', target: '', tool: '', display: '' }),
  } as unknown as CliAdapter;
}

/** Переходник, который окна чтения не знает (поля `range` нет): так видится чужой CLI. */
const noRange = (raw: RawToolCall): PermissionAsk => {
  const { range: _range, ...ask } = mapClaudePermission(raw);
  return ask;
};

async function stream(
  task: LiveTask,
  sessionId: string,
  tap: ObserverTap,
  events: AdapterEvent[],
  resume: { resumed?: boolean; replayed?: number } = {},
) {
  const got = bindingOf(task, sessionId);
  if (!('binding' in got)) throw new Error(got.reason);
  const notes: string[] = [];
  await createSessionRuntime({ note: (e) => notes.push(e), observer: tap }).attach({
    task,
    binding: got.binding,
    adapter: adapterOf(events),
    handle: { sessionId } as SessionHandle,
    context: CONTEXT,
    onEvent: () => {},
    ...resume,
  }).done;
  expect(notes.filter((n) => n === 'observer.tap.failed')).toEqual([]);
  return got.binding.stepId;
}

const toolEvents = (task: LiveTask) =>
  readJournalLines(task.dir, task.taskId).lines.filter(
    (l): l is JournalLine<'tool.event'> => l.kind === 'tool.event',
  );

async function fixture(map: (raw: RawToolCall) => PermissionAsk = mapClaudePermission) {
  const registry = createTaskRegistry(tempDir('tool-ev-'), deps());
  const task = await registry.create(CREATED);
  const { sessionId } = seedSession(task, { stepKind: 'work' });
  const cwd = tempDir('tool-ev-copy-');
  let clock = 1_000;
  const tap = (extra: { history?: (t: LiveTask) => readonly JournalLine[] } = {}) =>
    createToolEventTap({
      sessionOf: () => ({ mapPermission: map, cwd }),
      now: () => (clock += 250),
      ...extra,
    });
  return { registry, task, sessionId, cwd, tap };
}

describe('stage 8 tool event tap (session runtime → journal)', () => {
  it('a whole-file shell read journals class, canonical target and cwd, file fingerprint, size and outcome', async () => {
    const { registry, task, sessionId, cwd, tap } = await fixture();
    const body = 'x'.repeat(64 * 1024);
    writeFileSync(join(cwd, 'README.md'), body);
    const stepId = await stream(task, sessionId, tap(), bash('t1', 'cat README.md'));
    const [row] = toolEvents(task);
    expect(row).toMatchObject({ actor: `session:${sessionId}`, stepId, sessionId });
    expect(row?.data).toEqual({
      sessionId,
      toolUseId: 't1',
      parentToolUseId: null,
      tool: 'Bash',
      effectClass: 'read',
      target: canonicalPath('README.md', cwd, OS),
      argvDigest: argvDigestOf([['cat', 'README.md']]),
      cwd: canonicalPath(cwd, null, OS),
      range: null,
      fileFp: `sha256:${sha(body)}`,
      sizeBytes: 64 * 1024,
      isError: false,
      exitCode: 0,
      errorDigest: null,
      ms: 250,
      display: 'cat README.md',
    });
    registry.closeAll();
  });

  it('a failing exec carries exit code and an error digest that ignores CRLF and edge spaces', async () => {
    const { registry, task, sessionId, tap } = await fixture();
    await stream(task, sessionId, tap(), [
      ...bash('t1', 'node -e process.exitCode=3', 3, ' boom\r\nline2 \r\n'),
      ...bash('t2', 'node -e process.exitCode=3', 3, 'boom\nline2'),
    ]);
    const [a, b] = toolEvents(task).map((r) => r.data);
    expect(a).toMatchObject({ effectClass: 'exec', isError: true, exitCode: 3 });
    expect(a?.errorDigest).toBe(sha('boom\nline2'));
    expect(b?.errorDigest).toBe(a?.errorDigest);
    expect(b?.argvDigest).toBe(a?.argvDigest);
    // Маска DLP — до отпечатка: секрет в тексте ошибки в отпечаток не попадает как есть.
    const mask = (t: string) => ({ text: t.replace(/s3cret/g, '***') }) as never;
    expect(errorDigestOf('key s3cret', mask)).toBe(sha('key ***'));
    expect(errorDigestOf('  \r\n', mask)).toBeNull();
    registry.closeAll();
  });

  it('read windows: an unknown window has no fingerprint, a stated window has one, a failed read none', async () => {
    const unknown = await fixture(noRange);
    writeFileSync(join(unknown.cwd, 'a.ts'), 'abc');
    await stream(unknown.task, unknown.sessionId, unknown.tap(), [
      requested('r1', 'Read', { file_path: join(unknown.cwd, 'a.ts') }),
      result('r1'),
    ]);
    expect(toolEvents(unknown.task)[0]?.data).toMatchObject({
      effectClass: 'read',
      range: null,
      fileFp: null,
      sizeBytes: null,
    });
    unknown.registry.closeAll();

    // Настоящий переходник Claude: `offset`/`limit` Read — окно (зона M).
    const known = await fixture();
    writeFileSync(join(known.cwd, 'a.ts'), 'abc');
    await stream(known.task, known.sessionId, known.tap(), [
      requested('r1', 'Read', { file_path: join(known.cwd, 'a.ts'), offset: 1, limit: 2 }, 'p1'),
      result('r1'),
      requested('r2', 'Read', { file_path: join(known.cwd, 'missing.ts') }),
      { type: 'tool.result', toolUseId: 'r2', isError: true, cliInitiated: false },
      requested('r3', 'Read', { file_path: join(known.cwd, 'a.ts') }),
      result('r3'),
    ]);
    const [ranged, failed, whole] = toolEvents(known.task).map((r) => r.data);
    expect(whole).toMatchObject({ range: null, fileFp: `sha256:${sha('abc')}`, sizeBytes: 3 });
    expect(ranged).toMatchObject({
      parentToolUseId: 'p1',
      range: { offset: 1, limit: 2 },
      fileFp: `sha256:${sha('abc')}`,
      sizeBytes: 3,
    });
    expect(failed).toMatchObject({
      isError: true,
      fileFp: null,
      exitCode: null,
      errorDigest: null,
    });
    known.registry.closeAll();
  });

  it('history of a reattached session and an already journaled call never journal a second row', async () => {
    const { registry, task, sessionId, tap } = await fixture();
    const first = [...bash('t1', 'ls'), ...bash('t2', 'sleep 30')];
    await stream(task, sessionId, tap(), first);
    expect(toolEvents(task).map((r) => r.data.toolUseId)).toEqual(['t1', 't2']);
    // Новое ядро: поток начинается с истории (4 события), затем живой вызов t3.
    const reads: string[] = [];
    const fresh = tap({
      history: (t) => {
        reads.push(t.taskId);
        return readJournalLines(t.dir, t.taskId).lines;
      },
    });
    await stream(task, sessionId, fresh, [...first, ...bash('t3', 'pwd')], {
      resumed: true,
      replayed: 4,
    });
    expect(toolEvents(task).map((r) => r.data.toolUseId)).toEqual(['t1', 't2', 't3']);
    // Ядро упало между строкой и концом истории: история короче, вызовы t2 (строка прошлого
    // ядра) и t3 (строка этого же крана) приходят «живыми».
    await stream(
      task,
      sessionId,
      fresh,
      [...bash('t2', 'sleep 30'), ...bash('t3', 'pwd'), ...bash('t4', 'id')],
      { resumed: true, replayed: 0 },
    );
    expect(toolEvents(task).map((r) => [r.data.toolUseId, r.data.effectClass])).toEqual([
      ['t1', 'exec'],
      ['t2', 'wait'],
      ['t3', 'exec'],
      ['t4', 'exec'],
    ]);
    // Вызов истории, чья строка потеряна в крахе, не дописывается задним числом: время и
    // отпечаток файла были бы сегодняшними, не того вызова (недосрабатывание, не ложный факт).
    await stream(task, sessionId, fresh, [...bash('t9', 'ls'), ...bash('t5', 'id')], {
      resumed: true,
      replayed: 2,
    });
    expect(toolEvents(task).map((r) => r.data.toolUseId)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    // Журнал прочитан один раз на открытую задачу, не на каждое событие.
    expect(reads).toEqual([task.taskId]);
    registry.closeAll();
  });

  it('W P-c a refusal of the CLI itself journals one denied row beside the call row; the same id twice, a refusal without an id or not denied, and a reattached history journal no second row', async () => {
    const { registry, task, sessionId, cwd, tap } = await fixture();
    const ask = (toolUseId?: string, denied = true): AdapterEvent => ({
      type: 'ask',
      ask: mapClaudePermission({ tool: 'Read', input: { file_path: 'secret.txt' } }),
      denied,
      ...(toolUseId ? { toolUseId } : {}),
    });
    await stream(task, sessionId, tap(), [
      requested('t1', 'Read', { file_path: 'secret.txt' }),
      result('t1', { exitCode: null, errorText: 'Permission denied' }),
      ask('t1'),
      ask('t1'),
      ask(),
      ask('t2', false),
    ]);
    const rows = toolEvents(task);
    expect(rows.map((r) => [r.data.toolUseId, r.data.denied ?? false])).toEqual([
      ['t1', false],
      ['t1', true],
    ]);
    expect(rows[1]?.data).toMatchObject({
      tool: 'Read',
      effectClass: 'read',
      target: canonicalPath('secret.txt', cwd, OS),
      isError: true,
      ms: 0,
      fileFp: null,
    });
    // Ядро перезапущено: набор записанных пересобран из журнала — строка отказа не повторяется.
    await stream(task, sessionId, tap(), [ask('t1')]);
    expect(toolEvents(task)).toHaveLength(2);
    registry.closeAll();
  });

  it('a result with no request, or a session the core does not know, journals nothing', async () => {
    const { registry, task, sessionId } = await fixture();
    const tap = createToolEventTap({ sessionOf: () => undefined, now: () => 0 });
    await stream(task, sessionId, tap, [result('orphan'), ...bash('t1', 'ls')]);
    expect(toolEvents(task)).toEqual([]);
    registry.closeAll();
  });
});
