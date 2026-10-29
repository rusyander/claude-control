import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MutantPlanRow } from '@agentdeck/contracts/core/records';
import { describe, expect, it } from 'vitest';
// Тот же страж, что стоит globalSetup у vitest ядра: журнал мутанта обязан останавливать чужие наборы.
import { foreignMutation } from '../../../../../tools/mutation-guard.mjs';
import {
  byBehaviour,
  fakeRunner,
  journals,
  ran,
  repo,
  row,
  SOURCE,
  stateDir,
} from './__fixtures__/plan-repo.ts';
import { sha1 } from './journal.ts';
import { platformMutateIo } from './io.ts';
import { runMutateCommand } from './cli.ts';
import { parsePlan } from './plan.ts';
import { runPlan } from './run.ts';
import { MutateRefusal, type TestRunner } from './mutate.types.ts';

/**
 * Мутанты ядра (G6): исход каждой строки плана, журнал в формате mustfail (его видит mutation-guard,
 * его разбирает следующий старт после убитого прогона), возврат файла байт в байт.
 */

describe('verifier/mutate runPlan (G6)', () => {
  it('killed / survived / not-applied / baseline-red / file error each get their outcome, the file comes back byte-equal', async () => {
    const dir = repo();
    const seen: string[] = [];
    const results = await runPlan(
      [
        row('a + b', 'a - b'),
        row('a + b', 'b + a'),
        row('nope', 'x'),
        row('a', 'x'),
        row('a + b', 'SYNTAX('),
      ],
      { root: dir, runner: fakeRunner(dir, byBehaviour, seen) },
    );
    expect(results.map((r) => r.outcome)).toEqual([
      'killed',
      'survived',
      'not-applied',
      'not-applied',
      'survived',
    ]);
    expect(results[4]?.detail).toMatch(/не собрался/);
    expect(readFileSync(join(dir, 'src', 'sum.mjs'), 'utf8')).toBe(SOURCE);
    expect(journals(dir)).toEqual([]);
    // база одна на (spec, test): один зелёный прогон и по прогону на каждый применённый мутант
    expect(seen).toHaveLength(4);
    const red = await runPlan([row('a + b', 'a - b')], {
      root: dir,
      runner: fakeRunner(dir, () => ran('failed')),
    });
    expect(red.map((r) => r.outcome)).toEqual(['baseline-red']);
    const skipped = await runPlan([row('a + b', 'a - b')], {
      root: dir,
      runner: fakeRunner(dir, () => ran('skipped')),
    });
    expect(skipped[0]).toMatchObject({
      outcome: 'baseline-red',
      detail: expect.stringMatching(/пропущен/),
    });
  });

  it('while a mutant is applied the mustfail journal names this run: mutation-guard refuses foreign suites, the mutated bytes are journaled before the write', async () => {
    const dir = repo();
    let guard: ReturnType<typeof foreignMutation> = null;
    let journal:
      { pid: number; files: Record<string, { before: string; written: string[] }> } | undefined;
    const runner: TestRunner = {
      run: async () => {
        const source = readFileSync(join(dir, 'src', 'sum.mjs'), 'utf8');
        if (source.includes('a - b')) {
          guard = foreignMutation({ cwd: dir, env: {} });
          const name = journals(dir)[0] ?? '';
          journal = JSON.parse(readFileSync(join(stateDir(dir), name), 'utf8'));
        }
        return byBehaviour(source);
      },
    };
    await runPlan([row('a + b', 'a - b')], { root: dir, runner });
    expect(guard).toMatchObject({ pid: process.pid });
    const entry = Object.values(journal?.files ?? {})[0];
    expect(entry?.before).toBe(sha1(Buffer.from(SOURCE)));
    expect(entry?.written).toEqual([sha1(Buffer.from(SOURCE.replace('a + b', 'a - b')))]);
    // свой прогон стражу не мешает: дети получают MUSTFAIL_PID
    expect(foreignMutation({ cwd: dir, env: { MUSTFAIL_PID: String(process.pid) } })).toBeNull();
    expect(foreignMutation({ cwd: dir, env: {} })).toBeNull();
  });

  it('a run killed mid-mutant is undone by the next start from its journal; a file changed after its death is refused, never overwritten', async () => {
    const dir = repo();
    const file = join(dir, 'src', 'sum.mjs');
    const dead = spawnSync(process.execPath, ['-e', '']).pid ?? 1;
    const plant = (now: string): void => {
      mkdirSync(join(stateDir(dir), String(dead)), { recursive: true });
      const backup = join(stateDir(dir), String(dead), '0-sum.mjs');
      writeFileSync(backup, SOURCE);
      const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: dir,
        encoding: 'utf8',
      }).stdout.trim();
      const mutated = SOURCE.replace('a + b', 'a - b');
      writeFileSync(
        join(stateDir(dir), `journal-${dead}.json`),
        JSON.stringify({
          pid: dead,
          scope: top.replace(/\\/g, '/').toLowerCase(),
          started: '2026-10-29T00:00:00.000Z',
          cmd: 'killed',
          files: {
            [file]: {
              backup,
              before: sha1(Buffer.from(SOURCE)),
              written: [sha1(Buffer.from(mutated))],
            },
          },
        }),
      );
      writeFileSync(file, now);
    };
    plant(SOURCE.replace('a + b', 'a - b'));
    const lines: string[] = [];
    const results = await runPlan([row('a + b', 'a - b')], {
      root: dir,
      runner: fakeRunner(dir, byBehaviour),
      progress: (l) => lines.push(l),
    });
    expect(lines[0]).toMatch(/вернул 1 файл/);
    expect(results[0]?.outcome).toBe('killed');
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);
    expect(journals(dir)).toEqual([]);

    plant('export const add = () => 42; // human edit\n');
    await expect(
      runPlan([row('a + b', 'a - b')], { root: dir, runner: fakeRunner(dir, byBehaviour) }),
    ).rejects.toThrow(/изменён после смерти прогона/);
    expect(readFileSync(file, 'utf8')).toBe('export const add = () => 42; // human edit\n');
  });

  it('a live foreign run in the same tree refuses at once (or after --wait), naming its pid; outside git the run refuses', async () => {
    const dir = repo();
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
    }).stdout.trim();
    mkdirSync(stateDir(dir), { recursive: true });
    writeFileSync(
      join(stateDir(dir), `journal-${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        scope: top.replace(/\\/g, '/').toLowerCase(),
        started: 'now',
        cmd: 'x',
        files: {},
      }),
    );
    const options = { root: dir, runner: fakeRunner(dir, byBehaviour), pid: 2_000_000_001 };
    await expect(runPlan([row('a + b', 'a - b')], options)).rejects.toThrow(
      new RegExp(`pid ${process.pid}`),
    );
    await expect(
      runPlan([row('a + b', 'a - b')], { ...options, waitMs: 50 }),
    ).rejects.toBeInstanceOf(MutateRefusal);
    expect(readFileSync(join(dir, 'src', 'sum.mjs'), 'utf8')).toBe(SOURCE);
    const plain = mkdtempSync(join(tmpdir(), 'mut-plain-'));
    await expect(runPlan([row('a + b', 'a - b')], { root: plain })).rejects.toThrow(
      /не рабочее дерево git/,
    );
  });

  it('a restore that does not verify keeps the journal and refuses, naming the file', async () => {
    const dir = repo();
    const real = platformMutateIo();
    let writes = 0;
    const io = {
      ...real,
      writeBytes: (path: string, bytes: Buffer) => {
        if (path.endsWith('sum.mjs')) {
          writes += 1;
          // первая запись — мутант, всё дальше (возврат) «молча не легло»
          if (writes > 1) return;
        }
        real.writeBytes(path, bytes);
      },
    };
    // Прогон «под» мёртвым pid — так следующий старт увидит его журнал как оставленный убитым прогоном.
    const dead = spawnSync(process.execPath, ['-e', '']).pid ?? 1;
    await expect(
      runPlan([row('a + b', 'a - b')], {
        root: dir,
        runner: fakeRunner(dir, byBehaviour),
        io,
        pid: dead,
      }),
    ).rejects.toThrow(/НЕ ВЕРНУЛИСЬ.*sum\.mjs/);
    expect(journals(dir)).toEqual([`journal-${dead}.json`]);
    expect(readFileSync(join(dir, 'src', 'sum.mjs'), 'utf8')).not.toBe(SOURCE);
    // следующий старт с честной записью возвращает файл по журналу и только потом мутирует
    const results = await runPlan([row('a + b', 'a - b')], {
      root: dir,
      runner: fakeRunner(dir, byBehaviour),
    });
    expect(results[0]?.outcome).toBe('killed');
    expect(readFileSync(join(dir, 'src', 'sum.mjs'), 'utf8')).toBe(SOURCE);
  });
});

describe('verifier/mutate plan + command', () => {
  it('the plan is strict: extra field, empty find and non-JSON are refused; a BOM is not', () => {
    const good = JSON.stringify([row('a', 'b')]);
    expect(parsePlan(`\uFEFF${good}`, 'p.json')).toHaveLength(1);
    expect(() => parsePlan(JSON.stringify([{ ...row('a', 'b'), extra: 1 }]), 'p.json')).toThrow(
      MutateRefusal,
    );
    expect(() => parsePlan(JSON.stringify([row('', 'b')]), 'p.json')).toThrow(/find/);
    expect(() => parsePlan('[', 'p.json')).toThrow(/не JSON/);
    expect(() => parsePlan('[]', 'p.json')).toThrow(MutateRefusal);
  });

  it('exit 0 when every mutant is killed, 1 when one survives, 2 on a refusal; usage on bad flags', async () => {
    const dir = repo();
    const plan = (rows: MutantPlanRow[]): string => {
      const path = join(dir, `plan-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(path, JSON.stringify(rows));
      return path;
    };
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
    const deps = { options: { runner: fakeRunner(dir, byBehaviour) } };
    expect(await runMutateCommand([plan([row('a + b', 'a - b')]), '--root', dir], io, deps)).toBe(
      0,
    );
    expect(lines.at(-1)).toBe(
      '[mutate] 1 planned · killed 1 · survived 0 · not-applied 0 · baseline-red 0',
    );
    expect(await runMutateCommand([plan([row('a + b', 'b + a')]), '--root', dir], io, deps)).toBe(
      1,
    );
    // корень вне git — отказ всего прогона, не итог мутанта
    const plain = mkdtempSync(join(tmpdir(), 'mut-plain-'));
    expect(await runMutateCommand([plan([row('a + b', 'a - b')]), '--root', plain], io, deps)).toBe(
      2,
    );
    expect(lines.at(-1)).toMatch(/не рабочее дерево git/);
    expect(await runMutateCommand(['--frob'], io, deps)).toBe(2);
    expect(lines.at(-1)).toMatch(/^usage: .* mutate <plan\.json>/);
  });
});
