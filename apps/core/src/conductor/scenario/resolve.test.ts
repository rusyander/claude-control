import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESET_IDS, scenarioProblems, scenarioSchema } from '@agentdeck/contracts/core/scenario';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import {
  latestVersion,
  libraryFile,
  listLibrary,
  readLibraryScenario,
  scenarioText,
  writeLibraryScenario,
} from './library.ts';
import { PRESETS, latestPresets } from './presets.ts';
import { PROJECT_SCENARIO_FILE, resolveScenario } from './resolve.ts';
import { forkOfFeature } from './__fixtures__/scenario-harness.ts';

/**
 * Сценарий задачи по ссылке (G12): пресет из кода, версия библиотеки (пишется один раз), поверх —
 * файл проекта каждого репозитория. Любое препятствие — отказ с именем и пресетами взамен,
 * никогда тихая подмена (02:32, F25).
 */

function repo(name: string, file?: string): { repoKey: string; path: string } {
  const path = tempDir(`${name}-`);
  if (file !== undefined) {
    mkdirSync(join(path, '.agentdeck'), { recursive: true });
    writeFileSync(join(path, PROJECT_SCENARIO_FILE), file);
  }
  return { repoKey: name, path };
}

describe('scenario presets and library', () => {
  it('six presets, every one schema-valid with no structural problem, ids = PRESET_IDS', () => {
    expect(PRESETS.map((p) => p.id).sort()).toEqual([...PRESET_IDS].sort());
    for (const p of PRESETS) {
      expect(scenarioSchema.safeParse(p).success).toBe(true);
      expect({ id: p.id, problems: scenarioProblems(p) }).toEqual({ id: p.id, problems: [] });
    }
    expect(latestPresets()).toHaveLength(6);
  });

  it('library versions are write-once: same text again is "same", another text is version-taken, preset id refused', async () => {
    const dir = tempDir('lib-');
    const v1 = forkOfFeature('team-flow', 1);
    expect(await writeLibraryScenario(dir, v1)).toEqual({ written: 'created' });
    expect(await writeLibraryScenario(dir, v1)).toEqual({ written: 'same' });
    const other = { ...v1, title: 'другой текст' };
    expect(await writeLibraryScenario(dir, other)).toMatchObject({ refused: 'version-taken' });
    expect(await writeLibraryScenario(dir, { ...v1, id: 'feature' })).toMatchObject({
      refused: 'preset-id-reserved',
    });
    expect(await readLibraryScenario(dir, { id: 'team-flow', version: 1 })).toEqual({
      kind: 'value',
      scenario: v1,
    });
  });

  it('listing names every bad file and keeps the good ones; latestVersion counts per id', async () => {
    const dir = tempDir('lib-');
    await writeLibraryScenario(dir, forkOfFeature('team-flow', 1));
    await writeLibraryScenario(dir, forkOfFeature('team-flow', 2));
    writeFileSync(join(dir, 'broken@1.json'), '{not json');
    writeFileSync(join(dir, 'moved@1.json'), scenarioText(forkOfFeature('team-flow', 3)));
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const got = await listLibrary(dir);
    if (!('value' in got)) throw new Error('listing unreadable');
    expect(got.value.scenarios.map((s) => `${s.id}@${s.version}`)).toEqual([
      'team-flow@1',
      'team-flow@2',
    ]);
    expect(got.value.problems.map((p) => p.file)).toEqual(['broken@1.json', 'moved@1.json']);
    expect(got.value.problems[1]?.reason).toBe('invalid: file moved@1 holds team-flow@3');
    expect(latestVersion(got.value, 'team-flow')).toBe(2);
    expect(latestVersion(got.value, 'none')).toBe(0);
    expect(await listLibrary(join(dir, 'absent'))).toEqual({
      value: { scenarios: [], problems: [] },
    });
  });

  it('a BOM-prefixed library file reads as the scenario it holds', async () => {
    const dir = tempDir('lib-');
    const s = forkOfFeature('bom-flow', 1);
    writeFileSync(libraryFile(dir, s), `${String.fromCharCode(0xfeff)}${scenarioText(s)}`);
    expect(await readLibraryScenario(dir, s)).toEqual({ kind: 'value', scenario: s });
  });
});

describe('resolveScenario (G12)', () => {
  it('preset with no project file → the preset, empty overlay, one absent read per repo', async () => {
    const got = await resolveScenario({ id: 'feature', version: 1 }, [repo('r1')], {
      libraryDir: tempDir('lib-'),
    });
    expect(got).toMatchObject({
      ok: true,
      base: { id: 'feature', version: 1 },
      overlay: { applied: [], rejected: [] },
      facts: [{ readClass: 'scenario.project', kind: 'absent' }],
    });
  });

  it('library scenario + a narrowing project file → narrowed, the line names the repo file', async () => {
    const dir = tempDir('lib-');
    await writeLibraryScenario(dir, forkOfFeature('team-flow', 1));
    const file = JSON.stringify({ v: 1, steps: { work: { roundCap: 1 } } });
    const got = await resolveScenario({ id: 'team-flow', version: 1 }, [repo('r1', file)], {
      libraryDir: dir,
    });
    if (!got.ok) throw new Error(JSON.stringify(got.refusals));
    expect(got.scenario.steps.find((s) => s.id === 'work')?.roundCap).toBe(1);
    expect(got.overlay.applied[0]?.reason).toBe('r1: .agentdeck/scenario.json: 2 → 1');
    expect(got.facts.map((f) => `${f.readClass}:${f.kind}`)).toEqual([
      'scenario.library:value',
      'scenario.project:value',
    ]);
  });

  it('every obstacle at once: missing library version, bad JSON, bad schema → refused with presets offered', async () => {
    const got = await resolveScenario(
      { id: 'team-flow', version: 7 },
      [repo('a', '{oops'), repo('b', JSON.stringify({ v: 2 })), repo('c')],
      { libraryDir: tempDir('lib-') },
    );
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.offer).toEqual(PRESET_IDS);
    expect(got.refusals.map((r) => [r.level, r.source])).toEqual([
      [3, 'library team-flow@7'],
      [4, 'a: .agentdeck/scenario.json'],
      [4, 'b: .agentdeck/scenario.json'],
    ]);
    expect(got.refusals[0]?.reason).toBe('no such scenario in the library');
    expect(got.refusals[1]?.reason).toMatch(/^not JSON: /);
    expect(got.refusals[2]?.reason).toMatch(/^v: /);
  });

  it('unknown preset version refused, never the nearest version', async () => {
    const got = await resolveScenario({ id: 'feature', version: 2 }, [], { libraryDir: tempDir() });
    expect(got).toMatchObject({
      ok: false,
      refusals: [{ level: 3, source: 'feature@2', reason: 'preset feature has no version 2' }],
    });
  });

  it.skipIf(process.platform === 'win32')(
    'P44: an unreadable project file is unknown → refusal, not "no file"',
    async () => {
      const r = repo('locked', JSON.stringify({ v: 1 }));
      chmodSync(join(r.path, PROJECT_SCENARIO_FILE), 0o000);
      const got = await resolveScenario({ id: 'feature', version: 1 }, [r], {
        libraryDir: tempDir(),
      });
      chmodSync(join(r.path, PROJECT_SCENARIO_FILE), 0o644);
      expect(got).toMatchObject({ ok: false, facts: [{ kind: 'unknown' }] });
    },
  );

  it('P44: a library path that is a directory reads unknown → refusal naming "unreadable"', async () => {
    const dir = tempDir('lib-');
    mkdirSync(libraryFile(dir, { id: 'dir-flow', version: 1 }), { recursive: true });
    const got = await resolveScenario({ id: 'dir-flow', version: 1 }, [], { libraryDir: dir });
    expect(got).toMatchObject({
      ok: false,
      facts: [{ readClass: 'scenario.library', kind: 'unknown' }],
    });
    if (got.ok) return;
    expect(got.refusals[0]?.reason).toMatch(/^unreadable: /);
  });
});
