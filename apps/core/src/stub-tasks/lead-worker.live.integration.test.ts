import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { afterAll, describe, expect, it } from 'vitest';
import { HAPPY_PATH } from './__fixtures__/library/happy-path.ts';
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
 * W2-12b живьём: задача под ведением (`task.created.lead`) на НАСТОЯЩЕМ `claude`, ядро отдельным
 * процессом, модель — маршрут-заглушка ядра. Сеанс единицы первым ходом зовёт субагента: хук ядра
 * (дорога `hook`) отказывает с кодом `lead-worker`, строка решения `permit` в журнале задачи, и
 * шаг идёт дальше — запись, коммит, `step_done` приняты (шаг в `checking`). Та же задача без
 * ведения тем же ходом кода `lead-worker` не получает. Нет `claude` в PATH — пропуск.
 */

const present = hasCli(claudeRunFacts.binary.command);
const stands: Stand[] = [];
afterAll(async () => {
  for (const s of stands) await sweepStand(s);
}, 120_000);

const LEAD_SCRIPT = fileURLToPath(
  new URL('./__fixtures__/e2e/lead-worker-script.ts', import.meta.url),
);

/** Маршрут-заглушка стенда — сценарий исполнителя: сначала субагент, потом ходы задачи. */
function withSubagentFirst(s: Stand): void {
  const file = join(s.home, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8')) as {
    routes: { stub: { script: { module: string; export: string } }[] };
  };
  for (const route of config.routes.stub) {
    route.script.module = LEAD_SCRIPT;
    route.script.export = 'leadWorkerScriptFor';
  }
  writeFileSync(file, JSON.stringify(config));
}

interface PermitOut {
  allow: boolean;
  code?: string;
  action?: string;
  road?: string;
}

async function run(lead: boolean) {
  const s = makeStand(HAPPY_PATH, `lead-worker-${lead ? 'on' : 'off'}-`);
  stands.push(s);
  withSubagentFirst(s);
  const r = await runCore(s, {
    ...configFor(s, 'claude', 'claimed', { waitMs: 150_000 }),
    ...(lead ? { lead: { profile: 'balanced' as const } } : {}),
  });
  expect(r.code, r.stderr.slice(-3000)).toBe(0);
  expect(r.result, JSON.stringify(r.notes)).toBeDefined();
  const lines = journalOf(s, r.result!.taskId);
  const permits = lines
    .filter((l) => l.kind === 'decision' && (l.data as { class: string }).class === 'permit')
    .map((l) => (l.data as unknown as { output: PermitOut }).output);
  const tail = lines
    .slice(-40)
    .map((l) => `${l.kind} ${JSON.stringify((l.data as { output?: unknown }).output ?? '')}`);
  return { s, result: r.result!, permits, lines, tail: tail.join('\n') };
}

describe.skipIf(!present)('W2-12b lead worker on the real claude CLI (live)', () => {
  it('a lead-routed unit session asking for a subagent is refused lead-worker by the core hook, the refusal is journaled and the step goes on to step_done', async () => {
    const r = await run(true);
    expect(r.lines.find((l) => l.kind === 'task.created')?.data).toMatchObject({
      lead: { profile: 'balanced' },
    });
    const sub = r.permits.filter((p) => p.action === 'subagent');
    expect(sub, r.tail).toEqual([
      expect.objectContaining({ allow: false, code: 'lead-worker', road: 'hook' }),
    ]);
    // Шаг продолжился после отказа: запись и коммит прошли, заявка принята.
    expect(r.result.outcome, r.tail).toBe('claimed');
    expect(r.result.stepState).toBe('checking');
    const e2e = HAPPY_PATH.e2e!;
    const repo = commitsIn(
      r.result.copy,
      HAPPY_PATH.input.repo.baseBranch,
      Object.keys(e2e.committed),
    );
    expect(repo.files).toEqual(e2e.committed);
    expect(r.permits.some((p) => p.allow && p.action !== 'subagent')).toBe(true);
  }, 300_000);

  it('the same task without lead: the subagent ask gets no lead-worker refusal', async () => {
    const r = await run(false);
    const sub = r.permits.filter((p) => p.action === 'subagent');
    expect(sub.length, r.tail).toBeGreaterThan(0);
    expect(sub.every((p) => p.code !== 'lead-worker')).toBe(true);
    expect(r.result.outcome, r.tail).toBe('claimed');
  }, 300_000);
});
