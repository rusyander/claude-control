import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { sessionMcp } from '../../bootstrap/session-road/mcp-list.ts';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import type { SessionLayerCarry } from '../adapter.types.ts';
import {
  EventTap,
  hookCommand,
  liveRoot,
  livePin,
  liveSpec,
  type LiveRoot,
} from '../conformance/__fixtures__/live.ts';
import { carryLogs, CARRY_TOOL, PROBE_SERVER } from '../conformance/__fixtures__/mcp-carry-run.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from './claude.ts';

/**
 * Локальный слой проекта (карточка «Локальный слой» на «Проектах», s10 G14 p6) на НАСТОЯЩЕМ
 * Claude Code над заглушкой модели. Панель собирает слой в `<проект>/.agent/local-layer/build/`
 * (сжатые инструкции, плагин с навыками, `settings.json` с хуками и правами) и шлёт его полем
 * `session.localLayer` вместе с источниками `user,local`; путь «режим карточки → реестр → перенос»
 * доказывает серверный local-layer.carry.test.ts. Здесь — что видит модель:
 *
 * - слой включён: метка сжатых инструкций, навык плагина `project:<имя>` и вывод хука SessionStart
 *   слоя в запросе есть; метки командных оригиналов (`CLAUDE.md`, навык `.claude/skills`, хук
 *   `.claude/settings.json`) — нет: источник `project` снят, слой встал вместо него;
 * - слой выключен (переноса нет): наоборот — оригиналы есть, меток слоя нет;
 * - MCP: одобренный сервер `.mcp.json` проекта ядро предлагает своим чтением (`claudeMcpSource`)
 *   при любых источниках настроек — он доходит до модели в ОБОИХ случаях. Прежний исполнитель
 *   панели тоже давал его в обоих (слой — копией `--mcp-config`, без слоя — источником `project`).
 *
 * Нет `claude` в PATH (контейнер Linux) — пропуск с причиной.
 */

const present = hasCli(claudeRunFacts.binary.command);
const roots: LiveRoot[] = [];
const stubs: StubModel[] = [];

const MARK = {
  layerText: 'LOCAL_LAYER_COMPRESSED_MARKER',
  layerSkill: 'local-layer-skill-marker',
  layerHook: 'LOCAL_LAYER_HOOK_MARKER',
  teamText: 'TEAM_ORIGINAL_RULE_MARKER',
  teamSkill: 'team-original-skill-marker',
  teamHook: 'TEAM_ORIGINAL_HOOK_MARKER',
  mcp: 'local-layer-project-mcp',
} as const;

const MCP_TOOL = `mcp__${MARK.mcp}__${CARRY_TOOL}`;

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

const nodeHook = (script: string) => ({
  hooks: [{ type: 'command', command: `"${process.execPath}" "${script}"` }],
});

/**
 * Проект с командным слоем (оригиналы) и собранной копией слоя в раскладке сборки панели.
 * Возвращает поле переноса, которое панель положила бы для режима «Вкл.».
 */
function stand(prefix: string): { live: LiveRoot; carry: SessionLayerCarry } {
  const live = liveRoot(prefix);
  roots.push(live);
  const cwd = live.cwd;
  const write = (file: string, text: string): void => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };
  // Командный слой в репозитории.
  write(join(cwd, 'CLAUDE.md'), `# Team\n\n${MARK.teamText}\n`);
  write(
    join(cwd, '.claude', 'skills', MARK.teamSkill, 'SKILL.md'),
    `---\nname: ${MARK.teamSkill}\ndescription: team original skill\n---\n\nprobe\n`,
  );
  const teamHook = join(live.root, 'team-hook.mjs');
  writeFileSync(teamHook, `console.log(${JSON.stringify(MARK.teamHook)});\n`);
  write(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [nodeHook(teamHook)] } }),
  );
  // Сервер `.mcp.json`, одобренный человеком в его локальных настройках проекта.
  const logs = carryLogs(live);
  write(
    join(cwd, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        [MARK.mcp]: {
          command: process.execPath,
          args: [PROBE_SERVER],
          env: { PROBE_LOG: logs.carried, PROBE_TOOL: CARRY_TOOL },
        },
      },
    }),
  );
  write(
    join(cwd, '.claude', 'settings.local.json'),
    JSON.stringify({ enabledMcpjsonServers: [MARK.mcp] }),
  );
  // Сборка слоя (`.agent/local-layer/build/`): плагин `project` с навыком, хук слоя.
  const build = join(cwd, '.agent', 'local-layer', 'build');
  const plugin = join(build, 'plugin');
  write(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'project' }));
  write(
    join(plugin, 'skills', MARK.layerSkill, 'SKILL.md'),
    `---\nname: ${MARK.layerSkill}\ndescription: local layer skill\n---\n\nprobe\n`,
  );
  const layerHook = join(build, 'layer-hook.mjs');
  write(layerHook, `console.log(${JSON.stringify(MARK.layerHook)});\n`);
  return {
    live,
    carry: {
      settingSources: ['user', 'local'],
      localLayer: {
        plugin,
        instructions: `Contents of ${join(cwd, 'CLAUDE.md')} (project instructions, checked into the codebase):\n\n# Team\n\n${MARK.layerText}\n`,
        hooks: { SessionStart: [nodeHook(layerHook)] },
      },
    },
  };
}

interface Seen {
  body: string;
  argv: readonly string[];
}

/** Один ход переходника ядра: слой «Вкл.» (поле переноса) или «Выкл.» (переноса нет). */
async function runLayer(prefix: string, on: boolean): Promise<Seen> {
  const { live, carry } = stand(prefix);
  const stub = await startStubModel({ script: () => 'LAYER_OK' });
  stubs.push(stub);
  const adapter = createClaudeAdapter();
  const pin = livePin(live);
  const trust = { sourceRepo: live.cwd, panelMark: true };
  const read = adapter.mcpSource?.({ pin, cwd: live.cwd, trust });
  if (!read) throw new Error('claude adapter has no mcpSource');
  const base = liveSpec(live);
  const spec = liveSpec(live, {
    trust,
    endpoint: {
      channel: CLAUDE_CHANNELS[0]!,
      endpoint: {
        baseUrl: stub.baseUrl,
        dialect: 'anthropic-messages',
        model: 'stub-model',
        key: 'LAYER-ROUTE-TOKEN',
      },
    },
    coreHook: hookCommand('core', live.logs.core),
    mcpServers: sessionMcp('chat', 'stub', read, {}).human,
    layer: { ...base.layer, ...(on ? { carry } : {}) },
  });
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  try {
    await adapter.send(launched.handle, 'run the local layer probe', 'cmd-layer-1');
    await tap.until((e) => e.type === 'turn.ended', 120_000);
  } finally {
    await adapter.stop(launched.handle, 'soft');
  }
  return { body: stub.bodies.join('\n'), argv: launched.handle.spawned.argv };
}

describe.skipIf(!present)('claude adapter on the real CLI — the project local layer', () => {
  it('layer on: compressed instructions, the plugin skill and the layer hook reach the model; the team originals do not; the project MCP server does', async () => {
    const seen = await runLayer('claude-local-layer-on-', true);
    expect(seen.argv.join(' ')).toContain('--setting-sources user,local');
    expect(seen.body).toContain(MARK.layerText);
    expect(seen.body).toContain(`project:${MARK.layerSkill}`);
    expect(seen.body).toContain(MARK.layerHook);
    expect(seen.body).not.toContain(MARK.teamText);
    expect(seen.body).not.toContain(MARK.teamSkill);
    expect(seen.body).not.toContain(MARK.teamHook);
    expect(seen.body).toContain(MCP_TOOL);
  }, 200_000);

  it('layer off (no carry): the team originals reach the model; no layer mark does; the project MCP server does', async () => {
    const seen = await runLayer('claude-local-layer-off-', false);
    expect(seen.argv).not.toContain('--setting-sources');
    expect(seen.body).toContain(MARK.teamText);
    expect(seen.body).toContain(MARK.teamSkill);
    expect(seen.body).toContain(MARK.teamHook);
    expect(seen.body).not.toContain(MARK.layerText);
    expect(seen.body).not.toContain(MARK.layerSkill);
    expect(seen.body).not.toContain(MARK.layerHook);
    expect(seen.body).toContain(MCP_TOOL);
  }, 200_000);
});
