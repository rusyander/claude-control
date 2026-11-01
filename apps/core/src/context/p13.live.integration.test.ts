import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import type { BriefPart } from './brief/brief.types.ts';
import { KIND_TOTAL } from './brief/brief.ts';
import { setHash, type BaseKey } from './base/index.ts';
import { sentAfter } from './sent/index.ts';
import { kindParts, P13_KINDS } from './__fixtures__/kind-parts.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from '../adapters/claude/claude.ts';
import {
  EventTap,
  hookCommand,
  liveRoot,
  liveSpec,
  type LiveRoot,
} from '../adapters/conformance/__fixtures__/live.ts';
import { hasCli } from '../stub-tasks/__fixtures__/e2e/stand.ts';
import { createContextWiring, probeOnStub } from '../bootstrap/economy-wiring/context.ts';
import type { LiveTask } from '../journal/resume.ts';

/**
 * P13 на живом Claude Code над заглушкой модели: вход первого хода = база (замер пробой на
 * заглушке, G9) + бриф; бриф в теле запроса ≤ итога вида, база ≤ откалиброванного потолка
 * по виду × набору слоя; второй ход несёт только изменённую секцию под меткой платформы, и
 * заголовок каждой секции встречается в теле разговора ровно один раз — ни одна не ушла дважды.
 *
 * Наборы слоя: `off` в недоверенной копии (ничего человека) и `on` в доверенной с CLAUDE.md
 * проекта — второй обязан стоить базы больше на сам файл (слой — часть ключа замера).
 */

const present = hasCli(claudeRunFacts.binary.command);
const roots: LiveRoot[] = [];
const stubs: StubModel[] = [];

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

/** CLAUDE.md проекта доверенного набора: ~2 КБ правил, как у небольшого репозитория. */
const CLAUDE_MD = `# Project rules\n${Array.from(
  { length: 40 },
  (_, i) => `- rule ${i}: keep LF endings and named exports in module ${i}`,
).join('\n')}\n`;

/**
 * Потолок базы, токенов (bytes/4), по виду × набору слоя — замер на claude 2.1.310 30.10.2026
 * (без сервера MCP ядра: его инструменты стенд не поднимает; база с ними, через дорогу ядра, —
 * `bootstrap/session-road.base.live.integration.test.ts`) + ~25 %: plan/review off 10 988,
 * on 11 679; work/fix off 12 485, on 13 175 (виды только чтения дешевле — у них нет инструментов
 * правки). CLI растит системную часть между версиями; рост сверх запаса — сигнал пересмотреть
 * рычаги базы, а не поднять потолок молча. Перемер: `P13_CALIB=<файл>` пишет замеры прогона.
 */
const BASE_CEILING: Record<string, Record<'off' | 'on', number>> = {
  plan: { off: 13_700, on: 14_600 },
  review: { off: 13_700, on: 14_600 },
  work: { off: 15_600, on: 16_500 },
  fix: { off: 15_600, on: 16_500 },
};

type LayerSet = 'off' | 'on';

function fakeTask() {
  const state = { sent: {} as Record<string, Record<string, string>>, bases: [] as BaseKey[] };
  const rows: { kind: string; data: Record<string, unknown> }[] = [];
  const task = {
    state,
    append(row: { kind: string; data: Record<string, unknown> }) {
      rows.push(row);
      if (row.kind === 'brief.sent') {
        const sid = row.data.sessionId as string;
        state.sent[sid] = sentAfter(
          state.sent[sid] ?? {},
          row.data.sections as { id: string; sha256: string; bytes: number }[],
        );
      }
      if (row.kind === 'context.base') state.bases.push(row.data as unknown as BaseKey);
    },
  };
  return { task: task as unknown as LiveTask, rows };
}

/** Сколько раз секция `## id` стоит в сыром теле (JSON экранирует перевод строки). */
const headerCount = (body: string, id: string): number => body.split(`## ${id}\\n`).length - 1;

async function runKind(kind: string, layer: LayerSet) {
  const live = liveRoot(`p13-${kind}-${layer}-`);
  roots.push(live);
  if (layer === 'on') writeFileSync(join(live.cwd, 'CLAUDE.md'), CLAUDE_MD);
  const plan = toolPlanFor(kind)!;
  const adapter = createClaudeAdapter();
  const overrides = {
    tools: plan.builtins,
    layer: { hooks: layer, skills: 'on' },
    coreHook: hookCommand('core', live.logs.core),
    // Недоверенная копия: источник — другой путь без отметки (F-86); доверенная — отметка панели.
    trust:
      layer === 'on'
        ? { sourceRepo: live.cwd, panelMark: true }
        : { sourceRepo: join(live.root, 'source'), panelMark: false },
  } as const;
  const bind = { channel: CLAUDE_CHANNELS[0]!, dialect: 'anthropic-messages' as const };
  const wiring = createContextWiring({ homeRoot: join(live.root, 'core-home') });
  const { task, rows } = fakeTask();

  const probeSpec = liveSpec(live, {
    ...overrides,
    core: { ...liveSpec(live).core, stepKind: kind },
  });
  const key: BaseKey = {
    adapter: 'claude',
    cliVersion: 'live',
    stepKind: kind,
    layerHash: setHash({ layer, claudeMd: layer === 'on' ? CLAUDE_MD : null }),
    mcpHash: setHash({ servers: [] }),
  };
  const base = await wiring.base(task, key, () => probeOnStub(adapter, probeSpec, bind));
  if (!base.ok) throw new Error(base.reason);

  const stub = await startStubModel({ script: () => 'ok' });
  stubs.push(stub);
  const spec = liveSpec(live, {
    ...overrides,
    core: { ...probeSpec.core, stepKind: kind },
    endpoint: {
      channel: bind.channel,
      endpoint: { baseUrl: stub.baseUrl, dialect: bind.dialect, model: 'stub-model', key: 'k' },
    },
  });
  const parts = kindParts(kind);
  const first = wiring.opening(task, spec.sessionId, parts, kind)!;
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  const bodyOf = (marker: string): string => {
    const hit = stub.bodies.filter((b) => b.includes(marker));
    return hit[hit.length - 1] ?? '';
  };
  let second: ReturnType<typeof wiring.opening>;
  try {
    await adapter.send(launched.handle, first.text, 'turn-1');
    await tap.until((e) => e.type === 'turn.ended', 120_000);
    const moved: BriefPart[] = [
      ...parts,
      { id: 'failing', text: 'unit tests on pkg: 1 red (hello.test.ts)', from: 'test' },
    ];
    second = wiring.opening(task, spec.sessionId, moved, kind);
    if (second) {
      await adapter.send(launched.handle, second.text, 'turn-2');
      await tap.until((e) => e.type === 'turn.ended', 120_000);
    }
  } finally {
    await adapter.stop(launched.handle, 'soft');
  }
  return {
    base: base.base,
    first,
    second,
    turn1: bodyOf(JSON.stringify(first.text).slice(1, 200)),
    turn2: second ? bodyOf(JSON.stringify(second.text).slice(1, 120)) : '',
    rows,
    parts,
  };
}

describe.skipIf(!present)('P13 on the real claude CLI over the stub model', () => {
  const bases: Record<string, Record<LayerSet, number>> = {};

  for (const kind of P13_KINDS)
    for (const layer of ['off', 'on'] as const)
      it(`${kind} × layer ${layer}: turn-1 = base + brief within budget; turn 2 carries the delta only`, async () => {
        const run = await runKind(kind, layer);
        (bases[kind] ??= { off: 0, on: 0 })[layer] = run.base.tokens;
        if (process.env.P13_CALIB)
          appendFileSync(
            process.env.P13_CALIB,
            `${kind} ${layer} tokens=${run.base.tokens} bytes=${run.base.bytes} brief=${run.first.sections.reduce((n, s) => n + s.bytes, 0)} turn1=${run.turn1.length}\n`,
          );
        // Бриф ушёл первым сообщением и целиком — в теле первого хода, ≤ итога вида.
        expect(run.first.form).toBe('brief');
        expect(run.turn1).toContain(JSON.stringify(run.first.text).slice(1, -1));
        const placed = run.first.sections.reduce((n, s) => n + s.bytes, 0);
        expect(placed).toBeLessThanOrEqual(KIND_TOTAL[kind]!);
        // База — замер пробой, не тело целиком: меньше тела первого хода на сам бриф.
        expect(run.base.tokens).toBeGreaterThan(0);
        expect(run.base.tokens).toBeLessThanOrEqual(BASE_CEILING[kind]![layer]);
        // Тело первого хода = база + бриф: замер не потерял и не удвоил бриф.
        expect(Math.abs(run.turn1.length - run.base.bytes - placed)).toBeLessThan(placed);
        // Второй ход: только новая секция, с меткой платформы.
        expect(run.second?.form).toBe('delta');
        expect(run.second?.sections.map((s) => s.id)).toEqual(['failing']);
        expect(run.turn2).not.toBe('');
        for (const p of run.parts) expect(headerCount(run.turn2, p.id)).toBe(1);
        expect(headerCount(run.turn2, 'failing')).toBe(1);
        expect(run.rows.filter((r) => r.kind === 'brief.sent')).toHaveLength(2);
        expect(run.rows.filter((r) => r.kind === 'context.base')).toHaveLength(1);
      }, 400_000);

  it('the trusted layer set costs the base its CLAUDE.md (the layer is part of the key)', () => {
    for (const kind of P13_KINDS) {
      const b = bases[kind];
      // Каждый вид обязан быть замерен в обоих наборах: пустой замер — не зелёный.
      expect(b?.off, `${kind} off measured`).toBeGreaterThan(0);
      expect(b?.on, `${kind} on measured`).toBeGreaterThan(0);
      if (!b) continue;
      expect(b.on - b.off).toBeGreaterThanOrEqual(Math.floor(Buffer.byteLength(CLAUDE_MD) / 4 / 2));
    }
  });
});
