import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { humanAncestor } from '../platform/__fixtures__/clean-base.ts';
import { CLI_INITIATED_TURN } from './__fixtures__/library/cli-turns.ts';
import { HAPPY_PATH } from './__fixtures__/library/happy-path.ts';
import type { AdapterUnderTest } from './__fixtures__/e2e/e2e.types.ts';
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
 * Сквозной прогон части 2 (07 фаза 2): задача-заглушка от задачи до локального коммита — на
 * НАСТОЯЩЕМ `claude` и НАСТОЯЩЕМ `qwen`, модель — маршрут-заглушка ядра (ключи не тратятся).
 * Ядро — отдельный процесс с одноразовым домом; дирижёр фазы 2 — `__fixtures__/e2e/conduct.ts`.
 * Нет CLI в PATH (контейнер Linux) — прогон пропускается и называет причину.
 */

const CLIS: Record<AdapterUnderTest, string> = {
  claude: claudeRunFacts.binary.command,
  qwen: qwenRunFacts.binary.command,
};
const stands: Stand[] = [];
afterAll(async () => {
  for (const s of stands) await sweepStand(s);
}, 120_000);

for (const adapter of ['claude', 'qwen'] as const) {
  const present = hasCli(CLIS[adapter]);
  describe.skipIf(!present)(`stub task end to end on the real ${adapter} CLI`, () => {
    it(`${HAPPY_PATH.id}: one local commit carrying hello.txt, step_done accepted (step.claimed), no human point`, async () => {
      const s = makeStand(HAPPY_PATH, `e2e-${adapter}-`);
      stands.push(s);
      // Над стендом нет файлов инструкций человека: qwen идёт в слое `on` и поднял бы их (F2).
      expect(humanAncestor(s.root)).toBeUndefined();
      const run = await runCore(s, configFor(s, adapter, 'claimed'));
      expect(run.code, run.stderr.slice(-3000)).toBe(0);
      expect(run.result, JSON.stringify(run.notes)).toBeDefined();
      const result = run.result!;
      // Не дошёл — хвост журнала (вид, класс и итог решения) объясняет, где встал шаг.
      const tail = journalOf(s, result.taskId)
        .slice(-40)
        .map((l) => {
          const d = l.data as { class?: string; output?: unknown; signal?: string };
          return [l.kind, d.class ?? d.signal ?? '', d.class ? JSON.stringify(d.output) : ''].join(
            ' ',
          );
        });
      expect(result.outcome, `${tail.join('\n')}\nnotes ${JSON.stringify(run.notes)}`).toBe(
        'claimed',
      );
      expect(result.stepState).toBe('checking');
      expect(result.launched).toHaveLength(1);

      const e2e = HAPPY_PATH.e2e!;
      const repo = commitsIn(
        result.copy,
        HAPPY_PATH.input.repo.baseBranch,
        Object.keys(e2e.committed),
      );
      expect(repo.count).toBe(e2e.commits);
      expect(repo.files).toEqual(e2e.committed);

      const kinds = journalOf(s, result.taskId).map((l) => l.kind);
      for (const kind of HAPPY_PATH.phase2[0]!.kind === 'model-tool'
        ? (HAPPY_PATH.phase2[0]!.expect.journal.present ?? [])
        : [])
        expect(kinds).toContain(kind);
      expect(kinds).not.toContain('human.asked');
      // Каждое внешнее действие пути закрыто: копия и запуск — `action.done`, не висят.
      const lines = journalOf(s, result.taskId);
      const started = lines.filter((l) => l.kind === 'action.started').length;
      const done = lines.filter((l) => l.kind === 'action.done').length;
      expect({ started, done }).toEqual({ started: 2, done: 2 });
      // Права на запись, `git add`, `git commit` и `step_done` решило ядро (строки решения).
      const permits = lines.filter(
        (l) => l.kind === 'decision' && (l.data as { class: string }).class === 'permit',
      );
      expect(permits.length).toBeGreaterThan(0);
    }, 300_000);

    it(`${CLI_INITIATED_TURN.id}: a background command wakes the CLI → the adapter reports turn.cli-initiated`, async () => {
      const s = makeStand(CLI_INITIATED_TURN, `e2e-wake-${adapter}-`);
      stands.push(s);
      const run = await runCore(s, configFor(s, adapter, 'cli-initiated', { waitMs: 90_000 }));
      expect(run.code, run.stderr.slice(-3000)).toBe(0);
      expect(run.result?.outcome, JSON.stringify(run.result?.events)).toBe('cli-initiated');
      // Вердикт библиотеки: ход по инициативе CLI записан в журнал задачи, а не только событием.
      const kinds = journalOf(s, run.result!.taskId).map((l) => l.kind);
      const verdict = CLI_INITIATED_TURN.verdicts.find((v) => v.phase === 2)!;
      expect(verdict.journal?.present).toEqual(['turn.cli-initiated']);
      for (const kind of verdict.journal?.present ?? []) expect(kinds).toContain(kind);
    }, 300_000);
  });
}
