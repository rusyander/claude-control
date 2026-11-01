import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { SendOrigin, SkillMode } from '@agentdeck/contracts/core/user-layer';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type StepFn, type StubModel } from '@agentdeck/stub-model';
import { recorderCommand } from '../../bootstrap/session-road/hook-file.ts';
import { DEFAULT_NODE_ARGV } from '../../bootstrap/session-road/road.ts';
import { currentOs } from '../../platform/os-kind.ts';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import type { AdapterEvent, LayerMode, LayerRun } from '../adapter.types.ts';
import {
  EventTap,
  liveRoot,
  liveSpec,
  readJsonLines,
  type LiveRoot,
} from '../conformance/__fixtures__/live.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from './claude.ts';

/**
 * Пробы слоя человека этапа 7 на живом Claude Code 2.1.310 над заглушкой модели (одноразовые дом,
 * каталог конфига и репозиторий; настоящий `~/.claude` не читается). Каждая проба — через
 * переходник ядра, ровно той дорогой, которой идёт сеанс:
 * - Q1 отказ PreToolUse хука человека (код 2 — с ключом описи; JSON `deny` — без) → `hook.refused`;
 *   отказ хука ЯДРА — никогда не `hook.refused`;
 * - Q2 блок UserPromptSubmit: ход отправки открыт и закрыт (насос не встал), отказ назван;
 * - Q3 петля Stop: по отказу — `hook.refused` с `cliInitiated`, один конец хода;
 * - Q4 `observe`/`off`: инструкции, правила, навыки, команды, агенты человека и репозитория доходят
 *   до модели без хуков; навык с хуками не подан — потеря названа;
 * - Q5 хук ядра срабатывает внутри подагента (`agent_id` во входе хука);
 * - Q6 навыки `off` — инструмента `Skill` и навыков нет, агенты остаются;
 * - Q8 метка платформы (и строка человека) доходит до хука (`prompt`) и модели байт в байт;
 * - P87: `observe` — запись исполнила хук человека, его отказ записан и не применён; `off` — хуков
 *   человека нет; хук ядра — в обоих.
 * Нет `claude` в PATH (контейнер Linux) — пропуск с причиной.
 */

const present = hasCli(claudeRunFacts.binary.command);
const HOOK = fileURLToPath(new URL('./__fixtures__/layer-hook.mjs', import.meta.url));
const roots: LiveRoot[] = [];
const stubs: StubModel[] = [];

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

const q = (value: string): string => `"${value}"`;

function put(file: string, text: string | object): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}

type Script = StepFn;

interface ProbeInput {
  prefix: string;
  mode: LayerMode;
  skills?: SkillMode;
  /** Хуки человека в `<config>/settings.json`: событие → [matcher, роль, режим, раз]. */
  userHooks?: Record<string, [string | null, string, string, number?][]>;
  coreMode?: 'allow' | 'exit2';
  plant?(live: LiveRoot, config: string): void;
  script: (live: LiveRoot) => Script;
  sends: { text: string; origin?: SendOrigin }[];
}

interface Probe {
  live: LiveRoot;
  log: string;
  layer: LayerRun;
  events: AdapterEvent[];
  ended: Extract<AdapterEvent, { type: 'turn.ended' }>[];
  stub: StubModel;
  hooks: { role: string; input: Record<string, unknown> }[];
  recorder: Record<string, unknown>[];
}

async function probe(input: ProbeInput): Promise<Probe> {
  const live = liveRoot(input.prefix);
  roots.push(live);
  const log = join(live.root, 'hooks.jsonl');
  const config = join(live.home, '.claude');
  const hook = (role: string, mode: string, times = 999) =>
    `${q(process.execPath)} ${q(HOOK)} ${role} ${q(log)} ${mode} ${times}`;
  const hooks: Record<string, unknown[]> = {};
  for (const [event, list] of Object.entries(input.userHooks ?? {})) {
    hooks[event] = list.map(([matcher, role, mode, times]) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: hook(role, mode, times) }],
    }));
  }
  put(join(config, 'settings.json'), { hooks });
  put(join(live.cwd, 'a.txt'), 'hello\n');
  input.plant?.(live, config);
  const stub = await startStubModel({ script: input.script(live) });
  stubs.push(stub);
  const adapter = createClaudeAdapter();
  const spec = liveSpec(live, {
    endpoint: {
      channel: CLAUDE_CHANNELS[0]!,
      endpoint: {
        baseUrl: stub.baseUrl,
        dialect: 'anthropic-messages',
        model: 'stub-model',
        key: 'k',
      },
    },
    layer: { hooks: input.mode, skills: input.skills ?? 'on' },
  });
  spec.coreHook = hook('core', input.coreMode ?? 'allow');
  mkdirSync(spec.dir, { recursive: true });
  const recorder = recorderCommand(spec.dir, DEFAULT_NODE_ARGV, currentOs());
  if (!recorder.ok) throw new Error(recorder.reason);
  spec.recorder = { command: recorder.command, log: join(spec.dir, 'hooks.log') };
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  const ended: Probe['ended'] = [];
  try {
    for (const send of input.sends) {
      const cmdId = crypto.randomUUID();
      await adapter.send(launched.handle, send.text, cmdId, send.origin);
      const end = await tap.until(
        (e) => e.type === 'turn.ended' && e.attribution === cmdId,
        120_000,
      );
      if (end.type === 'turn.ended') ended.push(end);
    }
  } finally {
    await adapter.stop(launched.handle, 'soft');
  }
  return {
    live,
    log,
    layer: launched.layer,
    events: tap.seen,
    ended,
    stub,
    hooks: readJsonLines(log) as Probe['hooks'],
    recorder: readJsonLines(spec.recorder.log),
  };
}

/** Боковые запросы CLI (заголовок, проверки) идут без инструментов — им простой ответ. */
const side = (ctx: { info: { tools: unknown[] } }): string | null =>
  ctx.info.tools.length === 0 ? 'side' : null;

/** Один вызов Read, затем текст. */
const readOnce =
  (done = 'DONE') =>
  (live: LiveRoot): Script =>
  (ctx) =>
    side(ctx) ??
    (ctx.info.hasToolResult
      ? done
      : { tool: { name: 'Read', args: { file_path: join(live.cwd, 'a.txt') } } });

const refusals = (events: AdapterEvent[]) =>
  events.filter(
    (e): e is Extract<AdapterEvent, { type: 'hook.refused' }> => e.type === 'hook.refused',
  );

const roles = (p: Probe) => [...new Set(p.hooks.map((h) => h.role))].sort();

describe.skipIf(!present)('stage 7 layer probes on the real claude CLI (live)', () => {
  it('Q1 PreToolUse: user exit 2 → hook.refused with its key; JSON deny → hook null; core refusal never', async () => {
    const exit2 = await probe({
      prefix: 'q1a-',
      mode: 'on',
      userHooks: { PreToolUse: [['Read', 'user', 'exit2']] },
      script: readOnce(),
      sends: [{ text: 'read it' }],
    });
    expect(refusals(exit2.events)).toEqual([
      expect.objectContaining({
        event: 'PreToolUse',
        hook: 'PreToolUse.0.0',
        reason: 'USER_EXIT2_REASON',
        toolUseId: expect.any(String),
        cliInitiated: false,
      }),
    ]);
    const json = await probe({
      prefix: 'q1b-',
      mode: 'on',
      userHooks: { PreToolUse: [['Read', 'user', 'json-deny']] },
      script: readOnce(),
      sends: [{ text: 'read it' }],
    });
    expect(refusals(json.events)).toEqual([
      expect.objectContaining({ event: 'PreToolUse', hook: null, reason: 'USER_JSON_REASON' }),
    ]);
    const core = await probe({
      prefix: 'q1c-',
      mode: 'on',
      coreMode: 'exit2',
      script: readOnce(),
      sends: [{ text: 'read it' }],
    });
    expect(core.events.some((e) => e.type === 'tool.result' && e.isError)).toBe(true);
    expect(refusals(core.events)).toEqual([]);
  }, 600_000);

  it('Q2 UserPromptSubmit block: the unechoed send gets its turn opened and ended, refusal named', async () => {
    const p = await probe({
      prefix: 'q2-',
      mode: 'on',
      userHooks: { UserPromptSubmit: [[null, 'ups', 'block', 1]] },
      script: () => (ctx) => side(ctx) ?? 'REPLY',
      sends: [{ text: 'first' }, { text: 'second' }],
    });
    // Ход заблокированной отправки кончается на `result` CLI (его текст — сообщение о блоке).
    expect(p.ended).toHaveLength(2);
    expect(p.ended[0]!.text).toContain('UserPromptSubmit operation blocked by hook');
    expect(p.ended[1]!.text).toBe('REPLY');
    expect(refusals(p.events)).toEqual([
      expect.objectContaining({
        event: 'UserPromptSubmit',
        reason: 'UPS_BLOCK_0',
        cliInitiated: false,
      }),
    ]);
  }, 600_000);

  it('Q3 Stop block loop: one cli-initiated refusal per block, one turn end', async () => {
    let n = 0;
    const p = await probe({
      prefix: 'q3-',
      mode: 'on',
      userHooks: { Stop: [[null, 'stop', 'block', 2]] },
      script: () => (ctx) => side(ctx) ?? `REPLY_${++n}`,
      sends: [{ text: 'go' }],
    });
    expect(p.ended).toHaveLength(1);
    expect(refusals(p.events)).toEqual([
      expect.objectContaining({ event: 'Stop', reason: 'STOP_BLOCK_0', cliInitiated: true }),
      expect.objectContaining({ event: 'Stop', reason: 'STOP_BLOCK_1', cliInitiated: true }),
    ]);
  }, 600_000);

  const MARKS = [
    'U_CLAUDEMD_MARK',
    'U_RULE_MARK',
    'U_SKILL_MARK',
    'U_CMD_MARK',
    'U_AGENT_MARK',
    'P_CLAUDEMD_MARK',
    'P_RULE_MARK',
    'P_SKILL_MARK',
    'P_AGENT_MARK',
  ];
  const plantLayer = (live: LiveRoot, config: string) => {
    const skill = (name: string, mark: string) =>
      `---\nname: ${name}\ndescription: ${mark} skill\n---\nbody\n`;
    const agent = (name: string, mark: string) =>
      `---\nname: ${name}\ndescription: ${mark} agent\nmodel: haiku\n---\nYou are ${mark}\n`;
    put(join(config, 'CLAUDE.md'), 'U_CLAUDEMD_MARK\n');
    put(join(config, 'rules', 'r.md'), 'U_RULE_MARK\n');
    put(join(config, 'skills', 'uskill', 'SKILL.md'), skill('uskill', 'U_SKILL_MARK'));
    put(
      join(config, 'skills', 'hooked', 'SKILL.md'),
      '---\nname: hooked\ndescription: HOOKED_SKILL_MARK skill\nhooks:\n  Stop: []\n---\nx\n',
    );
    put(join(config, 'commands', 'ucmd.md'), '---\ndescription: U_CMD_MARK command\n---\nbody\n');
    put(join(config, 'agents', 'uagent.md'), agent('uagent', 'U_AGENT_MARK'));
    put(join(live.cwd, 'CLAUDE.md'), 'P_CLAUDEMD_MARK\n');
    put(join(live.cwd, '.claude', 'rules', 'p.md'), 'P_RULE_MARK\n');
    put(join(live.cwd, '.claude', 'skills', 'pskill', 'SKILL.md'), skill('pskill', 'P_SKILL_MARK'));
    put(join(live.cwd, '.claude', 'agents', 'pagent.md'), agent('pagent', 'P_AGENT_MARK'));
  };
  const seen = (p: Probe) => {
    const all = p.stub.requests.map((r) => r.raw).join('\n');
    return MARKS.filter((m) => all.includes(m));
  };

  it.each(['observe', 'off'] as const)(
    'Q4 + P87 %s: every layer part reaches the model without hooks; core hook fires; hooked skill named lost',
    async (mode) => {
      const p = await probe({
        prefix: `q4-${mode}-`,
        mode,
        userHooks: {
          PreToolUse: [['Read', 'user', 'exit2']],
          UserPromptSubmit: [[null, 'ups', 'allow']],
        },
        plant: plantLayer,
        script: readOnce(),
        sends: [{ text: 'read it' }],
      });
      expect(p.layer).toMatchObject({ asked: mode, ran: mode });
      expect(seen(p)).toEqual(MARKS);
      expect(p.stub.requests.some((r) => r.raw.includes('HOOKED_SKILL_MARK'))).toBe(false);
      expect(p.layer.losses).toContain('skill hooked carries its own hooks, not re-supplied');
      // Хук ядра сработал; отказ хука человека не применён ни в одном режиме.
      expect(p.hooks.some((h) => h.role === 'core')).toBe(true);
      expect(p.ended[0]?.text).toBe('DONE');
      expect(refusals(p.events)).toEqual([]);
      if (mode === 'off') {
        expect(roles(p)).toEqual(['core']);
        expect(p.recorder).toEqual([]);
        return;
      }
      // observe: запись исполнила хуки человека (их строки есть), отказ записан как «отказал бы».
      expect(roles(p)).toEqual(['core', 'ups', 'user']);
      expect(p.recorder).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ hook: 'PreToolUse.0.0', decision: 'wouldBlock', exit: 2 }),
          expect.objectContaining({ hook: 'UserPromptSubmit.0.0', decision: 'allow', exit: 0 }),
        ]),
      );
    },
    600_000,
  );

  it('Q5 the core hook fires for a tool call inside a subagent (agent_id in its input)', async () => {
    const p = await probe({
      prefix: 'q5-',
      mode: 'off',
      script: (live) => (ctx) => {
        const s = side(ctx);
        if (s) return s;
        const sub = ctx.request.raw.includes('SUBAGENT_GO') && !ctx.request.tools.includes('Agent');
        if (sub) {
          return ctx.info.hasToolResult
            ? 'SUB_DONE'
            : { tool: { name: 'Read', args: { file_path: join(live.cwd, 'a.txt') } } };
        }
        if (ctx.info.hasToolResult) return 'MAIN_DONE';
        return {
          tool: {
            name: 'Agent',
            args: {
              description: 'probe',
              prompt: 'SUBAGENT_GO read a.txt',
              subagent_type: 'general-purpose',
              run_in_background: false,
            },
          },
        };
      },
      sends: [{ text: 'start' }],
    });
    const core = p.hooks.filter((h) => h.role === 'core').map((h) => h.input);
    expect(core.some((i) => i.tool_name === 'Agent' && i.agent_id === undefined)).toBe(true);
    expect(core.some((i) => i.tool_name === 'Read' && typeof i.agent_id === 'string')).toBe(true);
  }, 600_000);

  it('Q6 skills off: no Skill tool, no skill or command reaches the model; agents stay', async () => {
    const p = await probe({
      prefix: 'q6-',
      mode: 'off',
      skills: 'off',
      plant: plantLayer,
      script: () => (ctx) => side(ctx) ?? 'OK',
      sends: [{ text: 'hello' }],
    });
    const init = p.events.find((e) => e.type === 'init');
    expect(init?.type === 'init' ? init.tools : []).not.toContain('Skill');
    expect(seen(p)).not.toEqual(expect.arrayContaining(['U_SKILL_MARK']));
    expect(seen(p)).not.toEqual(expect.arrayContaining(['U_CMD_MARK']));
    expect(seen(p)).toEqual(expect.arrayContaining(['U_AGENT_MARK', 'P_AGENT_MARK']));
  }, 600_000);

  it('Q8 the platform marker and the human line reach the hook prompt and the model unchanged', async () => {
    const p = await probe({
      prefix: 'q8-',
      mode: 'on',
      userHooks: { UserPromptSubmit: [[null, 'ups', 'allow']] },
      script: () => (ctx) => side(ctx) ?? 'OK',
      sends: [{ text: 'HUMAN_WORD', origin: 'human' }, { text: 'PLATFORM_WORD' }],
    });
    const human = '<!-- agentdeck:platform -->\nagentdeck-from: human\nHUMAN_WORD';
    const platform = '<!-- agentdeck:platform -->\nPLATFORM_WORD';
    const prompts = p.hooks.filter((h) => h.role === 'ups').map((h) => h.input.prompt);
    expect(prompts).toEqual(expect.arrayContaining([human, platform]));
    // До модели — отдельной частью содержания байт в байт: свой `<system-reminder>` CLI кладёт
    // соседней частью, а не в наш текст.
    const parts = p.stub.requests.flatMap((r) =>
      ((r.body.messages ?? []) as { content: unknown }[]).flatMap((m) =>
        Array.isArray(m.content)
          ? (m.content as { type: string; text?: string }[])
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
          : [m.content],
      ),
    );
    expect(parts).toEqual(expect.arrayContaining([human, platform]));
  }, 600_000);
});
