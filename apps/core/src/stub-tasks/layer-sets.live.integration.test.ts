import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { afterAll, describe, expect, it } from 'vitest';
import { LAYER_SETS_TASK } from './__fixtures__/library/stage7-s.ts';
import {
  layerSetDir,
  markersOf,
  plantLayerSet,
  type LayerSetName,
} from './__fixtures__/layer-sets/plant.ts';
import {
  commitsIn,
  configFor,
  hasCli,
  journalOf,
  makeStand,
  runCore,
  sweepStand,
  type Stand,
} from './__fixtures__/e2e/stand.ts';

/**
 * P36 живьём (08:49, G10): задача `layer-sets` на НАСТОЯЩЕМ `claude` (модель — маршрут-заглушка
 * ядра) под каждым синтетическим набором слоя, посаженным в одноразовый дом CLI стенда, хуки
 * человека в `on` (исходник отмечен доверенным — иначе Claude шёл бы `observe`). Свойство: хуки
 * человека сработали (их отметки на диске), хук ядра сработал в каждом наборе (решения `permit`
 * дороги `hook`), решения ядра о праве совпадают по наборам; враждебный набор отличается только
 * названными строками `hook-block`. Нет `claude` в PATH (контейнер Linux) — пропуск с причиной.
 */

const present = hasCli(claudeRunFacts.binary.command);
const stands: Stand[] = [];
afterAll(async () => {
  for (const s of stands) await sweepStand(s);
}, 120_000);

interface SetRun {
  outcome: string | undefined;
  lines: JournalLine[];
  markers: Record<string, number>;
  commits: number;
  events: string[];
}

async function runSet(name: LayerSetName, waitMs: number): Promise<SetRun> {
  const s = makeStand(LAYER_SETS_TASK, `p36-${name}-`);
  stands.push(s);
  const markers = join(s.root, 'markers');
  plantLayerSet(layerSetDir(name), join(s.cliHome, '.claude'), markers);
  const run = await runCore(s, {
    ...configFor(s, 'claude', 'claimed', { waitMs }),
    layerMode: 'on',
  });
  expect(run.code, run.stderr.slice(-3000)).toBe(0);
  const result = run.result;
  expect(result, JSON.stringify(run.notes)).toBeDefined();
  const lines = journalOf(s, result!.taskId);
  return {
    outcome: result?.outcome,
    lines,
    markers: markersOf(markers),
    commits: commitsIn(result!.copy, LAYER_SETS_TASK.input.repo.baseBranch, []).count,
    events: result!.events,
  };
}

/** Решения ядра о праве без путей стенда: инструмент, действие, исход, дорога. */
const permits = (lines: readonly JournalLine[]): string[] =>
  lines
    .filter((l) => l.kind === 'decision' && (l.data as { class: string }).class === 'permit')
    .map((l) => {
      const o = (l as JournalLine<'decision'>).data.output as {
        tool?: string;
        action?: string;
        allow?: boolean;
        road?: string;
      };
      return `${o.tool}|${o.action}|${o.allow}|${o.road}`;
    });

const hookSignals = (lines: readonly JournalLine[]): string[] =>
  lines
    .filter((l) => l.kind === 'signal')
    .map((l) => (l as JournalLine<'signal'>).data)
    .filter((d) => d.signal === 'hook-block' || d.signal === 'hook-loop')
    .map((d) => `${d.signal}:${d.subject}`);

describe.skipIf(!present)('P36 user layer sets on the real claude CLI (live)', () => {
  const runs: Partial<Record<LayerSetName, SetRun>> = {};

  it('none and synthetic-large: step claimed with one commit, user hooks fired, core hook decisions identical, no hook lines', async () => {
    runs.none = await runSet('none', 120_000);
    runs['synthetic-large'] = await runSet('synthetic-large', 120_000);
    const none = runs.none;
    const large = runs['synthetic-large'];
    expect(none.outcome).toBe('claimed');
    expect(large.outcome).toBe('claimed');
    expect(none.commits).toBe(1);
    expect(large.commits).toBe(1);
    expect(none.markers).toEqual({});
    // Хуки человека сработали на каждом событии набора.
    for (const hook of ['synth-pre', 'synth-pre-write', 'synth-post', 'synth-prompt', 'synth-stop'])
      expect(large.markers[hook], `${hook} ${JSON.stringify(large.markers)}`).toBeGreaterThan(0);
    // Хук ядра сработал на каждом вызове в обоих наборах — и решил одинаково.
    expect(permits(none.lines).filter((p) => p.endsWith('|hook')).length).toBeGreaterThan(0);
    expect(permits(large.lines)).toEqual(permits(none.lines));
    expect(hookSignals(none.lines)).toEqual([]);
    expect(hookSignals(large.lines)).toEqual([]);
  }, 600_000);

  it('hostile: user hooks fired, core hook decided every call it saw as in none, refusals journaled as named hook-block lines', async () => {
    const hostile = await runSet('hostile', 90_000);
    runs.hostile = hostile;
    for (const hook of ['hostile-bash', 'hostile-step-done', 'hostile-prompt'])
      expect(hostile.markers[hook], `${hook} ${JSON.stringify(hostile.markers)}`).toBeGreaterThan(
        0,
      );
    // Ходы заглушки от слоя не зависят: хук ядра видел те же вызовы и решил их так же. Решения
    // потока после хука сравнивать нельзя: вызов, отказанный хуком человека, до них не доходит.
    const none = runs.none;
    const byHook = (lines: readonly JournalLine[]) =>
      permits(lines).filter((p) => p.endsWith('|hook'));
    if (none) expect(byHook(hostile.lines)).toEqual(byHook(none.lines));
    expect(hostile.outcome).not.toBe('claimed');
    // Отказ хука человека виден в потоке (`hook.refused`, переходник) и назван в журнале.
    expect(hostile.events).toContain('hook.refused');
    const named = hookSignals(hostile.lines);
    expect(named.length, JSON.stringify(named)).toBeGreaterThan(0);
    expect(named.every((n) => n.startsWith('hook-block:') || n.startsWith('hook-loop:'))).toBe(
      true,
    );
    expect(named.some((n) => /^hook-block:PreToolUse\.\d+\.\d+$/.test(n))).toBe(true);
  }, 600_000);
});
