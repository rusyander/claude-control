import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { LayerRunDecision } from '@agentdeck/contracts/core/user-layer';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { afterAll, describe, expect, it } from 'vitest';
import { LAYER_MODES_TASK } from './__fixtures__/library/stage7-l.ts';
import { layerSetDir, markersOf, plantLayerSet } from './__fixtures__/layer-sets/plant.ts';
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
 * P87 живьём (матрица режимов хуков человека): задача `layer-modes` на НАСТОЯЩЕМ `claude` (модель —
 * маршрут-заглушка ядра), набор `synthetic-large` в одноразовом доме CLI стенда, исходник отмечен
 * доверенным. Через настоящую дорогу сессии ядра: запись `observe` ставит дорога, хуки записи
 * пишет переходник, `run.ts recorder` исполняет команду человека.
 * - `on`: хуки человека исполнил CLI (отметки), сводки записи нет;
 * - `observe`: хуки человека исполнила запись (отметки), `layer.observed` с вызовами и без отказов;
 * - `off`: отметок нет, сводки нет;
 * - каждый режим: хук ядра решал (`permit` дороги `hook`), решение `layer-run` с хешем описи,
 *   `layer.changed` первым сеансом CLI.
 * Нет `claude` в PATH (контейнер Linux) — пропуск с причиной.
 */

const present = hasCli(claudeRunFacts.binary.command);
const stands: Stand[] = [];
afterAll(async () => {
  for (const s of stands) await sweepStand(s);
}, 120_000);

type Mode = 'on' | 'observe' | 'off';

async function runMode(mode: Mode) {
  const s = makeStand(LAYER_MODES_TASK, `p87-${mode}-`);
  stands.push(s);
  const markers = join(s.root, 'markers');
  plantLayerSet(layerSetDir('synthetic-large'), join(s.cliHome, '.claude'), markers);
  const run = await runCore(s, {
    ...configFor(s, 'claude', 'claimed', { waitMs: 120_000 }),
    layerMode: mode,
  });
  expect(run.code, run.stderr.slice(-3000)).toBe(0);
  expect(run.result, JSON.stringify(run.notes)).toBeDefined();
  const lines = journalOf(s, run.result!.taskId);
  return {
    outcome: run.result!.outcome,
    commits: commitsIn(run.result!.copy, LAYER_MODES_TASK.input.repo.baseBranch, []).count,
    markers: markersOf(markers),
    lines,
  };
}

const ofKind = <K extends JournalLine['kind']>(lines: readonly JournalLine[], kind: K) =>
  lines.filter((l): l is JournalLine<K> => l.kind === kind);

const decisions = (lines: readonly JournalLine[], cls: string) =>
  ofKind(lines, 'decision').filter((l) => l.data.class === cls);

const hookPermits = (lines: readonly JournalLine[]): number =>
  decisions(lines, 'permit').filter((l) => (l.data.output as { road?: string }).road === 'hook')
    .length;

describe.skipIf(!present)('P87 user hook modes on the real claude CLI (live)', () => {
  it.each(['on', 'observe', 'off'] as const)(
    '%s: user hooks run by the right party, core hook decides, layer journaled',
    async (mode) => {
      const got = await runMode(mode);
      expect(got.outcome).toBe('claimed');
      expect(got.commits).toBe(1);
      // Хук ядра решал в каждом режиме.
      expect(hookPermits(got.lines)).toBeGreaterThan(0);
      // Решение `layer-run`: режим на деле = просили (исходник доверен), опись прочитана.
      const layerRun = decisions(got.lines, 'layer-run').map(
        (l) => l.data.output as unknown as LayerRunDecision,
      );
      expect(layerRun).toHaveLength(1);
      expect(layerRun[0]).toMatchObject({
        asked: { hooks: mode },
        ran: { hooks: mode },
        repoLayer: true,
        trust: 'panel',
        inventoryHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const changed = ofKind(got.lines, 'layer.changed');
      expect(changed.map((l) => l.data.userLayerHash)).toEqual([layerRun[0]!.inventoryHash]);
      const observed = ofKind(got.lines, 'layer.observed');
      if (mode === 'off') {
        expect(got.markers).toEqual({});
        expect(observed).toEqual([]);
        return;
      }
      // Хуки человека сработали: в `on` их зовёт CLI, в `observe` — запись ядра.
      for (const hook of ['synth-pre', 'synth-post', 'synth-prompt']) {
        expect(got.markers[hook], `${hook} ${JSON.stringify(got.markers)}`).toBeGreaterThan(0);
      }
      if (mode === 'on') {
        expect(observed).toEqual([]);
        return;
      }
      expect(observed).toHaveLength(1);
      const rows = observed[0]!.data.observations;
      expect(rows.map((r) => r.event).sort()).toEqual(
        expect.arrayContaining(['PostToolUse', 'PreToolUse', 'UserPromptSubmit']),
      );
      expect(rows.every((r) => /^\w+\.\d+\.\d+$/.test(r.hook) && r.calls > 0)).toBe(true);
      expect(rows.reduce((n, r) => n + r.wouldBlock + r.errors, 0)).toBe(0);
      // Части слоя без хуков поданы другой дорогой и это названо.
      expect(layerRun[0]!.detail).toContain(
        'observe: skills, commands and agents re-supplied as user-layer:<name>',
      );
    },
    600_000,
  );
});
