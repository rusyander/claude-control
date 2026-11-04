import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
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
import { CLAUDE_CHANNELS, createClaudeAdapter } from './claude.ts';
import { claudeConfigDir } from './user-layer.ts';

/**
 * Перенос слоя панели (`session-carry`, G6/G13) на живом Claude Code над заглушкой модели — то,
 * что прежде доказывал `tools/qa/check-run-layers.mjs` через реестр прогонов панели (тот путь
 * снят: прогоны ведёт ядро). Флаги наших слоёв панель переводит в поля сеанса
 * (`parsePanelArgs`, `session-carry.test.ts`); здесь — что ядро с каждым полем делает у
 * НАСТОЯЩЕГО CLI: в записанном запросе модели есть ровно то, что поле оставило.
 *
 * Метки: правила, навык и хук SessionStart человека — каталог конфига; правила проекта — `CLAUDE.md` в cwd;
 * сервер `.mcp.json` проекта — список MCP ядра строгий всегда (`--strict-mcp-config`); навык
 * плагина набора — `--plugin-dir`; промпт контура — `--system-prompt-file` вместо промпта CLI.
 * Нет `claude` в PATH (контейнер Linux) — пропуск с причиной.
 */

const present = hasCli(claudeRunFacts.binary.command);
const roots: LiveRoot[] = [];
const stubs: StubModel[] = [];

const MARK = {
  user: 'CARRY_USER_RULE_MARKER',
  userSkill: 'carry-user-skill-marker',
  userHook: 'CARRY_USER_HOOK_MARKER',
  project: 'CARRY_PROJECT_RULE_MARKER',
  projectMcp: 'carry-project-mcp',
  pluginSkill: 'carry-plugin-skill-marker',
  contour: 'CARRY_CONTOUR_PROMPT_MARKER',
} as const;

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

/**
 * Стенд с метками всех слоёв: человек, проект, `.mcp.json` проекта, плагин набора. `underHome` —
 * проект в доме человека (`~/proj`): поиск правил вверх от cwd доходит до `~` и видит там
 * `.claude/CLAUDE.md` — личный файл, который CLI прочёл бы правилами ПРОЕКТА `~`.
 */
function stand(prefix: string, underHome = false): { live: LiveRoot; plugin: string; cwd: string } {
  const live = liveRoot(prefix);
  roots.push(live);
  const config = claudeConfigDir(livePin(live));
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'CLAUDE.md'), `# Human\n\n${MARK.user}\n`);
  // Навык и хук человека: источник `user` CLI несёт их тем же флагом, что и правила.
  mkdirSync(join(config, 'skills', MARK.userSkill), { recursive: true });
  writeFileSync(
    join(config, 'skills', MARK.userSkill, 'SKILL.md'),
    `---\nname: ${MARK.userSkill}\ndescription: carry user skill\n---\n\nprobe\n`,
  );
  const hookScript = join(live.root, 'user-hook.mjs');
  writeFileSync(hookScript, `console.log(${JSON.stringify(MARK.userHook)});\n`);
  writeFileSync(
    join(config, 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `"${process.execPath}" "${hookScript}"` }] },
        ],
      },
    }),
  );
  const cwd = underHome ? join(live.home, 'proj') : live.cwd;
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'CLAUDE.md'), `# Project\n\n${MARK.project}\n`);
  // Сервер, который поднялся бы без строгого списка: команда настоящая (node), вывода нет.
  writeFileSync(
    join(cwd, '.mcp.json'),
    JSON.stringify({
      mcpServers: { [MARK.projectMcp]: { command: process.execPath, args: ['-e', ''] } },
    }),
  );
  const plugin = join(live.root, 'kit');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'carrykit' }),
  );
  mkdirSync(join(plugin, 'skills', MARK.pluginSkill), { recursive: true });
  writeFileSync(
    join(plugin, 'skills', MARK.pluginSkill, 'SKILL.md'),
    `---\nname: ${MARK.pluginSkill}\ndescription: carry probe skill\n---\n\nprobe\n`,
  );
  return { live, plugin, cwd };
}

interface Seen {
  body: string;
  tools: string[];
  /** Тексты блоков системного промпта запроса. */
  system: string[];
  argv: readonly string[];
}

/** Один ход переходника ядра со своим переносом; тело первого запроса модели и argv запуска. */
async function runCarry(
  prefix: string,
  carry?: (plugin: string) => SessionLayerCarry,
  underHome = false,
): Promise<Seen> {
  const { live, plugin, cwd } = stand(prefix, underHome);
  const stub = await startStubModel({ script: () => 'CARRY_OK' });
  stubs.push(stub);
  const adapter = createClaudeAdapter();
  const base = liveSpec(live);
  const spec = liveSpec(live, {
    cwd,
    trust: { sourceRepo: cwd, panelMark: true },
    endpoint: {
      channel: CLAUDE_CHANNELS[0]!,
      endpoint: {
        baseUrl: stub.baseUrl,
        dialect: 'anthropic-messages',
        model: 'stub-model',
        key: 'CARRY-ROUTE-TOKEN',
      },
    },
    coreHook: hookCommand('core', live.logs.core),
    layer: { ...base.layer, ...(carry ? { carry: carry(plugin) } : {}) },
  });
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  try {
    await adapter.send(launched.handle, 'run the carry probe', 'cmd-carry-1');
    await tap.until((e) => e.type === 'turn.ended', 120_000);
  } finally {
    await adapter.stop(launched.handle, 'soft');
  }
  const body = stub.bodies[0] ?? '';
  const parsed = JSON.parse(body) as {
    tools?: { name: string }[];
    system?: { text: string }[];
  };
  return {
    body,
    tools: (parsed.tools ?? []).map((t) => t.name),
    system: (parsed.system ?? []).map((b) => b.text),
    argv: launched.handle.spawned.argv,
  };
}

/** Строка, которую CLI ставит перед любым системным промптом, свой он или с `--system-prompt-file`. */
const CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude";
const BILLING = 'x-anthropic-billing-header';

describe.skipIf(!present)('claude adapter on the real CLI — the panel layer carry', () => {
  it('no carry (layer on): human rules, skill and hook and the project rules reach the model; the project .mcp.json server never does', async () => {
    const seen = await runCarry('claude-carry-base-');
    expect(seen.argv).toContain('--strict-mcp-config');
    expect(seen.body).toContain(MARK.user);
    expect(seen.body).toContain(MARK.userSkill);
    expect(seen.body).toContain(MARK.userHook);
    expect(seen.body).toContain(MARK.project);
    expect(seen.tools.some((name) => name.includes(MARK.projectMcp))).toBe(false);
    expect(seen.body).not.toContain(MARK.pluginSkill);
    // Без промпта контура CLI шлёт свой длинный промпт — обратная сторона случая `systemPrompt`.
    expect(seen.system.filter((t) => !t.startsWith(BILLING)).join('').length).toBeGreaterThan(5000);
  }, 200_000);

  it('settingSources project,local (our rules off): human rules, skill and hook are gone, the project rules stay', async () => {
    const seen = await runCarry('claude-carry-sources-', () => ({
      settingSources: ['project', 'local'],
    }));
    expect(seen.body).not.toContain(MARK.user);
    expect(seen.body).not.toContain(MARK.userSkill);
    expect(seen.body).not.toContain(MARK.userHook);
    expect(seen.body).toContain(MARK.project);
    expect(seen.argv.join(' ')).toContain('--setting-sources project,local');
  }, 200_000);

  it('settingSources project,local with the project under the home: the personal CLAUDE.md never comes back as project rules of ~', async () => {
    const seen = await runCarry(
      'claude-carry-home-',
      () => ({ settingSources: ['project', 'local'] }),
      true,
    );
    expect(seen.body).toContain(MARK.project);
    expect(seen.body).not.toContain(MARK.user);
  }, 200_000);

  it('builtinTools: the model sees only the listed built-ins (ToolSearch only when tools are deferred)', async () => {
    const seen = await runCarry('claude-carry-tools-', () => ({ builtinTools: ['Read', 'Grep'] }));
    const builtins = seen.tools.filter((name) => !name.startsWith('mcp__'));
    expect(builtins).toEqual(expect.arrayContaining(['Read', 'Grep']));
    expect(builtins.filter((name) => !['Read', 'Grep', 'ToolSearch'].includes(name))).toEqual([]);
  }, 200_000);

  it('plugins: the kit plugin skill reaches the model through --plugin-dir', async () => {
    const seen = await runCarry('claude-carry-plugin-', (plugin) => ({ plugins: [plugin] }));
    expect(seen.argv).toContain('--plugin-dir');
    expect(seen.body).toContain(MARK.pluginSkill);
  }, 200_000);

  it('systemPrompt: the contour prompt replaces the CLI prompt; the core brief follows it', async () => {
    const seen = await runCarry('claude-carry-contour-', () => ({
      systemPrompt: `You are a contour agent. ${MARK.contour}`,
    }));
    // Кроме строки учёта и обязательной строки CLI — один блок: промпт контура, за ним бриф ядра.
    // Свой промпт CLI (правила тона, инструментов, окружения) в запрос не попал.
    const rest = seen.system.filter((text) => !text.startsWith(BILLING));
    expect(rest).toHaveLength(2);
    expect(rest[0]?.startsWith(CLI_IDENTITY)).toBe(true);
    expect(rest[0]!.length).toBeLessThan(200);
    expect(rest[1]?.startsWith(`You are a contour agent. ${MARK.contour}`)).toBe(true);
    expect(rest[1]).toContain('BRIEF_MARKER');
  }, 200_000);
});
