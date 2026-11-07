import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Promotion } from '@agentdeck/contracts/core/lead';
import {
  SOLO_UNIT,
  openFresh,
  tempDir,
  toolEventData,
} from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { END_REASON } from '../../conductor/next/index.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { decideTier } from '../tier.ts';
import { tierDecisionBody } from '../records.ts';
import type { AllowedRoute } from '../tier.types.ts';
import {
  learnFrom,
  learnedCachePath,
  learnedPathsFor,
  learnedResetsPath,
  keyOf,
  learnedFor,
  learnedRaiseOf,
  promotionOf,
  readLearned,
  resetLearnedKey,
  samplesOfJournal,
  upcastLearnedCache,
} from './index.ts';
import type { LearnedTable } from './learned.types.ts';
import type { FirstPassSample } from '@agentdeck/contracts/core/economy';

/**
 * Выученное (03:144-157): из ЗАКОНЧЕННЫХ журналов во временном доме ядра, настоящим писателем
 * журнала. Шаг под правкой человека не учит; первая попытка шага даёт пробу первого прохода
 * (этап 11, P140); кэш `<home>/cache/learned.json` — только ускорение, пересобирается из журналов.
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
    /** Причина конца шага (`step.ended.reason`), как её пишет дирижёр. */
    reason?: string;
    /** Строка `tier` журнала до этапа 11: без `learnedKey`. */
    legacy?: boolean;
  },
): { unitId: string; stepId: string } {
  const unitId = opts.unitId ?? newId();
  // Единица — строкой ядра, без лишнего шага: шаг ниже — первая попытка `work` в ней.
  if (!task.state.units[unitId])
    task.append({
      kind: 'unit.created',
      actor: 'core',
      unitId,
      data: {
        unitId,
        repoKey: 'r1',
        branch: `agentdeck/${unitId.slice(0, 8)}`,
        ownedPaths: [],
        ...SOLO_UNIT,
      },
    });
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
  if (opts.legacy) delete (body.output as Record<string, unknown>).learnedKey;
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
    data: { stepId: s.stepId, outcome: opts.outcome, basis: 'core', reason: opts.reason ?? 'test' },
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
  it('a lowered step that failed and a passing step: stats per key, each first attempt a first-pass probe', async () => {
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
    // Этап 11: каждая первая попытка шага — проба первого прохода ключа (роль вида шага),
    // по времени; другой модели проб нет. `lowerFailed` снят — подъём считает `promotionOf`.
    expect(table.firstPass?.[keyOf(KEY)]?.map((s) => s.passed)).toEqual([false, true]);
    expect(table.firstPass?.[keyOf({ ...KEY, model: 'model-b' })]).toBeUndefined();
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
    // Шаги под правкой человека не дают и проб: учит только свободный шаг.
    expect(learnFrom([samples!]).firstPass?.[keyOf(KEY)]?.map((s) => s.passed)).toEqual([true]);
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
    const first = await readLearned({ tasksDir, cacheFile, resetsFile: learnedResetsPath(home) });
    expect('value' in first && first.value).toMatchObject({
      skipped: 1,
      tasks: [{ taskId: a.taskId }],
    });
    expect(Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8')).journals)).toEqual([a.taskId]);
    writeFileSync(cacheFile, '{broken');
    const rebuilt = await readLearned({ tasksDir, cacheFile, resetsFile: learnedResetsPath(home) });
    expect(
      'value' in rebuilt && rebuilt.value.firstPass?.[keyOf(KEY)]?.map((s) => s.passed),
    ).toEqual([false]);
    // Кэш с задачей, которой уже нет: выпадает при следующем чтении.
    const ghost = newId();
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    cached.journals[ghost] = cached.journals[a.taskId];
    writeFileSync(cacheFile, JSON.stringify(cached));
    await readLearned({ tasksDir, cacheFile, resetsFile: learnedResetsPath(home) });
    expect(Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8')).journals)).toEqual([a.taskId]);
    expect(
      await readLearned({
        tasksDir: join(home, 'none'),
        cacheFile,
        resetsFile: learnedResetsPath(home),
      }),
    ).toMatchObject({
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
    const got = await readLearned(learnedPathsFor(tasksDir));
    expect('value' in got && got.value.toolMsP95).toEqual({ exec: 11_000 });
    for (const t of [a, b, open]) t.task.close();
  });

  it('stage 8 learned cache v1 (no toolMs) is recomputed from the journals and rewritten as v3', async () => {
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
    const got = await readLearned({ tasksDir, cacheFile, resetsFile: learnedResetsPath(home) });
    // 500…10 000 мс по 500: 19-й по порядку = 9 500.
    expect('value' in got && got.value.toolMsP95).toEqual({ wait: 9_500 });
    const written = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(written.version).toBe(3);
    expect(written.journals[a.taskId].toolMs.wait).toHaveLength(20);
  });
});

const PROMO: Promotion = { threshold: 0.85, window: 20, minSamples: 8 };

/** Пробы по порядку: `F` — первый проход не засчитан, `P` — засчитан; id `s<i>`. */
function probes(pattern: string, cls: FirstPassSample['class'] = null): FirstPassSample[] {
  return [...pattern].map((c, i) => ({
    sampleId: `s${i}`,
    at: 1_000 + i,
    passed: c === 'P',
    rung: 'sonnet·high',
    class: cls,
  }));
}

const passes = (pattern: string) => [...pattern].filter((c) => c === 'P').length;

describe('stage 11 W2-11 auto-promotion by first-pass rate (F1, P140)', () => {
  it('stage 11 first-pass probe: a step that went checked-red is not a first pass even when a later line closes it done', async () => {
    const { task, taskId } = await openFresh(tempDir('learned-red-'));
    const { stepId } = step(task, { outcome: 'done' });
    task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    const lines = readJournalLines(task.dir, taskId).lines;
    task.close();
    const passedOf = (ls: typeof lines) =>
      samplesOfJournal(taskId, ls)?.steps.map((s) => [s.firstPass?.sampleId, s.firstPass?.passed]);
    expect(passedOf(lines)).toEqual([[stepId, true]]);
    // Строка красной проверки шага до его конца (как её пишет `settle`): проход не первый.
    const end = lines.findIndex((l) => l.kind === 'step.ended');
    const red = {
      ...lines[end]!,
      kind: 'step.transition',
      data: { stepId, event: 'checked-red', from: 'checking', to: 'running' },
    } as (typeof lines)[number];
    expect(passedOf([...lines.slice(0, end), red, ...lines.slice(end)])).toEqual([[stepId, false]]);
  });

  it('stage 11 first-pass probe: a human or observer stop and a session refusal are not the rung failing — no probe, the next attempt is the first', async () => {
    const ends = {
      // Остановка человеком (`stop-step`) или наблюдателем — причина `stopped: <сигнал>: <шаг>`.
      stop: `${END_REASON.stopped}: observer.stall: s1`,
      // Дорога трижды не открыла сеанс — `no-outcome: session refused …`.
      refused: `${END_REASON.noOutcome}: session refused 3 times: route window closed`,
      // Модель кончила без заявления и правок — это провал ступени.
      own: `${END_REASON.noOutcome}: no edits, no step_done`,
      // Красный вердикт проверки — новый круг (`reenter-step`): тоже провал ступени.
      red: `${END_REASON.superseded}: red, round 1`,
    };
    const probesOf = async (first: string) => {
      const { task, taskId } = await openFresh(tempDir('learned-stop-'));
      const { unitId } = step(task, { outcome: 'failed', reason: first });
      const retry = step(task, { unitId, outcome: 'done' });
      task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
      const samples = samplesOfJournal(taskId, readJournalLines(task.dir, taskId).lines)!;
      task.close();
      return { retry: retry.stepId, got: learnFrom([samples]).firstPass?.[keyOf(KEY)] ?? [] };
    };
    for (const why of [ends.stop, ends.refused]) {
      const { retry, got } = await probesOf(why);
      expect(got.map((s) => [s.sampleId, s.passed])).toEqual([[retry, true]]);
    }
    // Контроль: собственный провал модели — проба «не прошёл», повтор первым не считается.
    for (const why of [ends.own, ends.red]) {
      const { got } = await probesOf(why);
      expect(got.map((s) => s.passed)).toEqual([false]);
    }
  });

  it('stage 11 promotionOf: 6/8 promotes, 7/8 does not, 7 samples do not, 17/20 (85 %) does not, 16/20 promotes', () => {
    expect(promotionOf(probes('PPPFPPPF'), PROMO)).toMatchObject({
      rungs: 1,
      evidence: ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'],
    });
    expect(promotionOf(probes('PPPPPPPF'), PROMO)).toMatchObject({
      rungs: 0,
      evidence: [],
      samples: 8,
    });
    expect(promotionOf(probes('FFFFFFF'), PROMO)).toMatchObject({ rungs: 0, rate: 0, samples: 7 });
    // 17/20: ни один префикс от 8 проб не ниже 85 % — подъёма нет и на пути к двадцатой.
    const at17 = `F${'P'.repeat(12)}F${'P'.repeat(5)}F`;
    expect([at17.length, passes(at17)]).toEqual([20, 17]);
    expect(promotionOf(probes(at17), PROMO)).toMatchObject({ rungs: 0, rate: 0.85, samples: 20 });
    // 16/20 (80 %) — подъём: ключ поднят не позже двадцатой пробы.
    const at16 = `F${'P'.repeat(12)}F${'P'.repeat(4)}FF`;
    expect([at16.length, passes(at16)]).toEqual([20, 16]);
    const got = promotionOf(probes(at16), PROMO);
    expect(got.rungs).toBe(1);
    // Суд идёт на каждой пробе: третий провал из 19 (84 %) уже ниже порога — окно подъёма — 19 id.
    expect(got.evidence).toEqual(
      probes(at16)
        .slice(0, 19)
        .map((s) => s.sampleId),
    );
  });

  it('stage 11 promotionOf: one window gives one rung; the next rung needs a fresh window of minSamples; passes never demote', () => {
    // Восемь провалов — одна ступень, не «тем больше, чем хуже»; ещё семь — окно не набрано.
    expect(promotionOf(probes('F'.repeat(8)), PROMO).rungs).toBe(1);
    expect(promotionOf(probes('F'.repeat(15)), PROMO)).toMatchObject({ rungs: 1, samples: 7 });
    const two = promotionOf(probes('F'.repeat(16)), PROMO);
    expect(two.rungs).toBe(2);
    expect(two.evidence).toEqual(['s8', 's9', 's10', 's11', 's12', 's13', 's14', 's15']);
    // Обратного хода нет: двадцать проходов после подъёма ступень не снимают.
    expect(promotionOf(probes(`${'F'.repeat(8)}${'P'.repeat(20)}`), PROMO)).toMatchObject({
      rungs: 1,
      rate: 1,
    });
    // Окно — последние 20: старые проходы не прячут свежие провалы (30 P + 4 F: 16/20 на 34-й).
    const late = promotionOf(probes(`${'P'.repeat(30)}${'F'.repeat(4)}`), PROMO);
    expect(late.rungs).toBe(1);
    expect(late.evidence[0]).toBe('s14');
  });

  it('stage 11 learnedRaiseOf: key+class when the class has >= minSamples, else the whole key; no samples is null', () => {
    const key = { ...KEY, role: 'implement' as const };
    const ofM = probes('P'.repeat(10), 'M').map((s, i) => ({
      ...s,
      sampleId: `m${i}`,
      at: 2_000 + i,
    }));
    const table: LearnedTable = {
      byKey: {},
      byKind: {},
      tasks: [],
      skipped: 0,
      firstPass: { [keyOf(key)]: [...probes('FFFFFFF', 'S'), ...ofM] },
    };
    // Класс S: 7 проб — меньше minSamples, откат на ключ целиком (7 провалов из первых 8 — подъём).
    expect(learnedRaiseOf(table, { key, class: 'S' }, PROMO)).toMatchObject({
      basis: 'key',
      rungs: 1,
    });
    // Класс M: 10 проходов своего класса — подъёма нет, хотя ключ целиком поднят.
    expect(learnedRaiseOf(table, { key, class: 'M' }, PROMO)).toMatchObject({
      basis: 'key+class',
      rungs: 0,
    });
    expect(
      learnedRaiseOf(table, { key: { ...key, model: 'model-b' }, class: null }, PROMO),
    ).toBeNull();
  });

  it('stage 11 learned.json v2 to v3 upcaster: row count equal, no stat lost, role = the step kind default; learned-reset drops earlier probes', async () => {
    const home = tempDir('learned-v2-');
    const tasksDir = join(home, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const a = await openFresh(tasksDir);
    step(a.task, { outcome: 'failed', lowered: true, tokens: 300 });
    step(a.task, { outcome: 'done', tokens: 100 });
    a.task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    a.task.close();
    const v3 = samplesOfJournal(a.taskId, readJournalLines(a.task.dir, a.taskId).lines)!;
    // Вклад формы v2: ключ без роли, пробы первого прохода нет.
    const v2 = {
      ...v3,
      steps: v3.steps.map(({ firstPass: _fp, key: { role: _role, ...key }, ...s }) => ({
        ...s,
        key,
      })),
    };
    const fixture = { version: 2, journals: { [a.taskId]: v2 } };
    const up = upcastLearnedCache(fixture)!;
    expect(up.version).toBe(3);
    expect(up.journals[a.taskId]!.steps).toHaveLength(v2.steps.length);
    expect(up.journals[a.taskId]!.steps.map((s) => s.key.role)).toEqual(['implement', 'implement']);
    expect(learnFrom(Object.values(up.journals)).byKey).toEqual(learnFrom([v3]).byKey);
    expect(learnFrom(Object.values(up.journals)).tasks).toEqual(learnFrom([v3]).tasks);
    expect(upcastLearnedCache({ version: 1, journals: {} })).toBeNull();
    // На диске: кэш v2 читается без пересборки и переписывается как v3.
    const cacheFile = learnedCachePath(home);
    mkdirSync(join(home, 'cache'), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(fixture));
    const read = await readLearned({ tasksDir, cacheFile, resetsFile: learnedResetsPath(home) });
    expect('value' in read && read.value.byKey).toEqual(learnFrom([v3]).byKey);
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).version).toBe(3);
    // Сброс человеком: пробы ключа до `at` не считаются, сброс переживает следующее чтение.
    // Вклад v2 проб не нёс — кэш с нуля, из журнала: пробы ключа есть до сброса.
    writeFileSync(cacheFile, '{broken');
    const before = await readLearned({ tasksDir, cacheFile, resetsFile: learnedResetsPath(home) });
    expect('value' in before && before.value.firstPass?.[keyOf(KEY)]).toHaveLength(2);
    const reset = { at: Number.MAX_SAFE_INTEGER, cmdId: 'c1' };
    resetLearnedKey(learnedResetsPath(home), keyOf(KEY), reset);
    const after = await readLearned({ tasksDir, cacheFile, resetsFile: learnedResetsPath(home) });
    expect('value' in after && after.value.firstPass?.[keyOf(KEY)]).toBeUndefined();
    expect('value' in after && after.value.resets?.[keyOf(KEY)]).toEqual(reset);
  });

  it('stage 11 a pre-stage-11 tier line (no learnedKey) learns under the step kind default role, the same row the upcaster gives', async () => {
    const { task, taskId } = await openFresh(tempDir('learned-legacy-'));
    step(task, { outcome: 'done', legacy: true });
    task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    const samples = samplesOfJournal(taskId, readJournalLines(task.dir, taskId).lines)!;
    task.close();
    expect(samples.steps.map((s) => s.key.role)).toEqual(['implement']);
    expect(Object.keys(learnFrom([samples]).byKey)).toEqual([keyOf(KEY)]);
  });

  it('stage 11 learned-reset is durable: survives a deleted, future-version and broken cache; resets a legacy cache carried migrate once; a broken resets file is unknown, never "no resets"', async () => {
    const home = tempDir('learned-reset-');
    const tasksDir = join(home, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const a = await openFresh(tasksDir);
    step(a.task, { outcome: 'failed', lowered: true, tokens: 300 });
    step(a.task, { outcome: 'done', tokens: 100 });
    a.task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    a.task.close();
    const paths = learnedPathsFor(tasksDir);
    expect(paths).toEqual({
      tasksDir,
      cacheFile: learnedCachePath(home),
      resetsFile: learnedResetsPath(home),
    });
    const row = keyOf(KEY);
    const before = await readLearned(paths);
    expect('value' in before && before.value.firstPass?.[row]).toHaveLength(2);
    const reset = { at: Number.MAX_SAFE_INTEGER, cmdId: 'c1' };
    resetLearnedKey(paths.resetsFile, row, reset);
    const stillReset = async () => {
      const got = await readLearned(paths);
      expect('value' in got && got.value.firstPass?.[row]).toBeUndefined();
      expect('value' in got && got.value.resets?.[row]).toEqual(reset);
    };
    await stillReset();
    // Кэш удалён — пересборка из журналов, сброс на месте.
    rmSync(paths.cacheFile);
    await stillReset();
    // Кэш версии, которую это ядро не знает (подъём версии), и битый кэш — то же.
    writeFileSync(paths.cacheFile, JSON.stringify({ version: 99, journals: {}, resets: {} }));
    await stillReset();
    writeFileSync(paths.cacheFile, '{broken');
    await stillReset();
    expect(JSON.parse(readFileSync(paths.cacheFile, 'utf8')).resets).toEqual({});
    // Кэш прежней сборки нёс сбросы в себе: переносятся в файл сбросов один раз, строка чужой
    // формы не переносится, кэш дальше их не несёт — и удаление кэша сброс не снимает.
    rmSync(paths.resetsFile);
    const legacy = { version: 3, journals: {}, resets: { [row]: reset, bad: { at: 'x' } } };
    writeFileSync(paths.cacheFile, JSON.stringify(legacy));
    await stillReset();
    expect(JSON.parse(readFileSync(paths.resetsFile, 'utf8'))).toEqual({
      version: 1,
      resets: { [row]: reset },
    });
    expect(JSON.parse(readFileSync(paths.cacheFile, 'utf8')).resets).toEqual({});
    rmSync(paths.cacheFile);
    await stillReset();
    // Битый файл сбросов — выученное неизвестно, а не молча снятый сброс.
    writeFileSync(paths.resetsFile, '{broken');
    expect('unknown' in (await readLearned(paths))).toBe(true);
  });
});
