import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import type { LayerRun, SessionHandle } from '../adapters/index.ts';
import { CLAUDE_CHANNELS } from '../adapters/claude/claude.ts';
import { liveRoot, type LiveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import { fixturePath } from '../adapters/conformance/__fixtures__/replay.ts';
import { measureBase } from '../context/base/index.ts';
import { P13_KINDS } from '../context/__fixtures__/kind-parts.ts';
import { FIRST_ROUND, SOLO_UNIT, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { hasCli } from '../stub-tasks/__fixtures__/e2e/stand.ts';
import { roadStart, roadTask } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';
import { versionFromOutput } from './economy-wiring/base-start.ts';
import { probeOnStub } from './economy-wiring/context.ts';

/**
 * P13 база с сервером MCP ядра (G9, калибровка потолка): НАСТОЯЩИЙ `claude` на заглушке модели
 * получает сеанс, собранный НАСТОЯЩЕЙ дорогой ядра, — вид шага, его встроенные инструменты, слой,
 * хук ядра и строгий список MCP; мост `agentdeck` спрашивает список инструментов у настоящего ядра
 * по токену сеанса. Проба — та же, что у замера на старте (`probeOnStub`, свой id и каталог).
 * Ни один ключ не тратится: адрес — заглушка на петле, дом CLI — временный.
 */

const present = hasCli(claudeRunFacts.binary.command);

/**
 * Потолок базы с MCP ядра, токенов (bytes/4), по виду × набору слоя: замер на claude 2.1.310
 * 30.10.2026 (доверенный `on` — с CLAUDE.md ~2,8 КБ) + 20 % запаса, вверх до сотни. Замер:
 * plan off 12 072 / on 12 764, review off 12 086 / on 12 779, work off 13 576 / on 14 268,
 * fix off 13 576 / on 14 267. Против замера без MCP (`context/p13.live`) MCP ядра стоит ~1,1 тыс.
 * Рост сверх запаса — сигнал пересмотреть рычаги базы (список MCP вида, встроенные), а не
 * поднять потолок молча. Перемер: `P13_CALIB=<файл>` пишет замеры прогона.
 */
const BASE_CEILING_CORE_MCP: Record<string, Record<'off' | 'on', number>> = {
  plan: { off: 14_500, on: 15_400 },
  review: { off: 14_600, on: 15_400 },
  work: { off: 16_300, on: 17_200 },
  fix: { off: 16_300, on: 17_200 },
};

const CLAUDE_MD = `# Project rules\n${Array.from(
  { length: 40 },
  (_, i) => `- rule ${i}: keep LF endings and named exports in module ${i}`,
).join('\n')}\n`;

let core: BootedCore;
const roots: LiveRoot[] = [];

beforeAll(async () => {
  if (!present) return;
  core = await bootCore({
    home: join(tempDir('road-base-live-'), 'core'),
    build: 'road-base-live',
    loop: false,
  });
}, 60_000);

afterAll(async () => {
  await core?.stop();
}, 60_000);

/** Сеанс вида `kind` дорогой ядра, записанный в журнал, и проба его базы на заглушке. */
async function probeKind(kind: string, layer: 'off' | 'on') {
  const live = liveRoot(`road-base-${kind}-${layer}-`);
  roots.push(live);
  if (layer === 'on') writeFileSync(join(live.cwd, 'CLAUDE.md'), CLAUDE_MD);
  const bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  const task = await roadTask(core, claudeRunFacts.id);
  const base = roadStart({
    live,
    bin,
    task,
    adapterId: claudeRunFacts.id,
    fixture: fixturePath(claudeRunFacts.id, 'permit'),
    dump: join(live.root, `unused-${newId()}.json`),
    layer,
  });
  // Шаг своего вида: связка сессии (а с ней список инструментов моста) берёт вид из шага.
  const stepId = newId();
  const unitId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      unitId,
      repoKey: 'r1',
      branch: `agentdeck/${unitId.slice(-8)}`,
      ownedPaths: [],
      ...SOLO_UNIT,
    },
  });
  task.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: { stepId, unitId, stepKind: kind, budgetMs: 600_000, ...FIRST_ROUND },
  });
  task.append({
    kind: 'step.transition',
    actor: 'core',
    stepId,
    data: { stepId, event: 'start', from: 'queued', to: 'running' },
  });
  const start = {
    ...base,
    stepId,
    stepKind: kind,
    tools: toolPlanFor(kind)!.builtins,
    // Доверенная копия (отметка панели) — слой человека идёт в сеанс; иначе `on` ушёл бы в `off` (F-86).
    ...(layer === 'on' ? { trust: { sourceRepo: live.cwd, panelMark: true } } : {}),
  };
  const prepared = await core.road.prepare(start);
  if (!prepared.ok) throw new Error(prepared.reason);
  const p = prepared.prepared;
  // Запись сессии без запуска её CLI: проба — отдельный процесс, мосту нужна только связка.
  const handle = {
    sessionId: p.start.sessionId,
    dir: p.start.dir,
    host: { pid: process.pid, start: 'probe-host' },
    child: { pid: process.pid, start: 'probe-child' },
    spawned: { cwd: p.start.cwd, argv: [] },
  } as unknown as SessionHandle;
  core.road.started(p, handle, {
    asked: layer,
    ran: layer,
    repoLayer: true,
    trust: 'none',
  } as LayerRun);
  const dir = join(p.spec.dir, 'base-probe');
  mkdirSync(dir, { recursive: true });
  const trace = await probeOnStub(
    p.adapter,
    { ...p.spec, sessionId: newId(), dir },
    { channel: CLAUDE_CHANNELS[0]!, dialect: 'anthropic-messages' },
  );
  const measured = measureBase(trace);
  if (!measured) throw new Error('no probe request carried the brief');
  return { p, trace, measured };
}

describe.skipIf(!present)('P13 base with the core MCP server on the real claude CLI', () => {
  const tokens: Record<string, Record<'off' | 'on', number>> = {};

  it('the CLI prints a version the base key can carry', async () => {
    const { runOnce } = await import('../adapters/launcher/index.ts');
    const got = await runOnce(
      claudeRunFacts.binary.command,
      ['--version'],
      process.env as Record<string, string>,
      process.cwd(),
    );
    expect(versionFromOutput(got.stdout)).toMatch(/^\d+\.\d+\.\d+/);
  }, 60_000);

  for (const kind of P13_KINDS)
    for (const layer of ['off', 'on'] as const)
      it(`${kind} × layer ${layer}: the probe sees the core MCP tools of the kind; base within the calibrated ceiling`, async () => {
        const { p, trace, measured } = await probeKind(kind, layer);
        (tokens[kind] ??= { off: 0, on: 0 })[layer] = measured.tokens;
        if (process.env.P13_CALIB)
          appendFileSync(
            process.env.P13_CALIB,
            `core-mcp ${kind} ${layer} tokens=${measured.tokens} bytes=${measured.bytes} mcpHash=${p.mcpHash ?? ''}\n`,
          );
        const first = trace.bodies.find((b) => b.includes(trace.brief)) ?? '';
        // Сервер MCP ядра поднялся и отдал инструменты вида: без них калибровка была бы без MCP.
        const plan = toolPlanFor(kind)!;
        for (const tool of plan.modelTools) expect(first).toContain(`mcp__agentdeck__${tool}`);
        expect(Object.keys(p.spec.mcpServers).sort()).toEqual(['agentdeck', 'agentdeck-permit']);
        expect(measured.tokens).toBeGreaterThan(0);
        expect(measured.tokens).toBeLessThanOrEqual(BASE_CEILING_CORE_MCP[kind]![layer]);
      }, 400_000);

  it('the trusted layer set costs the base its CLAUDE.md (the layer is part of the key)', () => {
    for (const kind of P13_KINDS) {
      const b = tokens[kind];
      expect(b?.off, `${kind} off measured`).toBeGreaterThan(0);
      expect(b?.on, `${kind} on measured`).toBeGreaterThan(0);
      if (!b) continue;
      expect(b.on - b.off).toBeGreaterThanOrEqual(Math.floor(Buffer.byteLength(CLAUDE_MD) / 4 / 2));
    }
  });
});
