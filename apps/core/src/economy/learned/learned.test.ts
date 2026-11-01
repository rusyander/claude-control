import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openFresh, tempDir, toolEventData } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { decideTier } from '../tier.ts';
import { tierDecisionBody } from '../records.ts';
import type { AllowedRoute } from '../tier.types.ts';
import {
  learnFrom,
  learnedCachePath,
  learnedFor,
  lowerFailed,
  readLearned,
  samplesOfJournal,
} from './index.ts';

/**
 * Выученное (03:144-157): из ЗАКОНЧЕННЫХ журналов во временном доме ядра, настоящим писателем
 * журнала. Шаг под правкой человека не учит; падение на пониженной модели помнится по ключу;
 * кэш `<home>/cache/learned.json` — только ускорение, пересобирается из журналов.
 */

const ROUTE: AllowedRoute = {
  adapter: 'claude',
  route: { kind: 'stub', id: 'stub-1' },
  modelPattern: '*',
};

/** Шаг: решение `tier` (как пишет его ядро), сеанс, один ход, конец шага. */
function step(
  task: LiveTask,
  opts: {
    unitId?: string;
    outcome: 'done' | 'failed';
    lowered?: boolean;
    override?: boolean;
    tokens?: number;
  },
): { unitId: string; stepId: string } {
  const unitId = opts.unitId ?? newId();
  if (!task.state.units[unitId]) seedSession(task, { stepKind: 'work', unitId }); // создаёт единицу; этот шаг ниже не кончается
  const tier = decideTier({
    taskId: task.taskId,
    unitId,
    stepId: null,
    stepModel: { tier: opts.lowered ? 'lower-if-mechanical' : 'ceiling' },
    allowed: [ROUTE],
    ceiling: 'model-b',
    overrides: [],
    stepKind: 'work',
    ladders: { claude: { models: ['model-a', 'model-b'], efforts: [] } },
  });
  const body = tierDecisionBody(tier);
  if (opts.override) (body.output as Record<string, unknown>).learning = 'override';
  task.append({
    kind: 'decision',
    actor: 'core',
    unitId,
    data: { decisionId: newId(), ...body },
  });
  const s = seedSession(task, { stepKind: 'work', unitId });
  task.append({
    kind: 'turn.usage',
    actor: 'core',
    sessionId: s.sessionId,
    data: {
      sessionId: s.sessionId,
      messageId: 'm1',
      input: opts.tokens ?? 100,
      cacheRead: 5_000,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 0,
      routeId: 'stub-1',
      model: 'model-a',
      subagent: false,
      parentSessionId: null,
      remainder: false,
    },
  });
  task.append({
    kind: 'step.ended',
    actor: 'core',
    stepId: s.stepId,
    data: { stepId: s.stepId, outcome: opts.outcome, basis: 'core', reason: 'test' },
  });
  return { unitId, stepId: s.stepId };
}

const KEY = {
  project: 'r1',
  stepKind: 'work',
  adapter: 'claude',
  route: 'stub-1',
  model: 'model-a',
};

describe('G7 learned: from finished journals in a throwaway core home', () => {
  it('a lowered step that failed is remembered: the key is never lowered again', async () => {
    const { task, taskId } = await openFresh(tempDir('learned-'));
    step(task, { outcome: 'failed', lowered: true, tokens: 300 });
    step(task, { outcome: 'done', tokens: 100 });
    // Незаконченная задача не учит: её шаги ещё идут.
    expect(samplesOfJournal(taskId, readJournalLines(task.dir, taskId).lines)).toBeNull();
    task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    const samples = samplesOfJournal(taskId, readJournalLines(task.dir, taskId).lines);
    expect(samples?.steps.map((s) => [s.outcome, s.lowered, s.tokens])).toEqual([
      ['failed', true, 300],
      ['done', false, 100],
    ]);
    const table = learnFrom([samples!]);
    expect(learnedFor(table, KEY)).toMatchObject({
      runs: 2,
      failures: 1,
      loweredFailures: 1,
      p90Tokens: 300,
    });
    expect(lowerFailed(table, KEY)).toBe(true);
    expect(lowerFailed(table, { ...KEY, model: 'model-b' })).toBe(false);
    task.close();
  });

  it('a step under a user override never teaches: neither by override.set nor by tier learning', async () => {
    const { task, taskId } = await openFresh(tempDir('learned-'));
    step(task, { outcome: 'failed', lowered: true, override: true });
    const free = step(task, { outcome: 'done', tokens: 777 });
    const unit = step(task, { outcome: 'failed', lowered: true });
    task.append({
      kind: 'override.set',
      actor: 'human:panel',
      data: {
        cmdId: newId(),
        scope: 'unit',
        scopeId: unit.unitId,
        field: 'model',
        value: 'model-a',
        timing: 'safe-point',
      },
    });
    task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    const samples = samplesOfJournal(taskId, readJournalLines(task.dir, taskId).lines);
    expect(samples?.steps.map((s) => [s.tokens, s.outcome])).toEqual([[777, 'done']]);
    expect(free.stepId).toBeTruthy();
    expect(samples?.task.tokens).toBeGreaterThan(0);
    expect(lowerFailed(learnFrom([samples!]), KEY)).toBe(false);
    task.close();
  });

  it('readLearned: journals → table, cache written; a broken cache is rebuilt, a gone task leaves it', async () => {
    const home = tempDir('learned-home-');
    const tasksDir = join(home, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const a = await openFresh(tasksDir);
    step(a.task, { outcome: 'failed', lowered: true });
    a.task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    a.task.close();
    const open = await openFresh(tasksDir);
    step(open.task, { outcome: 'done' });
    open.task.close();
    // Нечитаемый журнал не роняет остальных — назван в `skipped`.
    const bad = newId();
    mkdirSync(join(tasksDir, bad));
    writeFileSync(join(tasksDir, bad, 'journal.jsonl'), 'not json\n');
    const cacheFile = learnedCachePath(home);
    const first = await readLearned({ tasksDir, cacheFile });
    expect('value' in first && first.value).toMatchObject({
      skipped: 1,
      tasks: [{ taskId: a.taskId }],
    });
    expect(Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8')).journals)).toEqual([a.taskId]);
    writeFileSync(cacheFile, '{broken');
    const rebuilt = await readLearned({ tasksDir, cacheFile });
    expect('value' in rebuilt && lowerFailed(rebuilt.value, KEY)).toBe(true);
    // Кэш с задачей, которой уже нет: выпадает при следующем чтении.
    const ghost = newId();
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    cached.journals[ghost] = cached.journals[a.taskId];
    writeFileSync(cacheFile, JSON.stringify(cached));
    await readLearned({ tasksDir, cacheFile });
    expect(Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8')).journals)).toEqual([a.taskId]);
    expect(await readLearned({ tasksDir: join(home, 'none'), cacheFile })).toMatchObject({
      value: { tasks: [] },
    });
  });
});

/** Вызовы инструментов сессии: `count` строк `tool.event` класса `cls`, длительности 1…count × `unit`. */
function toolEvents(task: LiveTask, sessionId: string, cls: string, count: number, unit: number) {
  for (let i = 1; i <= count; i += 1)
    task.append({
      kind: 'tool.event',
      actor: 'core',
      sessionId,
      data: toolEventData(sessionId, `${cls}-${i}`, i * unit, {
        effectClass: cls,
        toolUseId: `toolu_${cls}_${i}_${newId()}`,
      }),
    });
}

describe('stage 8 learned tool-call p95 per effect class (F9 stall threshold)', () => {
  it('stage 8 learned toolMsP95: per effect class from finished journals tool.event.ms, p95 over all journals; a class under 20 samples is not learned; an unfinished journal does not teach', async () => {
    const tasksDir = join(tempDir('learned-tool-'), 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const a = await openFresh(tasksDir);
    const sa = seedSession(a.task, { stepKind: 'work' });
    toolEvents(a.task, sa.sessionId, 'exec', 12, 1_000);
    toolEvents(a.task, sa.sessionId, 'read', 19, 10);
    a.task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    const b = await openFresh(tasksDir);
    const sb = seedSession(b.task, { stepKind: 'work' });
    toolEvents(b.task, sb.sessionId, 'exec', 8, 1_000);
    b.task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    // Незаконченная задача: её 50 долгих вызовов не учат.
    const open = await openFresh(tasksDir);
    const so = seedSession(open.task, { stepKind: 'work' });
    toolEvents(open.task, so.sessionId, 'exec', 50, 100_000);
    const samplesA = samplesOfJournal(a.taskId, readJournalLines(a.task.dir, a.taskId).lines)!;
    expect(samplesA.toolMs.exec).toHaveLength(12);
    const samplesB = samplesOfJournal(b.taskId, readJournalLines(b.task.dir, b.taskId).lines)!;
    // exec: 1…12 с и 1…8 с — 20 образцов, p95 ближайшим рангом = 19-й по порядку = 11 с.
    expect(learnFrom([samplesA, samplesB]).toolMsP95).toEqual({ exec: 11_000 });
    expect(learnFrom([samplesA]).toolMsP95).toEqual({});
    const got = await readLearned({ tasksDir, cacheFile: learnedCachePath(join(tasksDir, '..')) });
    expect('value' in got && got.value.toolMsP95).toEqual({ exec: 11_000 });
    for (const t of [a, b, open]) t.task.close();
  });

  it('stage 8 learned cache v1 (no toolMs) is recomputed from the journals and rewritten as v2', async () => {
    const home = tempDir('learned-v1-');
    const tasksDir = join(home, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const a = await openFresh(tasksDir);
    const s = seedSession(a.task, { stepKind: 'work' });
    toolEvents(a.task, s.sessionId, 'wait', 20, 500);
    a.task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    a.task.close();
    const cacheFile = learnedCachePath(home);
    const stale = {
      steps: [],
      task: {
        taskId: a.taskId,
        projects: [],
        scenarioId: null,
        tokens: 0,
        activeMs: 0,
        outcome: 'done',
      },
    };
    mkdirSync(join(home, 'cache'), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ version: 1, journals: { [a.taskId]: stale } }));
    const got = await readLearned({ tasksDir, cacheFile });
    // 500…10 000 мс по 500: 19-й по порядку = 9 500.
    expect('value' in got && got.value.toolMsP95).toEqual({ wait: 9_500 });
    const written = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(written.version).toBe(2);
    expect(written.journals[a.taskId].toolMs.wait).toHaveLength(20);
  });
});
