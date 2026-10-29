import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import type {
  AdapterCaps,
  AdapterEvent,
  CliAdapter,
  SessionHandle,
  SessionSpec,
} from '../adapter.types.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from '../claude/claude.ts';
import { claudeAbsolutePattern } from '../claude/permission.ts';
import { qwenPathPattern } from '../qwen/permission.ts';
import { PUBLISH_COMMANDS } from '../deny-overlay.ts';
import { createAdapterRegistry } from '../index.ts';
import { createQwenAdapter, QWEN_CHANNELS } from '../qwen/qwen.ts';
import type { SdkAdapter, SdkAdapterOptions } from '../sdk-stream/sdk-adapter.ts';
import { EventTap, liveFacts, liveRoot, liveSpec, type LiveRoot } from './__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
  replayEnv,
  type ReplayRun,
} from './__fixtures__/replay.ts';

/**
 * Набор соответствия (03 §CLI adapter, R:PR-09, P121): одни и те же случаи для каждого
 * переходника, каждый — через настоящий запуск (платформа, хост сессии, насос) подставного CLI,
 * который проигрывает ЗАПИСЬ живого CLI в ответ на настоящий stdin переходника. Случай требует
 * возможностей; возможность, объявленная без случая, — красное.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

interface Profile {
  id: string;
  make(options: SdkAdapterOptions): SdkAdapter;
  command: string;
  endpoint: SessionSpec['endpoint'];
  fixtures: {
    basic: string;
    resume: { name: string; cmdId: string };
    missing: Omit<ReplayRun, 'dump'>;
    deny: string;
    refused: string;
    permitAllow?: string;
    permitDeny?: string;
    wake?: string;
    /** Запрет оверлея при разрешающем сервере права: CLI отказывает сам, вопроса нет. */
    denyOverPermit?: string;
  };
  /** Файл сеанса с правилами запрета (относительно каталога сеанса). */
  settings: string;
  denyRules(settings: Record<string, unknown>): string[];
  /** Строгий список MCP: что видит CLI из argv и файлов сеанса. */
  mcpNames(argv: string[], dir: string): string[];
  hookCommands(settings: Record<string, unknown>): string[];
  shellRule(argv: readonly string[]): string;
  /** Правило запрета пути в словаре CLI (форма пути у каждого своя). */
  pathRule(cwd: string, path: string, op: 'read' | 'edit'): string;
  /** Как CLI спрашивает о праве: инструментом сервера или строкой протокола. */
  permitRoad: 'tool' | 'in-band';
}

const ENDPOINT = { baseUrl: 'http://127.0.0.1:9', model: 'stub-model', key: 'stub-key' };

const after = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

const PROFILES: Profile[] = [
  {
    id: claudeRunFacts.id,
    // Подставной CLI хуков не исполняет: сеанс без хука ядра — только с явным флагом тестов (F-10).
    make: (options) => createClaudeAdapter({ ...options, unhookedForTests: true }),
    command: claudeRunFacts.binary.command,
    endpoint: {
      channel: CLAUDE_CHANNELS[0]!,
      endpoint: { ...ENDPOINT, dialect: 'anthropic-messages' },
    },
    fixtures: {
      basic: 'basic',
      resume: { name: 'resume', cmdId: B },
      missing: {
        fixture: fixturePath('claude', 'missing'),
        eager: true,
        exit: 1,
        stderr: 'No conversation found with session ID: 33333333-3333-4333-8333-333333333333',
      },
      deny: 'deny',
      refused: 'permit',
      wake: 'bg-permit-allow',
      denyOverPermit: 'deny-permit-allow',
    },
    settings: 'claude/settings.json',
    denyRules: (s) => (s.permissions as { deny: string[] }).deny,
    mcpNames: (argv) =>
      Object.keys(
        (JSON.parse(readFileSync(after(argv, '--mcp-config')!, 'utf8')) as { mcpServers: object })
          .mcpServers,
      ),
    hookCommands: (s) =>
      ((s.hooks as { PreToolUse?: { hooks: { command: string }[] }[] }).PreToolUse ?? []).flatMap(
        (g) => g.hooks.map((h) => h.command),
      ),
    shellRule: (argv) => `Bash(${argv.join(' ')}:*)`,
    pathRule: (_cwd, path, op) =>
      `${op === 'read' ? 'Read' : 'Edit'}(${claudeAbsolutePattern(path)})`,
    permitRoad: 'tool',
  },
  {
    id: qwenRunFacts.id,
    // Подставной CLI хуков не исполняет: сеанс без хука ядра — только с явным флагом тестов (F-10).
    make: (options) => createQwenAdapter({ ...options, unhookedForTests: true }),
    command: qwenRunFacts.binary.command,
    endpoint: {
      channel: QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat')!,
      endpoint: { ...ENDPOINT, dialect: 'openai-chat' },
    },
    fixtures: {
      basic: 'basic',
      resume: { name: 'resume', cmdId: A },
      missing: { exit: 1, stderr: 'No saved session found with ID 33333333' },
      deny: 'readdeny',
      refused: 'shell',
      permitAllow: 'permit-core-allow',
      permitDeny: 'permit-core-deny',
    },
    settings: 'qwen/system-settings.json',
    denyRules: (s) => (s.permissions as { deny: string[] }).deny,
    mcpNames: (argv) => {
      const at = argv.indexOf('--allowed-mcp-server-names');
      const out: string[] = [];
      for (let i = at + 1; i < argv.length && !argv[i]!.startsWith('--'); i += 1) {
        if (argv[i]) out.push(argv[i]!);
      }
      return out;
    },
    hookCommands: (s) =>
      (
        (s.hooks as { PreToolUse?: { hooks: { command: string }[] }[] } | undefined)?.PreToolUse ??
        []
      ).flatMap((g) => g.hooks.map((h) => h.command)),
    shellRule: (argv) => `run_shell_command(${argv.join(' ')}:*)`,
    pathRule: (cwd, path, op) =>
      `${op === 'read' ? 'read_file' : 'edit'}(${qwenPathPattern(cwd, path)})`,
    permitRoad: 'in-band',
  },
];

type BoolCap = {
  [K in keyof AdapterCaps]: AdapterCaps[K] extends boolean ? K : never;
}[keyof AdapterCaps];

interface Stand {
  live: LiveRoot;
  bin: string;
}

const stands = new Map<string, Stand>();
const open: { adapter: CliAdapter; handle: SessionHandle }[] = [];

function stand(profile: Profile): Stand {
  const known = stands.get(profile.id);
  if (known) return known;
  const live = liveRoot(`adp-cf-${profile.id}-`);
  const bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, profile.command);
  const made = { live, bin };
  stands.set(profile.id, made);
  return made;
}

let runs = 0;

async function run(
  profile: Profile,
  replay: Omit<ReplayRun, 'dump'>,
  over: Partial<SessionSpec> = {},
): Promise<{
  adapter: SdkAdapter;
  handle: SessionHandle;
  tap: EventTap;
  dump: () => NonNullable<ReturnType<typeof readDump>>;
  spec: SessionSpec;
}> {
  const { live, bin } = stand(profile);
  runs += 1;
  const dumpFile = join(live.root, `dump-${runs}.json`);
  const adapter = profile.make({ pollMs: 20 });
  const base = liveSpec(live);
  const spec = liveSpec(live, {
    endpoint: profile.endpoint,
    ...over,
    env: {
      pin: { ...base.env.pin, ...replayEnv({ ...replay, dump: dumpFile }) },
      // PATH сеанса главнее PATH пина: подставной CLI — первым, node — для его обёртки.
      session: { PATH: [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter) },
    },
  });
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(`launch refused: ${launched.reason}`);
  open.push({ adapter, handle: launched.handle });
  return {
    adapter,
    handle: launched.handle,
    tap: new EventTap(adapter, launched.handle),
    spec,
    dump: () => {
      const d = readDump(dumpFile);
      if (!d) throw new Error('replay CLI never started');
      return d;
    },
  };
}

const fx = (profile: Profile, name: string) => ({ fixture: fixturePath(profile.id, name) });
const settingsOf = (handle: SessionHandle, profile: Profile): Record<string, unknown> =>
  JSON.parse(readFileSync(join(handle.dir, profile.settings), 'utf8')) as Record<string, unknown>;
const ended = (e: AdapterEvent) => e.type === 'turn.ended';

async function waitFor<T>(probe: () => T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface Case {
  name: string;
  needs: BoolCap[];
  /** Только для переходника с этой дорогой вопроса о праве. */
  road?: Profile['permitRoad'];
  /**
   * Свой признак применимости сверх возможностей: случай без него у переходника — пропуск
   * (`skipIf`), а не зелёный прогон без единой проверки (F-79: ранний `return` в `run`).
   */
  when?: (profile: Profile) => boolean;
  run(profile: Profile): Promise<void>;
}

/**
 * Случай исполняется у переходника — ОДНО правило и для прогона, и для мета-проверки P121:
 * мета-проверка раньше считала случай по `needs.includes(cap)`, а прогон — по `needs.every`,
 * и возможность, чей единственный случай требует ещё и необъявленную, «покрыта» пропущенным.
 */
function caseApplies(
  c: Case,
  caps: Partial<Record<BoolCap, boolean>>,
  road: Profile['permitRoad'],
  profile?: Profile,
): boolean {
  if (!c.needs.every((cap) => caps[cap] === true)) return false;
  if (c.road && c.road !== road) return false;
  return !(c.when && profile && !c.when(profile));
}

/** Случаи, которые ИСПОЛНЯЮТ возможность `cap` у переходника с этими возможностями. */
function casesExercising(
  cases: readonly Case[],
  cap: BoolCap,
  caps: Partial<Record<BoolCap, boolean>>,
  road: Profile['permitRoad'],
): Case[] {
  return cases.filter((c) => c.needs.includes(cap) && caseApplies(c, caps, road));
}

const CASES: Case[] = [
  {
    name: 'two turns stream text and end attributed to our sends; a repeated cmdId is a dup',
    needs: ['stream', 'attribution'],
    async run(p) {
      const r = await run(p, fx(p, p.fixtures.basic));
      expect(await r.adapter.send(r.handle, 'hello one', A)).toEqual({ dup: false });
      expect(await r.adapter.send(r.handle, 'hello one', A)).toEqual({ dup: true });
      const first = await r.tap.until(ended);
      expect(first).toMatchObject({ attribution: A, isError: false });
      await r.adapter.send(r.handle, 'second', B);
      expect(await r.tap.until(ended)).toMatchObject({ attribution: B });
      expect(r.tap.seen.some((e) => e.type === 'text.delta')).toBe(true);
      expect(r.tap.seen.find((e) => e.type === 'init')).toMatchObject({ model: 'stub-model' });
      expect(r.adapter.usage(r.handle).length).toBeGreaterThanOrEqual(2);
      const users = r.dump().stdin.filter((l) => l.type === 'user');
      expect(users.map((l) => l.uuid)).toEqual([A, B]);
      expect(r.adapter.session(r.handle)?.conversationId).toBeTruthy();
      expect(await r.adapter.stop(r.handle, 'soft')).toMatchObject({ how: 'exited', code: 0 });
    },
  },
  {
    name: 'the endpoint binding reaches the CLI env; argv carries stream-json and the session id',
    needs: ['stream'],
    async run(p) {
      const r = await run(p, fx(p, p.fixtures.basic));
      await r.adapter.send(r.handle, 'hello', A);
      await r.tap.until(ended);
      const d = r.dump();
      const env = Object.values(d.env);
      expect(env).toContain('stub-key');
      expect(env).toContain('stub-model');
      expect(env.some((v) => v.startsWith('http://127.0.0.1:9'))).toBe(true);
      expect(after(d.argv, '--input-format')).toBe('stream-json');
      expect(after(d.argv, '--session-id')).toBe(r.spec.sessionId);
      // Одна папка в любой записи пути (короткое имя 8.3 у temp на Windows).
      expect(realpathSync.native(d.cwd)).toBe(realpathSync.native(r.spec.cwd));
      await r.adapter.stop(r.handle, 'soft');
    },
  },
  {
    name: 'resume: the conversation id reaches argv and the delta turn is ours',
    needs: ['resume'],
    async run(p) {
      const r = await run(p, fx(p, p.fixtures.resume.name), {
        resume: { conversationId: 'conv-prev' },
      });
      await r.adapter.send(r.handle, 'delta', p.fixtures.resume.cmdId);
      expect(await r.tap.until(ended)).toMatchObject({ attribution: p.fixtures.resume.cmdId });
      expect(after(r.dump().argv, '--resume')).toBe('conv-prev');
      expect(r.dump().argv).not.toContain('--session-id');
      await r.adapter.stop(r.handle, 'soft');
    },
  },
  {
    name: 'resume of a missing conversation is fresh-required, once, then the exit',
    needs: ['resume'],
    async run(p) {
      const r = await run(p, p.fixtures.missing, { resume: { conversationId: 'gone' } });
      await r.tap.until((e) => e.type === 'error' && e.code === 'fresh-required');
      // Поток кончается; отказ назван ровно раз (строкой потока или текстом при выходе).
      await expect(r.tap.until(() => false, 20_000)).rejects.toThrow(/stream ended/);
      const errors = r.tap.seen
        .filter((e) => e.type === 'error')
        .map((e) => e.type === 'error' && e.code);
      expect(errors.filter((code) => code === 'fresh-required')).toHaveLength(1);
      expect(errors.every((code) => code === 'fresh-required' || code === 'exited')).toBe(true);
      await expect(r.adapter.send(r.handle, 'late', A)).rejects.toThrow(/session ended/);
    },
  },
  {
    name: 'deny overlay: platform denials in every session; a denied read surfaces as a denied ask',
    needs: ['denyOverlay'],
    async run(p) {
      const r = await run(p, fx(p, p.fixtures.deny), {
        deny: { paths: [join(r0(p).root, 'secret.txt')], commands: [], mcpTools: [], tools: [] },
      });
      await r.adapter.send(r.handle, 'READ_SECRET now', A);
      await r.tap.until(ended);
      expect(r.tap.seen.find((e) => e.type === 'ask')).toMatchObject({
        ask: { action: 'read' },
        denied: true,
      });
      const rules = p.denyRules(settingsOf(r.handle, p));
      // Платформа: публикация каждой дорогой — без единого слова о ней в шаге.
      for (const argv of PUBLISH_COMMANDS) expect(rules).toContain(p.shellRule(argv));
      const facts = liveFacts(r0(p));
      const pathRules = rules.filter((x) => /\(/.test(x) && !x.includes(':*'));
      // Дом ядра, токен панели и путь шага — каждый в правилах чтения и правки.
      for (const leaf of [facts.coreHome, ...facts.tokenFiles, 'secret.txt'].map((x) =>
        x.split(/[\\/]/).pop(),
      )) {
        expect(pathRules.filter((x) => x.includes(leaf!)).length).toBeGreaterThanOrEqual(4);
      }
      await r.adapter.stop(r.handle, 'soft');
    },
  },
  {
    name: 'deny overlay beats an allowing permit road: the denied read never reaches the permit tool',
    needs: ['denyOverlay', 'permissionTool'],
    road: 'tool',
    // Запись есть только у claude (F-79: файл лежал без единого читателя).
    when: (p) => p.fixtures.denyOverPermit !== undefined,
    async run(p) {
      const r = await run(p, fx(p, p.fixtures.denyOverPermit!), {
        deny: { paths: [join(r0(p).root, 'secret.txt')], commands: [], mcpTools: [], tools: [] },
        permitServer: { name: 'agentdeck-permit', tool: 'approve' },
      });
      await r.adapter.send(r.handle, 'READ_SECRET now', A);
      expect(await r.tap.until(ended)).toMatchObject({ attribution: A });
      const asks = r.tap.seen.filter((e) => e.type === 'ask');
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({ ask: { action: 'read' }, denied: true });
      // Сервер права разрешил бы — но вопроса ему не было: ни одного ответа ядра в stdin CLI.
      expect(r.dump().stdin.filter((l) => l.type === 'control_response')).toEqual([]);
      expect(p.denyRules(settingsOf(r.handle, p))).toContain(
        p.pathRule(r0(p).root, join(r0(p).root, 'secret.txt'), 'read'),
      );
      await r.adapter.stop(r.handle, 'soft');
    },
  },
  {
    name: "the copy's git dir, its worktree gitdir and common dir are edit-denied over a user allow Edit; reads stay",
    needs: ['denyOverlay'],
    async run(p) {
      const root = r0(p).root;
      runs += 1;
      const main = join(root, `main-repo-${runs}`, '.git');
      const gitdir = join(main, 'worktrees', 'wt');
      const copy = join(root, `copy-wt-${runs}`);
      mkdirSync(gitdir, { recursive: true });
      mkdirSync(join(copy, '.claude'), { recursive: true });
      writeFileSync(join(copy, '.git'), `gitdir: ${gitdir}\n`);
      writeFileSync(join(gitdir, 'commondir'), '../..\n');
      // Слой человека разрешает правку целиком: оверлей ядра всё равно старше. Файл — самого
      // человека: разрешения репозитория в сеанс не переносятся (F-32).
      mkdirSync(join(r0(p).home, '.claude'), { recursive: true });
      writeFileSync(
        join(r0(p).home, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Edit'] } }),
      );
      const layered = p.make({}).caps.layerControl;
      const r = await run(p, fx(p, p.fixtures.basic), {
        cwd: copy,
        layer: { hooks: layered ? 'off' : 'on' },
      });
      const settings = settingsOf(r.handle, p);
      const rules = p.denyRules(settings);
      for (const dir of [join(copy, '.git'), gitdir, main]) {
        expect(rules).toContain(p.pathRule(copy, dir, 'edit'));
        expect(rules).toContain(`${p.pathRule(copy, dir, 'edit').slice(0, -1)}/**)`);
        expect(rules).not.toContain(p.pathRule(copy, dir, 'read'));
      }
      if (layered) {
        expect((settings.permissions as { allow?: string[] }).allow).toContain('Edit');
      }
      await r.adapter.stop(r.handle, 'soft');
    },
  },
  {
    name: 'a permission question with no answerer is refused at once',
    needs: ['permissionTool'],
    async run(p) {
      const r = await run(p, fx(p, p.fixtures.refused));
      await r.adapter.send(r.handle, 'RUN_SHELL now', A);
      await r.tap.until(ended);
      const asks = r.tap.seen.filter((e) => e.type === 'ask');
      expect(asks[0]).toMatchObject({
        ask: { action: 'exec', argv: ['node', '-e', expect.any(String)] },
        denied: true,
      });
      if (p.permitRoad === 'in-band') {
        const reply = r.dump().stdin.find((l) => l.type === 'control_response') as {
          response: { response: { behavior: string } };
        };
        expect(reply.response.response.behavior).toBe('deny');
        expect(r.tap.seen.some((e) => e.type === 'permit.request')).toBe(false);
      } else {
        expect(after(r.dump().argv, '--permission-prompts')).toBe('none');
      }
      await r.adapter.stop(r.handle, 'soft');
    },
  },
  {
    name: 'the core answers the in-band permission question: allow and deny reach the CLI in its shape',
    needs: ['permissionTool'],
    road: 'in-band',
    async run(p) {
      for (const [name, allow] of [
        [p.fixtures.permitAllow!, true],
        [p.fixtures.permitDeny!, false],
      ] as const) {
        const r = await run(p, fx(p, name), {
          permitServer: { name: 'agentdeck-permit', tool: 'approve' },
          mcpServers: { 'agentdeck-permit': { command: process.execPath, args: ['x.mjs'] } },
        });
        await r.adapter.send(r.handle, 'RUN_SHELL now', A);
        const ask = await r.tap.until((e) => e.type === 'permit.request');
        if (ask.type !== 'permit.request') throw new Error('unreachable');
        const read = r.adapter.permitCodec.read(ask.raw);
        expect(read?.call.tool).toBe('run_shell_command');
        await r.adapter.answerPermit!(
          r.handle,
          ask.requestId,
          r.adapter.permitCodec.render(
            allow ? { allow: true, input: read!.call.input } : { allow: false, message: 'no' },
          ),
        );
        expect(await r.tap.until(ended)).toMatchObject({ attribution: A });
        const reply = r.dump().stdin.find((l) => l.type === 'control_response') as {
          response: { request_id: string; response: { behavior: string } };
        };
        expect(reply.response).toMatchObject({
          request_id: ask.requestId,
          response: { behavior: allow ? 'allow' : 'deny' },
        });
        // Сервер права в список MCP CLI не попадает: вопрос идёт строкой протокола.
        expect(p.mcpNames(r.dump().argv, r.handle.dir)).not.toContain('agentdeck-permit');
        await r.adapter.stop(r.handle, 'soft');
      }
    },
  },
  {
    name: 'the permit tool is named to the CLI and hidden from the model',
    needs: ['permissionTool'],
    road: 'tool',
    async run(p) {
      const r = await run(p, fx(p, p.fixtures.basic), {
        permitServer: { name: 'agentdeck-permit', tool: 'approve' },
      });
      await r.adapter.send(r.handle, 'hello', A);
      await r.tap.until(ended);
      const argv = r.dump().argv;
      expect(after(argv, '--permission-prompt-tool')).toBe('mcp__agentdeck-permit__approve');
      expect(after(argv, '--disallowedTools')?.split(',')).toContain(
        'mcp__agentdeck-permit__approve',
      );
      await r.adapter.stop(r.handle, 'soft');
    },
  },
  {
    name: 'strict MCP: the CLI is given exactly the step servers',
    needs: ['mcp', 'strictMcp'],
    async run(p) {
      const r = await run(p, fx(p, p.fixtures.basic), {
        mcpServers: { 'step-srv': { command: process.execPath, args: ['s.mjs'] } },
      });
      await r.adapter.send(r.handle, 'hello', A);
      await r.tap.until(ended);
      expect(p.mcpNames(r.dump().argv, r.handle.dir)).toEqual(['step-srv']);
      await r.adapter.stop(r.handle, 'soft');
    },
  },
  {
    name: 'the core PreToolUse hook is installed for every tool',
    needs: ['preToolHooks'],
    async run(p) {
      const hook = `node ${join(r0(p).root, 'hook.mjs')} core`;
      const r = await run(p, fx(p, p.fixtures.basic), { coreHook: hook });
      await r.adapter.send(r.handle, 'hello', A);
      await r.tap.until(ended);
      expect(p.hookCommands(settingsOf(r.handle, p))).toEqual([hook]);
      await r.adapter.stop(r.handle, 'soft');
    },
  },
  {
    name: 'layer control: observe and off keep the human sources out',
    needs: ['layerControl'],
    async run(p) {
      for (const hooks of ['observe', 'off'] as const) {
        const r = await run(p, fx(p, p.fixtures.basic), { layer: { hooks } });
        await r.adapter.send(r.handle, 'hello', A);
        await r.tap.until(ended);
        expect(after(r.dump().argv, '--setting-sources')).toBe('');
        await r.adapter.stop(r.handle, 'soft');
      }
    },
  },
  {
    name: 'effort reaches the CLI as its documented flag',
    needs: ['effort'],
    async run(p) {
      const r = await run(p, fx(p, p.fixtures.basic), { effort: 'high' });
      await r.adapter.send(r.handle, 'hello', A);
      await r.tap.until(ended);
      expect(after(r.dump().argv, '--effort')).toBe('high');
      await r.adapter.stop(r.handle, 'soft');
    },
  },
];

/** Случаи без возможности: поведение, которое обязано быть у каждого переходника. */
const UNIVERSAL: Case[] = [
  {
    name: 'a background wake after our turn is cli-initiated, never our turn end',
    needs: [],
    // Записи фонового пробуждения нет (qwen) — пропуск, а не пустой зелёный прогон.
    when: (p) => p.fixtures.wake !== undefined,
    async run(p) {
      if (!p.fixtures.wake) throw new Error('run without a wake fixture: `when` must skip it');
      const r = await run(p, fx(p, p.fixtures.wake));
      await r.adapter.send(r.handle, 'BG_TASK now', A);
      await r.tap.until(ended);
      expect(await r.tap.until((e) => e.type === 'turn.cli-initiated')).toMatchObject({
        cause: 'background-wake',
      });
      await r.adapter.stop(r.handle, 'soft');
    },
  },
  {
    name: 'a layer the adapter cannot control is refused before anything spawns',
    needs: [],
    // Управляет слоями — случай не о нём (его слои судит случай `layerControl`).
    when: (p) => !p.make({}).caps.layerControl,
    async run(p) {
      const adapter = p.make({});
      const outcome = await adapter.launch(liveSpec(r0(p), { layer: { hooks: 'off' } }));
      expect(outcome).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/not controllable/),
      });
    },
  },
];

function r0(p: Profile): LiveRoot {
  return stand(p).live;
}

afterAll(async () => {
  for (const { adapter, handle } of open) await adapter.stop(handle, 'tree').catch(() => undefined);
});

describe('adapter conformance — P121 every declared cap has a case', () => {
  const BOOL_CAPS: BoolCap[] = [
    'resume',
    'mcp',
    'strictMcp',
    'permissionTool',
    'denyOverlay',
    'preToolHooks',
    'layerControl',
    'attribution',
    'stream',
    'effort',
    'images',
    'subagents',
    'windowEvent',
  ];

  it('the registry holds every profiled adapter, and every boolean cap is listed here', () => {
    const registry = createAdapterRegistry({ [PROFILES[0]!.id]: { pollMs: 10 } });
    expect(registry.ids().sort()).toEqual(PROFILES.map((p) => p.id).sort());
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.all()).toHaveLength(PROFILES.length);
    for (const adapter of registry.all()) {
      const declared = Object.entries(adapter.caps)
        .filter(([, v]) => typeof v === 'boolean')
        .map(([k]) => k)
        .sort();
      expect(declared).toEqual([...BOOL_CAPS].sort());
    }
  });

  it.each(PROFILES.map((p) => [p.id, p] as const))(
    '%s: each cap it declares is exercised',
    (_id, p) => {
      const adapter = p.make({});
      for (const cap of BOOL_CAPS) {
        if (!adapter.caps[cap]) continue;
        const covering = casesExercising(CASES, cap, adapter.caps, p.permitRoad);
        expect(
          covering.length,
          `cap ${cap} declared by ${p.id} has no conformance case`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it('F-79 a cap whose only case also needs an undeclared cap is NOT covered (the run skips it)', () => {
    const only: Case = { name: 'x', needs: ['mcp', 'strictMcp'], run: async () => undefined };
    // strictMcp объявлен, mcp — нет: единственный случай strictMcp пропускается прогоном.
    expect(casesExercising([only], 'strictMcp', { strictMcp: true, mcp: false }, 'tool')).toEqual(
      [],
    );
    expect(casesExercising([only], 'strictMcp', { strictMcp: true, mcp: true }, 'tool')).toEqual([
      only,
    ]);
    // Чужая дорога вопроса о праве — тоже не покрытие.
    const road: Case = { ...only, needs: ['strictMcp'], road: 'in-band' };
    expect(casesExercising([road], 'strictMcp', { strictMcp: true }, 'tool')).toEqual([]);
  });
});

for (const profile of PROFILES) {
  describe(`adapter conformance — ${profile.id} over its recorded streams`, () => {
    const caps = profile.make({}).caps;
    for (const c of [...CASES, ...UNIVERSAL]) {
      const applies = caseApplies(c, caps, profile.permitRoad, profile);
      it.skipIf(!applies)(
        c.name,
        async () => {
          // Случай без единой проверки — красный: пустой зелёный прогон ничего не доказывает.
          expect.hasAssertions();
          await c.run(profile);
        },
        60_000,
      );
    }
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('adapter conformance — stop', () => {
  it.each(PROFILES.map((p) => [p.id, p] as const))(
    '%s: soft stop ends the CLI by closing stdin; hard stop takes the tree; nothing stays alive',
    async (_id, p) => {
      const soft = await run(p, fx(p, p.fixtures.basic));
      await soft.adapter.send(soft.handle, 'hello', A);
      await soft.tap.until(ended);
      expect(await soft.adapter.stop(soft.handle, 'soft')).toMatchObject({ how: 'exited' });
      await waitFor(() => (alive(soft.handle.child.pid) ? undefined : true));
      // Сессия кончилась: поток закрыт, файлы сеанса — в каталоге сеанса.
      await expect(soft.tap.until(() => false, 10_000)).rejects.toThrow(/stream ended/);
      expect(existsSync(join(soft.handle.dir, p.settings))).toBe(true);

      const hard = await run(p, fx(p, p.fixtures.basic));
      await waitFor(() => (alive(hard.handle.child.pid) ? true : undefined));
      // Насос сеанса (у qwen — со своим `initialize`) не отнимает канал хоста у остановки.
      expect(await hard.adapter.stop(hard.handle, 'tree')).toMatchObject({
        how: 'tree',
        residual: [],
      });
      await waitFor(() => (alive(hard.handle.child.pid) ? undefined : true));
      // Сразу после выхода CLI хост ещё дописывает исход и сбрасывает новый канал — это выход,
      // а не потеря сеанса (виден на Linux).
      expect(await hard.adapter.stop(hard.handle, 'soft')).toMatchObject({ how: 'already-exited' });
    },
    60_000,
  );
});
