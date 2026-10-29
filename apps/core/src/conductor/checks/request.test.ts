import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { argvFor } from '../../verifier/run/argv.ts';
import { fixtureRegistry, fixtureRows, otherBlob } from '../../verifier/__fixtures__/registry.ts';
import {
  checkEntry,
  checkRegistry,
  makeHarness,
  TASK,
  type Harness,
} from './__fixtures__/harness.ts';
import { idlePreRun, preRunCandidates } from './idle.ts';
import { modelCheck } from './model-tool.ts';
import { changedUnitsOf } from './scope.ts';

/**
 * Единый вход проверки (G21) на настоящих очереди, хранилище, судье и дочернем процессе. Каждое
 * свойство называет, что видит вызывающий (ответ) и что осталось в доказательствах (число
 * запусков процесса, записи хранилища, строки журнала задачи по схеме журнала).
 */

const open: Harness[] = [];
async function harness(options?: Parameters<typeof makeHarness>[0]): Promise<Harness> {
  const h = await makeHarness(options);
  open.push(h);
  return h;
}
afterEach(() => {
  for (const h of open.splice(0)) h.close();
});

const kinds = (h: Harness): string[] => h.journal.map((j) => j.kind);
const transitions = (h: Harness, checkRunId: string): string[] =>
  h.journal
    .filter((j) => j.kind === 'check.transition' && 'checkRunId' in j.data)
    .filter((j) => (j.data as { checkRunId: string }).checkRunId === checkRunId)
    .map((j) => `${(j.data as { from: string }).from}>${(j.data as { to: string }).to}`);

describe('conductor/checks requestCheck', () => {
  it('P02 run then replay: a green unit runs once, the same tree replays its record on every road', async () => {
    const h = await harness();
    h.mode('pass');
    const first = await h.service.requestCheck(h.req());
    expect(first.kind).toBe('ran');
    if (first.kind !== 'ran') return;
    expect(first.verdict.kind).toBe('pass');
    expect(first.recordId).not.toBeNull();
    expect(h.spawns()).toEqual([['app']]);
    expect(transitions(h, first.checkRunId)).toEqual([
      'queued>leased',
      'leased>running',
      'running>recorded',
    ]);
    for (const road of ['conductor', 'model-tool', 'capture-wrapper', 'idle-prerun'] as const) {
      const again = await h.service.requestCheck(h.req({ road }));
      expect(again).toMatchObject({ kind: 'replay', recordId: first.recordId, verdict: 'pass' });
    }
    expect(h.spawns()).toHaveLength(1);
    expect(h.badLines).toEqual([]);
    expect(kinds(h)).toContain('check.recorded');
  });

  it('P02 red replay: an unchanged red static check replays its red record, an edit inside the unit runs again', async () => {
    const h = await harness();
    h.mode('fail');
    const first = await h.service.requestCheck(h.req({ checkId: 'lint' }));
    expect(first).toMatchObject({ kind: 'ran', verdict: { kind: 'fail', reason: 'red' } });
    const again = await h.service.requestCheck(h.req({ checkId: 'lint' }));
    expect(again.kind).toBe('replay');
    if (again.kind !== 'replay' || first.kind !== 'ran') return;
    expect(again.recordId).toBe(first.recordId);
    expect(again.verdict).toBe('fail');
    expect(again.header).toContain('unchanged since');
    expect(h.spawns()).toHaveLength(1);
    // Путь вне замыкания единицы — ключ тот же, повтор; путь внутри — новый ключ, прогон.
    h.edit({ 'README.md': { blob: 'f'.repeat(40) } });
    expect((await h.service.requestCheck(h.req({ checkId: 'lint' }))).kind).toBe('replay');
    h.mode('pass');
    h.edit({ 'apps/app/main.ts': { blob: 'e'.repeat(40) } });
    const edited = await h.service.requestCheck(h.req({ checkId: 'lint' }));
    expect(edited).toMatchObject({ kind: 'ran', verdict: { kind: 'pass' } });
    expect(h.spawns()).toHaveLength(2);
  });

  it('P02 absent: a check missing from the registry answers fail{absent} with one record, never green', async () => {
    const h = await harness();
    const first = await h.service.requestCheck(h.req({ checkId: 'nope' }));
    expect(first.kind).toBe('absent');
    const again = await h.service.requestCheck(h.req({ checkId: 'nope', road: 'model-tool' }));
    expect(again).toEqual(first);
    if (first.kind !== 'absent') return;
    const rec = h.store.record(first.recordId);
    expect('value' in rec && rec.value.verdict).toEqual({ kind: 'fail', reason: 'absent' });
    expect(h.spawns()).toEqual([]);
  });

  it('P02 session record: a caller-run record replays only on capture roads, the core road runs itself', async () => {
    const h = await harness();
    const leased = await h.service.requestCheck(
      h.req({ road: 'capture-wrapper', origin: 'session', exec: 'caller' }),
    );
    expect(leased.kind).toBe('leased');
    if (leased.kind !== 'leased') return;
    expect(leased.argv).toEqual(
      argvFor(checkEntry(), { unit: 'app', selection: [], base: null, files: [] }).argv,
    );
    expect(h.service.pending()).toEqual([leased.checkRunId]);
    // Пока вызывающий гонит, слот занят его арендой.
    const held = await h.queue.inflight('p', h.keyFor('tests', 'app'));
    expect('value' in held && held.value?.checkRunId).toBe(leased.checkRunId);
    const done = await h.service.completeCheck(leased.checkRunId, { exit: 0, ms: 12, log: 'ok\n' });
    expect(done).toMatchObject({ kind: 'ran', verdict: { kind: 'pass' } });
    expect(h.service.pending()).toEqual([]);
    if (done.kind !== 'ran') return;
    const capture = await h.service.requestCheck(h.req({ road: 'capture-preload' }));
    expect(capture).toMatchObject({ kind: 'replay', recordId: done.recordId });
    h.mode('pass');
    const core = await h.service.requestCheck(h.req({ road: 'conductor' }));
    expect(core.kind).toBe('ran');
    expect(h.spawns()).toHaveLength(1);
    // Повторный ответ на снятый прогон — отказ с названием, а не вторая запись.
    const late = await h.service.completeCheck(leased.checkRunId, { exit: 0, ms: 1, log: '' });
    expect(late.kind).toBe('refuse');
  });

  it('P02 model tool and capture road get one decision for the same argv', async () => {
    const h = await harness();
    h.mode('pass');
    const argv = argvFor(checkEntry(), {
      unit: 'app',
      selection: [],
      base: null,
      files: [],
    }).argv;
    const reply = await modelCheck(
      h.service,
      { argv },
      {
        taskId: TASK,
        stepId: '0192f000-0000-7000-8000-0000000000bb',
        project: 'p',
        copyDir: h.req().copyDir,
        class: 'work',
        phase: 'final',
        registryUnits: ['app', 'admin', 'shared'],
        changedUnits: ['app'],
        packageChecks: ['tests', 'lint'],
      },
      30_000,
    );
    expect(reply.verdict).toBe('pass');
    const capture = await h.service.requestCheck(
      h.req({ road: 'capture-wrapper', checkId: undefined, argv, unit: '' }),
    );
    expect(capture).toMatchObject({ kind: 'replay', recordId: reply.recordId });
    // argv узнан как запись реестра tests@app, а не производная `captured:` — дирижёр по id
    // получает ту же запись.
    const rec = h.store.record(reply.recordId ?? '');
    expect('value' in rec && [rec.value.checkId, rec.value.unit]).toEqual(['tests', 'app']);
    const byId = await h.service.requestCheck(h.req());
    expect(byId).toMatchObject({ kind: 'replay', recordId: reply.recordId });
    expect(h.spawns()).toHaveLength(1);
  });

  it('project check: asked for one unit it runs on the whole copy, keyed by the whole tree', async () => {
    const h = await harness();
    h.mode('pass');
    const first = await h.service.requestCheck(h.req({ checkId: 'whole', unit: 'app' }));
    expect(first).toMatchObject({ kind: 'ran', verdict: { kind: 'pass' } });
    expect(h.spawns()).toEqual([['--whole']]);
    // Тот же запрос от другой единицы — тот же ключ всей копии.
    expect((await h.service.requestCheck(h.req({ checkId: 'whole', unit: 'admin' }))).kind).toBe(
      'replay',
    );
    // Правка вне любой единицы меняет ключ проверки проекта.
    h.edit({ 'README.md': { blob: 'f'.repeat(40) } });
    const edited = await h.service.requestCheck(h.req({ checkId: 'whole', unit: 'app' }));
    expect(edited.kind).toBe('ran');
    expect(h.spawns()).toHaveLength(2);
    // Посреди работы проверка проекта не сужается до «изменённых единиц».
    h.edit({ 'README.md': { blob: 'e'.repeat(40) } });
    const mid = await h.service.requestCheck(
      h.req({ checkId: 'whole', unit: 'app', phase: 'mid-task', changedUnits: [] }),
    );
    expect(mid.kind).toBe('ran');
  });

  it('changed units: a path in a consumed unit changes its consumers, machinery changes all, a path outside units none', () => {
    const reg = checkRegistry();
    const base = fixtureRows();
    const at = (path: string) =>
      changedUnitsOf(reg, fixtureRows({ [path]: { blob: otherBlob } }), base);
    expect(changedUnitsOf(reg, base, base)).toEqual([]);
    expect(at('apps/admin/main.ts')).toEqual(['admin']);
    expect(at('packages/shared/index.ts')).toEqual(['app', 'shared']);
    expect(at('tools/gate.mjs')).toEqual(['admin', 'app', 'shared']);
    expect(at('README.md')).toEqual([]);
    // Удалённый путь — тоже изменение.
    expect(
      changedUnitsOf(
        reg,
        base.filter((r) => r.path !== 'apps/app/main.ts'),
        base,
      ),
    ).toEqual(['app']);
  });

  it('mid-task narrow: an untouched unit is not run mid-task, the changed units are named', async () => {
    const h = await harness();
    const answer = await h.service.requestCheck(
      h.req({ phase: 'mid-task', unit: 'admin', changedUnits: ['app'] }),
    );
    expect(answer).toMatchObject({ kind: 'narrow', units: ['app'] });
    expect(h.spawns()).toEqual([]);
  });

  it('P68 one key one run: two concurrent requests spawn the check once and share its record', async () => {
    const h = await harness();
    h.mode('slow', 1_200);
    const [a, b] = await Promise.all([
      h.service.requestCheck(h.req()),
      h.service.requestCheck(h.req({ road: 'model-tool' })),
    ]);
    expect(h.spawns()).toHaveLength(1);
    const ids = [a, b].map((x) => ('recordId' in x ? x.recordId : null));
    expect(ids[0]).not.toBeNull();
    expect(ids[0]).toBe(ids[1]);
    expect([a.kind, b.kind].sort()).toEqual(['ran', 'replay']);
    // Ждавший записал своё решение `wait` в журнал, прежде чем получить повтор.
    const outputs = h.journal
      .filter((j) => j.kind === 'decision')
      .map((j) => (j.data as unknown as { output: { kind: string } }).output.kind);
    expect(outputs).toContain('wait');
  });

  it('P68 answer budget: a wait longer than the budget answers running with the holder run id', async () => {
    const h = await harness({ answerBudgetMs: 300 });
    const key = h.keyFor('tests', 'app');
    const claim = await h.queue.claimInflight('p', key, '0192f000-0000-7000-8000-0000000000cc');
    expect(claim.claimed).toBe(true);
    const answer = await h.service.requestCheck(h.req());
    expect(answer).toMatchObject({
      kind: 'running',
      checkRunId: '0192f000-0000-7000-8000-0000000000cc',
    });
    expect(h.spawns()).toEqual([]);
  });

  it('lock-timeout: a holder past max(2x learned, 10 min) is waited out, the run goes ahead and the journal names lock-timeout', async () => {
    const h = await harness({ shiftMs: 11 * 60_000 });
    h.mode('pass');
    const key = h.keyFor('tests', 'app');
    const claim = await h.queue.claimInflight('p', key, '0192f000-0000-7000-8000-0000000000dd');
    expect(claim.claimed).toBe(true);
    const answer = await h.service.requestCheck(h.req());
    expect(answer).toMatchObject({ kind: 'ran', verdict: { kind: 'pass' } });
    expect(h.spawns()).toHaveLength(1);
    const reasons = h.journal
      .filter((j) => j.kind === 'decision')
      .flatMap((j) => (j.data as { reasons: string[] }).reasons);
    expect(reasons).toContain('lock-timeout');
    expect(h.badLines).toEqual([]);
  });

  it('G4 flaky: a red test passing alone on retry records pass-flaky and quarantines the test, then replays', async () => {
    const h = await harness();
    h.mode('flaky');
    const answer = await h.service.requestCheck(h.req());
    expect(answer).toMatchObject({ kind: 'ran', verdict: { kind: 'pass-flaky' } });
    // Имя «suite > breaks» уходит в фильтр регуляркой полного имени vitest (пробел у v4, « > » у v5).
    expect(h.spawns()).toEqual([['app'], ['app', '--tests', 'suite(?: > | )breaks']]);
    expect(h.quarantine.map((q) => q.test)).toEqual(['suite > breaks']);
    const again = await h.service.requestCheck(h.req());
    expect(again).toMatchObject({ kind: 'replay', verdict: 'pass-flaky' });
    expect(h.spawns()).toHaveLength(2);
  });

  it('G4 red stays red: two red retries leave the unit red and replay it unchanged', async () => {
    const h = await harness();
    h.mode('fail');
    const answer = await h.service.requestCheck(h.req());
    expect(answer).toMatchObject({ kind: 'ran', verdict: { kind: 'fail', reason: 'red' } });
    expect(h.spawns()).toHaveLength(3);
    expect(h.quarantine).toEqual([]);
    const again = await h.service.requestCheck(h.req());
    expect(again).toMatchObject({ kind: 'replay', verdict: 'fail' });
    expect(h.spawns()).toHaveLength(3);
  });

  it('G2 env pin unknown: the leased run still writes a no-verdict record, never a pass', async () => {
    const h = await harness({ env: 'unknown' });
    const answer = await h.service.requestCheck(h.req());
    expect(answer).toMatchObject({ kind: 'ran', verdict: { kind: 'no-verdict' } });
    expect(h.spawns()).toEqual([]);
    if (answer.kind !== 'ran') return;
    expect(answer.recordId).not.toBeNull();
    expect(transitions(h, answer.checkRunId)).toEqual(['queued>leased', 'leased>no-verdict']);
  });

  it('P03 disk blocker defers, an unreadable registry refuses by name', async () => {
    const h = await harness({
      blockers: [{ code: 'disk', subject: 'free 1 bytes', next: 'free disk space' }],
    });
    expect(await h.service.requestCheck(h.req())).toMatchObject({ kind: 'defer', until: 'disk' });
    const u = await harness({ registry: { unknown: 'profile unreadable' } });
    const refused = await u.service.requestCheck(u.req());
    expect(refused).toMatchObject({
      kind: 'refuse',
      unmet: [{ code: 'registry-unreadable', subject: 'profile unreadable' }],
    });
    expect(h.spawns()).toEqual([]);
    expect(u.spawns()).toEqual([]);
  });

  it('P40 temp: every run removes its temp dir', async () => {
    const h = await harness();
    h.mode('pass');
    expect(existsSync(h.tempRoot)).toBe(false);
    await h.service.requestCheck(h.req());
    // Каталог завёл сам прогон (стенд его не создаёт): временное — под `tempRoot`, а не в os.tmpdir().
    expect(existsSync(h.tempRoot)).toBe(true);
    expect(readdirSync(h.tempRoot)).toEqual([]);
  });

  it('P101 idle pre-run: finished units run in idle time, the final request replays without a second run', async () => {
    const h = await harness();
    h.mode('pass');
    const reg = checkRegistry();
    const pre = await idlePreRun(
      h.service,
      h.queue,
      preRunCandidates(reg, {
        taskId: TASK,
        project: 'p',
        copyDir: h.req().copyDir,
        finishedUnits: ['app'],
      }),
    );
    expect(pre.stopped).toBeUndefined();
    expect(pre.answers.map((a) => [a.req.checkId, a.answer.kind])).toEqual([
      ['tests', 'ran'],
      ['lint', 'ran'],
    ]);
    expect(h.spawns()).toHaveLength(2);
    const final = await h.service.requestCheck(h.req());
    expect(final.kind).toBe('replay');
    const finalLint = await h.service.requestCheck(h.req({ checkId: 'lint' }));
    expect(finalLint.kind).toBe('replay');
    expect(h.spawns()).toHaveLength(2);
  });

  // Настоящий vitest в temp-каталоге: вложенный тест выбирается полным именем «a > b > it».
  const VITEST = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
  const NESTED = [
    "describe('outer', () => {",
    "  describe('inner', () => {",
    "    it('target', () => { expect(1).toBe(1); });",
    "    it('other', () => { expect(1).toBe(1); });",
    '  });',
    '});',
    '',
  ].join('\n');
  async function realVitest(): Promise<Harness> {
    const entry = checkEntry({
      argv: [process.execPath, VITEST, 'run', '--root', '.', '--globals'],
      filter: {
        kind: 'vitest',
        // репортёр — как в шаблоне профиля (verifier/profile/js.ts): имена прошедших в выводе
        argv: [
          process.execPath,
          VITEST,
          'run',
          '--root',
          '.',
          '--globals',
          '--reporter=verbose',
          '-t',
          '{tests}',
        ],
      },
    });
    const h = await harness({ registry: { value: fixtureRegistry({ checks: [entry] }) } });
    writeFileSync(join(h.req().copyDir, 'a.test.ts'), NESTED);
    return h;
  }
  // Итог vitest приходит в цветах терминала: ESC собран из кода символа (правило о control-символах).
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
  const passedOf = (log: string): string | undefined =>
    /^\s*Tests\s+(.+)$/m.exec(log.replace(ANSI, ''))?.[1];

  it('{tests} narrow on real vitest: a nested full name selects exactly that one test and passes', async () => {
    const h = await realVitest();
    const answer = await h.service.requestCheck(h.req({ selection: ['outer > inner > target'] }));
    expect(answer).toMatchObject({ kind: 'ran', verdict: { kind: 'pass' } });
    const rec = h.store.record((answer as { recordId: string }).recordId);
    if (!('value' in rec)) throw new Error('record missing');
    expect(rec.value.argv.slice(-2)).toEqual(['-t', 'outer(?: > | )inner(?: > | )target']);
    const log = h.store.log((answer as { recordId: string }).recordId);
    if (!('value' in log)) throw new Error('log missing');
    expect(passedOf(log.value)).toMatch(/^1 passed \| 1 skipped/);
    // запись называет исполненный тест — по нему кейс и получает «прошёл» (P50), пропущенный — нет
    expect(rec.value.passing).toEqual([{ file: 'a.test.ts', name: 'outer > inner > target' }]);
  }, 60_000);

  it('{tests} narrow on real vitest: a selection matching no test is no-verdict with a note, never a pass', async () => {
    const h = await realVitest();
    const answer = await h.service.requestCheck(h.req({ selection: ['outer > inner > nothing'] }));
    expect(answer).toMatchObject({
      kind: 'ran',
      verdict: { kind: 'no-verdict', reason: 'selection' },
    });
    expect((answer as { note?: string }).note).toMatch(/selected no test/);
    const log = h.store.log((answer as { recordId: string }).recordId);
    expect('value' in log && log.value).toMatch(/\[agentdeck\] narrow run selected no test/);
  }, 60_000);
});
