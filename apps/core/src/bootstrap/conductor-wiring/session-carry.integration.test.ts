import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import type { CliAdapter, LayerRun, SessionHandle } from '../../adapters/adapter.types.ts';
import {
  CLAUDE_CHANNELS,
  createClaudeAdapter,
  refuseClaude,
} from '../../adapters/claude/claude.ts';
import { createQwenAdapter } from '../../adapters/qwen/qwen.ts';
import { liveRoot, liveSpec, type LiveRoot } from '../../adapters/conformance/__fixtures__/live.ts';
import {
  installReplay,
  readDump,
  replayEnv,
} from '../../adapters/conformance/__fixtures__/replay.ts';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import { decideRouting } from '../../conductor/scenario/index.ts';
import { presetStep } from '../../conductor/scenario/presets.ts';
import { CREATED, openFresh, SOLO_UNIT } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { sessionCarryRefusal } from '../session-road/session-carry-gate.ts';
import type { RoadStart } from '../session-road/road.types.ts';
import { stepStart } from './session-start.ts';

/**
 * Перенос слоя панели в сеанс ядра (G6) по настоящему пути: строка `task.created.session`
 * журнала → `stepStart` (слой и бриф шага) → суд дороги `sessionCarryRefusal` → НАСТОЯЩИЙ запуск
 * переходника Claude Code на подставном CLI (`replay-cli.mjs` под именем `claude` на PATH): argv и
 * файл брифа читаются из того, что увидел процесс, а не из плана в памяти. Модели нет вовсе.
 */

const CHAT: StepDef = presetStep('chat', 'chat', 'Чат', []);
const ROUTE = { adapter: 'claude', route: { kind: 'cli-login' as const, id: 'cli-login:claude' } };
const ENDPOINT = { baseUrl: 'http://127.0.0.1:9', model: 'stub-model', key: 'stub-key' };
const APPEND = 'G6_APPEND_MARKER: AgentDeck Tests section is on; kit rules follow.';

const open: { adapter: CliAdapter; handle: SessionHandle }[] = [];
afterAll(async () => {
  for (const { adapter, handle } of open) await adapter.stop(handle, 'tree').catch(() => undefined);
});

/** Каталог плагина набора: манифест без серверов MCP, по желанию — свой `.mcp.json` или поле. */
function pluginDir(
  live: LiveRoot,
  name: string,
  opts: { mcpFile?: boolean; manifestMcp?: boolean } = {},
): string {
  const dir = join(live.root, name);
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, ...(opts.manifestMcp ? { mcpServers: { x: { command: 'x' } } } : {}) }),
  );
  if (opts.mcpFile) writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
  return dir;
}

async function chatTask(
  session: Record<string, unknown>,
  copy: string,
): Promise<{ task: LiveTask; s: StepCtx }> {
  const { task } = await openFresh();
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: {
      ...CREATED,
      modelCeiling: 'sonnet',
      allowedRoutes: [{ ...ROUTE, modelPattern: '*' }],
      session,
    },
  });
  const unitId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: { unitId, repoKey: 'r1', branch: 'agentdeck/u', ownedPaths: [], ...SOLO_UNIT },
  });
  task.append({
    kind: 'resource.created',
    actor: 'core',
    unitId,
    data: {
      rid: newId(),
      kind: 'copy',
      owner: 'core',
      release: 'task-end',
      ref: JSON.stringify({ worktree: copy, repo: copy }),
    },
  });
  const stepId = newId();
  const s: StepCtx = {
    taskId: task.taskId,
    unitId,
    repoKey: 'r1',
    copyDir: null,
    stepId,
    def: CHAT,
    round: 0,
    sessionId: null,
    routing: decideRouting(task.state, { stepId, unitId, def: CHAT }),
  };
  return { task, s };
}

async function startOf(live: LiveRoot, session: Record<string, unknown>): Promise<RoadStart> {
  const { task, s } = await chatTask(session, live.cwd);
  const got = stepStart({ task, pin: { HOME: live.home } }, s, crypto.randomUUID());
  if (!got.ok) throw new Error(`stepStart refused: ${got.reason}`);
  return got.start;
}

/** Настоящий запуск переходника Claude на подставном CLI; argv и окружение — из дампа процесса. */
async function launchClaude(live: LiveRoot, start: RoadStart) {
  const bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, claudeRunFacts.binary.command);
  const dump = join(live.root, `dump-${newId()}.json`);
  // Подставной CLI хуков не исполняет: сеанс без хука ядра — только с флагом тестов (F-10).
  const adapter = createClaudeAdapter({ pollMs: 20, unhookedForTests: true });
  const base = liveSpec(live);
  const spec = liveSpec(live, {
    brief: start.brief,
    layer: start.layer,
    tools: start.tools,
    endpoint: {
      channel: CLAUDE_CHANNELS[0]!,
      endpoint: { ...ENDPOINT, dialect: 'anthropic-messages' as const },
    },
    env: {
      pin: { ...base.env.pin, ...replayEnv({ dump }) },
      session: { PATH: [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter) },
    },
  });
  const launched = await adapter.launch(spec);
  if (!launched.ok) return { refused: launched.reason, argv: [] as string[], spec };
  open.push({ adapter, handle: launched.handle });
  for (let i = 0; i < 1200 && !readDump(dump); i += 1) await new Promise((r) => setTimeout(r, 25));
  const seen = readDump(dump);
  if (!seen) throw new Error('the session CLI left no dump');
  await adapter.stop(launched.handle, 'tree');
  return { refused: null, argv: seen.argv, spec };
}

const valueOf = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
const valuesOf = (argv: string[], flag: string): string[] =>
  argv.flatMap((a, i) => (a === flag ? [argv[i + 1]!] : []));

describe('G6 panel layer carried into a core chat session (journal → stepStart → road gate → claude launch)', () => {
  it('append reaches the brief file; plugins, setting sources, builtin tools and skills off reach the CLI argv', async () => {
    const live = liveRoot('g6-carry-');
    const kit = pluginDir(live, 'kit');
    const start = await startOf(live, {
      append: APPEND,
      plugins: [kit],
      settingSources: ['project', 'local'],
      builtinTools: ['Read', 'Grep', 'Bash'],
      skills: 'off',
    });
    expect(start.layer).toMatchObject({
      skills: 'off',
      carry: {
        plugins: [kit],
        settingSources: ['project', 'local'],
        builtinTools: ['Read', 'Grep', 'Bash'],
      },
    });
    // Суд дороги: Claude объявил все три поля — отказа нет.
    expect(sessionCarryRefusal(start, createClaudeAdapter())).toBeNull();

    const { refused, argv } = await launchClaude(live, start);
    expect(refused).toBeNull();
    expect(valuesOf(argv, '--plugin-dir')).toContain(kit);
    expect(valueOf(argv, '--setting-sources')).toBe('project,local');
    expect(valueOf(argv, '--tools')).toBe('Read,Grep,Bash,ToolSearch');
    expect(argv).toContain('--disable-slash-commands');
    // Бриф — файл, который увидел CLI: бриф ядра, затем дописка вызывающего.
    const brief = readFileSync(valueOf(argv, '--append-system-prompt-file')!, 'utf8');
    expect(brief).toContain('agentdeck-step:');
    expect(brief).toContain(APPEND);
    expect(brief.indexOf('agentdeck-step:')).toBeLessThan(brief.indexOf(APPEND));
  }, 60_000);

  it('no carry in the journal — none of the carried flags appear', async () => {
    const live = liveRoot('g6-plain-');
    const start = await startOf(live, {});
    expect(start.layer.carry).toBeUndefined();
    const { argv } = await launchClaude(live, start);
    expect(argv).not.toContain('--plugin-dir');
    expect(argv).not.toContain('--setting-sources');
    expect(argv).not.toContain('--tools');
    expect(argv).not.toContain('--disable-slash-commands');
    expect(argv).not.toContain('--system-prompt-file');
  }, 60_000);

  // s10 G13 p7: прежний исполнитель клал промпт контура `--system-prompt-file` ВМЕСТО промпта CLI
  // (полный промпт Claude Code топит модель среднего класса); ядро несёт его тем же флагом.
  it('contour system prompt replaces the CLI prompt by file; the core brief still appends after it', async () => {
    const live = liveRoot('g13-system-prompt-');
    const contour = 'G13_CONTOUR_AGENT: you call tools as JSON {"tool":"x"}.\n\nG13_PREAMBLE';
    const start = await startOf(live, { systemPrompt: contour, append: APPEND });
    expect(start.layer.carry).toEqual({ systemPrompt: contour });
    expect(sessionCarryRefusal(start, createClaudeAdapter())).toBeNull();
    const { refused, argv } = await launchClaude(live, start);
    expect(refused).toBeNull();
    expect(readFileSync(valueOf(argv, '--system-prompt-file')!, 'utf8')).toBe(contour);
    const brief = readFileSync(valueOf(argv, '--append-system-prompt-file')!, 'utf8');
    expect(brief).toContain(APPEND);
    expect(brief).not.toContain('G13_CONTOUR_AGENT');
  }, 60_000);

  // s10 G14 p6: локальный слой проекта — своим полем; прочие переходники его не берут (отказ).
  it('project local layer: journal → layer.carry.localLayer → layer plugin flag, instructions after the brief; qwen refuses it by name', async () => {
    const live = liveRoot('g14-local-layer-');
    const plugin = pluginDir(live, 'layer');
    const localLayer = { plugin, instructions: 'G14_LOCAL_LAYER_TEXT' };
    const start = await startOf(live, { settingSources: ['user', 'local'], localLayer });
    expect(start.layer.carry).toEqual({ settingSources: ['user', 'local'], localLayer });
    expect(sessionCarryRefusal(start, createClaudeAdapter())).toBeNull();
    expect(sessionCarryRefusal({ ...start, adapterId: 'qwen' }, createQwenAdapter())).toBe(
      'session-carry-unsupported: adapter qwen cannot carry settingSources, localLayer — ' +
        'start the chat in a CLI that does, or drop the field',
    );
    const { refused, argv } = await launchClaude(live, start);
    expect(refused).toBeNull();
    expect(valuesOf(argv, '--plugin-dir')).toContain(plugin);
    expect(valueOf(argv, '--setting-sources')).toBe('user,local');
    const brief = readFileSync(valueOf(argv, '--append-system-prompt-file')!, 'utf8');
    expect(brief.indexOf('agentdeck-step:')).toBeLessThan(brief.indexOf('G14_LOCAL_LAYER_TEXT'));
  }, 60_000);

  it('brief none + append: the brief file holds the caller append without the core chat brief', async () => {
    const live = liveRoot('g6-append-only-');
    const start = await startOf(live, { brief: 'none', append: APPEND });
    expect(start.brief).toBe(APPEND);
    const { argv } = await launchClaude(live, start);
    // Файл брифа переходник метит своей строкой платформы; брифа шага ядра в нём нет.
    const brief = readFileSync(valueOf(argv, '--append-system-prompt-file')!, 'utf8');
    expect(brief).toContain(APPEND);
    expect(brief).not.toContain('agentdeck-step:');
  }, 60_000);
});

describe('G6 refusals: a carry the session cannot honour is refused by name, never dropped', () => {
  it('road gate: an adapter without sessionCarry → session-carry-unsupported naming the fields', async () => {
    const live = liveRoot('g6-unsupported-');
    const start = await startOf(live, { settingSources: ['project'], builtinTools: ['Read'] });
    expect(sessionCarryRefusal({ ...start, adapterId: 'qwen' }, createQwenAdapter())).toBe(
      'session-carry-unsupported: adapter qwen cannot carry settingSources, builtinTools — ' +
        'start the chat in a CLI that does, or drop the field',
    );
    const prompted = await startOf(live, { systemPrompt: 'P' });
    expect(sessionCarryRefusal({ ...prompted, adapterId: 'qwen' }, createQwenAdapter())).toBe(
      'session-carry-unsupported: adapter qwen cannot carry systemPrompt — ' +
        'start the chat in a CLI that does, or drop the field',
    );
  });

  it('road gate: plugins while the step runs hooks other than on → session-carry-plugins-without-hooks', async () => {
    const live = liveRoot('g6-hooks-off-');
    const start = await startOf(live, { plugins: [pluginDir(live, 'kit')] });
    const observed = { ...start, layer: { ...start.layer, hooks: 'observe' as const } };
    expect(sessionCarryRefusal(observed, createClaudeAdapter())).toMatch(
      /^session-carry-plugins-without-hooks: plugins carry hooks, the step runs hooks 'observe'/,
    );
  });

  it('claude launch: a plugin with its own .mcp.json or manifest mcpServers is refused before any process', async () => {
    const live = liveRoot('g6-plugin-mcp-');
    for (const [name, opts, why] of [
      ['mcp-file', { mcpFile: true }, '.mcp.json'],
      ['mcp-manifest', { manifestMcp: true }, 'plugin.json mcpServers'],
    ] as const) {
      const start = await startOf(live, { plugins: [pluginDir(live, name, opts)] });
      const { refused } = await launchClaude(live, start);
      expect(refused).toContain('session-carry-plugin: plugin declares MCP servers');
      expect(refused).toContain(why);
    }
    const missing = await startOf(live, { plugins: [join(live.root, 'absent')] });
    expect((await launchClaude(live, missing)).refused).toMatch(
      /^session-carry-plugin: plugin dir missing/,
    );
  }, 60_000);

  // G13: снижение `on` до `observe` недоверием к папке набор не отказывает (каталог панели, не
  // репозитория; прежняя панель ставила его везде) — отказ остаётся за `observe`, попрошенным шагом.
  it('claude: setting sources in an untrusted (observe) run ride as the core `` (no refusal); a step that asks observe itself → session-carry-needs-layer-on', async () => {
    const live = liveRoot('g6-observe-');
    const start = await startOf(live, { settingSources: ['project'] });
    const spec = liveSpec(live, { layer: start.layer, coreHook: 'node core.mjs' });
    const untrusted: LayerRun = {
      asked: 'on',
      ran: 'observe',
      repoLayer: false,
      trust: 'none',
      detail: 'no mark',
    };
    expect(refuseClaude(spec, {}, untrusted)).toBeNull();
    expect(refuseClaude(spec, {}, { ...untrusted, asked: 'observe' })).toMatch(
      /^session-carry-needs-layer-on:/,
    );
    // Тот же сеанс доверенным — отказа нет.
    expect(
      refuseClaude(spec, {}, { ...untrusted, ran: 'on', repoLayer: true, trust: 'panel' }),
    ).toBeNull();
  });
});
