import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { PLATFORM_MARKER } from '@agentdeck/contracts/core/user-layer';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { HINT_HEAD } from '../bootstrap/conductor-wiring/observer.ts';
import { humanAncestor } from '../platform/__fixtures__/clean-base.ts';
import type { AdapterUnderTest } from './__fixtures__/e2e/e2e.types.ts';
import {
  configFor,
  hasCli,
  journalOf,
  makeStand,
  runCore,
  sweepStand,
  type Stand,
} from './__fixtures__/e2e/stand.ts';
import { STUB_TASKS } from './__fixtures__/library/index.ts';
import { REREAD_LOOP, STALLED_STREAM } from './__fixtures__/library/waste.ts';
import type { StubTask } from './__fixtures__/stub-tasks.types.ts';

/**
 * Наблюдатель этапа 8 на НАСТОЯЩЕМ CLI (P18 live, 06 §Observer): ядро — отдельный процесс с
 * одноразовым домом и проводкой продукта (`bootCore`), модель — маршрут-заглушка ядра, дирижёр —
 * стенд `__fixtures__/e2e/conduct.ts` с зоной наблюдателя дирижёра продукта (`observerHooks`).
 * Сработавшие сигналы — строки `signal` журнала задачи, факты вызовов — `tool.event` кранов
 * проводки ядра, подсказка — то, что модель-заглушка получила в запросе (след маршрута).
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

type Data = Record<string, unknown>;
const of = (lines: readonly JournalLine[], kind: string): Data[] =>
  lines.filter((l) => l.kind === kind).map((l) => l.data as Data);
const signalsOf = (lines: readonly JournalLine[], signal: string): Data[] =>
  of(lines, 'signal').filter((d) => d.signal === signal);

/**
 * Цикл перечитывания с концом хода после третьего чтения: подсказка уходит на конце хода (ход без
 * `step_done`), модель получает её следующим сообщением и только потом сдаёт шаг.
 */
const REREAD_TURN_END: StubTask = {
  ...REREAD_LOOP,
  id: 'reread-loop-turn-end',
  moves: [
    { op: 'read', path: '${copy}/README.md' },
    { op: 'read', path: '${copy}/README.md' },
    { op: 'read', path: '${copy}/README.md', turnEnd: true },
    ...REREAD_LOOP.moves.slice(5),
  ],
};
const FAIL_REPEAT = STUB_TASKS.find((t) => t.id === 'waste-fail-repeat')!;

/** Запросы основной сессии к модели (боковые — без инструмента оболочки) по порядку следа. */
function mainRequests(s: Stand): Data[] {
  return readFileSync(s.trace, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Data)
    .filter((r) => r.kind === 'model')
    .map((r) => r.body as Data)
    .filter((b) => JSON.stringify(b.tools ?? []).includes('"Bash"'));
}

async function run(
  task: StubTask,
  adapter: AdapterUnderTest,
  over: Parameters<typeof configFor>[3] = {},
) {
  const s = makeStand(task, `s8-${adapter}-`);
  stands.push(s);
  expect(humanAncestor(s.root)).toBeUndefined();
  const got = await runCore(s, configFor(s, adapter, 'claimed', { waitMs: 150_000, ...over }));
  expect(got.code, got.stderr.slice(-3000)).toBe(0);
  expect(got.result, JSON.stringify(got.notes)).toBeDefined();
  const lines = journalOf(s, got.result!.taskId);
  const tail = lines
    .slice(-30)
    .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 160)}`)
    .join('\n');
  return { s, result: got.result!, lines, tail };
}

/** Факты вызовов из кранов ядра: без них ни один сигнал расточительства не судится. */
function toolEvents(lines: readonly JournalLine[], tail: string, tool: string): Data[] {
  const events = of(lines, 'tool.event').filter((d) => d.tool === tool);
  expect(
    events.length,
    `no tool.event for ${tool}: boot composes no tool-event tap?\n${tail}`,
  ).toBeGreaterThan(0);
  return events;
}

describe.skipIf(!hasCli(CLIS.claude))('stage 8 observer on the real claude CLI', () => {
  it('reread loop: waste-reread hint arrives as ONE platform-marked message at the turn end, then the step is claimed', async () => {
    const { s, result, lines, tail } = await run(REREAD_TURN_END, 'claude');
    expect(result.outcome, tail).toBe('claimed');
    const reads = toolEvents(lines, tail, 'Read');
    expect(reads.length).toBeGreaterThanOrEqual(3);
    // Файл не менялся — один отпечаток на все чтения целиком (окна нет).
    expect(new Set(reads.map((r) => r.fileFp)).size).toBe(1);
    expect(reads[0]!.fileFp).not.toBeNull();
    expect(reads.every((r) => r.range === null)).toBe(true);
    const hints = signalsOf(lines, 'waste-reread');
    expect(hints.length, tail).toBeGreaterThan(0);
    expect(hints.every((h) => h.action === 'hint')).toBe(true);
    expect(of(lines, 'signal').filter((d) => d.action === 'stop-step')).toEqual([]);
    const delivered = of(lines, 'message.delivered').filter(
      (d) => (d.ref as { kind: string }).kind === 'hint',
    );
    expect(delivered, tail).toHaveLength(1);
    // Модель получила подсказку ровно одним сообщением с меткой платформы.
    const last = mainRequests(s).at(-1)!;
    const carrying = (last.messages as Data[]).filter((m) =>
      JSON.stringify(m.content).includes(HINT_HEAD),
    );
    expect(carrying).toHaveLength(1);
    const text = JSON.stringify(carrying[0]!.content);
    expect(text.indexOf(PLATFORM_MARKER)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(PLATFORM_MARKER)).toBeLessThan(text.indexOf(HINT_HEAD));
    expect(carrying[0]!.role).toBe('user');
  }, 300_000);

  it('fail repeat: node fail.js really exits 3 three times → one error digest from the CLI text, hint at the 2nd, stop-step at the 3rd', async () => {
    const { result, lines, tail } = await run(FAIL_REPEAT, 'claude');
    const fails = toolEvents(lines, tail, 'Bash');
    expect(fails.length).toBeGreaterThanOrEqual(2);
    expect(fails.every((f) => f.isError === true)).toBe(true);
    // F18: Claude Code не отдаёт код выхода полем — повтор узнаётся по отпечатку текста CLI.
    expect(fails.every((f) => f.exitCode === null)).toBe(true);
    expect(fails[0]!.errorDigest).not.toBeNull();
    expect(new Set(fails.map((f) => f.errorDigest)).size).toBe(1);
    const fired = signalsOf(lines, 'waste-fail-repeat');
    expect(
      fired.map((f) => f.action),
      tail,
    ).toContain('hint');
    expect(fired.map((f) => f.action)).toContain('stop-step');
    expect(result.outcome).not.toBe('claimed');
  }, 300_000);

  it('stalled stream: 30 s of model silence past a 8 s threshold → liveness probe alive, stall shown, the task not ended and the step claimed after', async () => {
    const { result, lines, tail } = await run(STALLED_STREAM, 'claude', {
      observer: { silentAfterMs: 3_000, stallDefaultMs: 8_000 },
    });
    const probes = of(lines, 'session.probe');
    expect(probes.length, `no session.probe: boot runs no stall watch?\n${tail}`).toBeGreaterThan(
      0,
    );
    expect(probes.map((p) => p.verdict)).toContain('alive');
    const stall = signalsOf(lines, 'stall');
    expect(stall.length, tail).toBeGreaterThan(0);
    expect(stall.every((d) => d.action !== 'stop-step')).toBe(true);
    expect(lines.map((l) => l.kind)).not.toContain('task.ended');
    expect(result.outcome, tail).toBe('claimed');
  }, 300_000);
});

describe.skipIf(!hasCli(CLIS.qwen))('stage 8 observer on the real qwen CLI', () => {
  it('fail repeat: the PGID line differs per run, the error digest does not → hint, then stop-step', async () => {
    const { lines, tail } = await run(FAIL_REPEAT, 'qwen');
    const fails = toolEvents(lines, tail, 'run_shell_command');
    expect(fails.length).toBeGreaterThanOrEqual(2);
    expect(fails.every((f) => f.isError === true && f.exitCode === null)).toBe(true);
    expect(new Set(fails.map((f) => f.errorDigest)).size).toBe(1);
    const fired = signalsOf(lines, 'waste-fail-repeat');
    expect(
      fired.map((f) => f.action),
      tail,
    ).toContain('hint');
    expect(fired.map((f) => f.action)).toContain('stop-step');
  }, 300_000);
});
