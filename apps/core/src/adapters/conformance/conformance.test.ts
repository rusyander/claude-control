import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  AdapterCaps,
  AdapterEvent,
  CliAdapter,
  LayerRun,
  SessionHandle,
  SessionSpec,
} from '../adapter.types.ts';
import { FROM_HUMAN_LINE, PLATFORM_MARKER } from '@agentdeck/contracts/core/user-layer';
import { PUBLISH_COMMANDS } from '../deny-overlay.ts';
import { createAdapterRegistry } from '../index.ts';
import { adoptRefusal } from '../../bootstrap/session-road/adopt-gate.ts';
import { compatAdapterOf, compatFactsOf } from '../../bootstrap/session-road/compat-gate.ts';
import { compat } from '../../routes/compat/compat.ts';
import { createStubRoute } from '../../routes/stub/stub.ts';
import type { RoadStart } from '../../bootstrap/session-road/road.types.ts';
import type { SdkAdapter } from '../sdk-stream/sdk-adapter.ts';
import { EventTap, liveFacts, liveRoot, liveSpec, type LiveRoot } from './__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
  replayEnv,
  type ReplayRun,
} from './__fixtures__/replay.ts';
import { ACP_PROFILES } from './__fixtures__/profiles/acp.ts';
import { after, PROFILES, RPC_PROFILES, type Profile } from './__fixtures__/profiles/index.ts';

/**
 * Набор соответствия (03 §CLI adapter, R:PR-09, P121): одни и те же случаи для каждого
 * переходника, каждый — через настоящий запуск (платформа, хост сессии, насос) подставного CLI,
 * который проигрывает ЗАПИСЬ живого CLI в ответ на настоящий stdin переходника. Случай требует
 * возможностей; возможность, объявленная без случая, — красное.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
/** PNG 1×1: картинка случая `images`. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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
  layer: LayerRun;
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
    layer: launched.layer,
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
    name: 'images ride the send as image blocks after the text; the turn still ends attributed',
    needs: ['images', 'stream', 'attribution'],
    async run(p) {
      const r = await run(p, fx(p, p.fixtures.basic));
      const dir = mkdtempSync(join(tmpdir(), 'conf-img-'));
      const path = join(dir, '0.png');
      writeFileSync(path, Buffer.from(PNG_1PX, 'base64'));
      try {
        await r.adapter.send(r.handle, 'what is on it?', A, 'platform', [
          { mediaType: 'image/png', path },
        ]);
        expect(await r.tap.until(ended)).toMatchObject({ attribution: A, isError: false });
        const user = r.dump().stdin.find((l) => l.type === 'user') as {
          message: { content: Record<string, unknown>[] };
        };
        expect(user.message.content[0]).toMatchObject({ type: 'text' });
        expect(String(user.message.content[0]!.text)).toContain('what is on it?');
        expect(user.message.content.slice(1)).toEqual([
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } },
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
        layer: { hooks: layered ? 'off' : 'on', skills: 'on' },
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
        const r = await run(p, fx(p, p.fixtures.basic), { layer: { hooks, skills: 'on' } });
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
  {
    name: 'windowEvent: the subscription window line becomes one window event (usage %, reset, warning)',
    needs: ['windowEvent'],
    when: (p) => p.fixtures.window !== undefined,
    async run(p) {
      if (!p.fixtures.window) throw new Error('run without a window fixture: `when` must skip it');
      const r = await run(p, fx(p, p.fixtures.window));
      await r.adapter.send(r.handle, 'hello', A);
      await r.tap.until(ended);
      const windows = r.tap.seen.filter((e) => e.type === 'window');
      expect(windows).toEqual([
        {
          type: 'window',
          limitKind: 'window',
          usedPct: 92,
          resetAt: 1_788_351_600_000,
          warning: true,
          refusal: false,
          window: 'five_hour',
          // Замер каждого окна с долей — для доли лимита у чата панели (проход 8).
          windows: {
            five_hour: { usedPct: 92, resetAt: 1_788_351_600_000 },
            seven_day: { usedPct: 41, resetAt: 1_788_800_000_000 },
          },
        },
      ]);
      await r.adapter.stop(r.handle, 'soft');
    },
  },
  {
    name: 'skills off reach the CLI as its own switch; skills on leave the CLI as is',
    needs: ['skillControl'],
    async run(p) {
      const off = await run(p, fx(p, p.fixtures.basic), { layer: { hooks: 'on', skills: 'off' } });
      await off.adapter.send(off.handle, 'hello one', A);
      await off.tap.until(ended);
      expect(p.skillsOff?.(off.dump().argv)).toBe(true);
      await off.adapter.stop(off.handle, 'soft');
      const on = await run(p, fx(p, p.fixtures.basic), { layer: { hooks: 'on', skills: 'on' } });
      await on.adapter.send(on.handle, 'hello one', A);
      await on.tap.until(ended);
      expect(p.skillsOff?.(on.dump().argv)).toBe(false);
      await on.adapter.stop(on.handle, 'soft');
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
    name: 'a layer the adapter cannot control runs on, and the downgrade is named (G3)',
    needs: [],
    // Управляет слоями — случай не о нём (его слои судит случай `layerControl`).
    when: (p) => !p.make({}).caps.layerControl,
    async run(p) {
      const r = await run(p, fx(p, p.fixtures.basic), {
        layer: { hooks: 'off', skills: 'on' },
        trust: { sourceRepo: r0(p).cwd, panelMark: true },
      });
      expect(r.layer).toMatchObject({ asked: 'off', ran: 'on' });
      expect(r.layer.detail).toMatch(/no layer control: hooks off → on/);
      await r.adapter.send(r.handle, 'hello one', A);
      expect(await r.tap.until(ended)).toMatchObject({ attribution: A });
      await r.adapter.stop(r.handle, 'soft');
    },
  },
  {
    // UNIVERSAL (P37, 06:119): метка платформы — первой строкой каждого текста ядра в сессию,
    // слова человека — второй строкой `agentdeck-from: human`; привязка хода — по эху uuid, не по
    // тексту (текст меченый — совпадения по тексту нет).
    name: 'every text into the session starts with the platform marker; attribution still by echo',
    needs: ['stream'],
    async run(p) {
      const r = await run(p, fx(p, p.fixtures.basic));
      await r.adapter.send(r.handle, 'reminder', A);
      await r.tap.until(ended);
      // Дамп пишет сам подставной CLI при старте — читается после хода, иначе гонка с его запуском.
      expect(
        p.brief(r.dump().argv).startsWith(`${PLATFORM_MARKER}
`),
      ).toBe(true);
      await r.adapter.send(r.handle, 'from the human', B, 'human');
      const second = await r.tap.until(ended);
      if (p.make({}).caps.attribution) expect(second).toMatchObject({ attribution: B });
      const texts = r
        .dump()
        .stdin.filter((l) => l.type === 'user')
        .map((l) => {
          const content = (l.message as { content: unknown }).content;
          return typeof content === 'string'
            ? content
            : (content as { text?: string }[]).map((c) => c.text ?? '').join('');
        });
      expect(texts).toEqual([
        `${PLATFORM_MARKER}
reminder`,
        `${PLATFORM_MARKER}
${FROM_HUMAN_LINE}
from the human`,
      ]);
      await r.adapter.stop(r.handle, 'soft');
    },
  },
];

function r0(p: Profile): LiveRoot {
  return stand(p).live;
}

afterAll(async () => {
  for (const { adapter, handle } of open) await adapter.stop(handle, 'tree').catch(() => undefined);
});

const TRI_STATE_CAPS: readonly string[] = ['subagentHooks'];
/** Зарегистрированы, но без хука и оверлея на установленной версии: запуск — `no_core_hook`. */
const GATELESS = new Set(['aider', 'continue', 'cursor']);

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
    'skillControl',
    'windowEvent',
  ];

  it('the registry holds every profiled adapter, and every boolean cap is listed here', () => {
    const registry = createAdapterRegistry({ [PROFILES[0]!.id]: { pollMs: 10 } });
    const built = registry.all().filter((a) => a.built !== false);
    // Переходник без защиты ядра — тоже переходник (не заготовка), но без профиля: судить нечего.
    expect(built.map((a) => a.id).sort()).toEqual(
      [...[...PROFILES, ...RPC_PROFILES, ...ACP_PROFILES].map((p) => p.id), ...GATELESS].sort(),
    );
    expect(registry.get('nope')).toBeUndefined();
    for (const adapter of built.filter((a) => !GATELESS.has(a.id))) {
      // `subagentHooks` — тройное (`null` = не проверено): его доказывают живые пробы слоя
      // (`layer-probe.live.integration.test.ts`), а не подставной CLI, хуков не исполняющий.
      const declared = Object.entries(adapter.caps)
        .filter(([k, v]) => typeof v === 'boolean' && !TRI_STATE_CAPS.includes(k))
        .map(([k]) => k)
        .sort();
      expect(declared).toEqual([...BOOL_CAPS].sort());
    }
  });

  // Без профиля — заготовка (`adapter_not_built`) или CLI без защиты ядра (`no_core_hook`): ни
  // одной возможности, ни канала, запуск и привязка адреса отказаны своим кодом (этап 10, Q8).
  // Судья compat называет ту же причину, что и запуск: CLI без судьи — `no_core_hook`, не «не
  // построен» (переходник есть, ядру встать некуда).
  it('every adapter without a profile is gateless or a placeholder: no cap, no channel, refused by its own code', async () => {
    const registry = createAdapterRegistry();
    const profiled = new Set([...PROFILES, ...RPC_PROFILES, ...ACP_PROFILES].map((p) => p.id));
    const rest = registry.all().filter((a) => !profiled.has(a.id));
    expect(rest.map((a) => a.id).sort()).toEqual([...GATELESS].sort());
    const stub = createStubRoute({ name: 'x', script: ['x'] });
    const facts = await compatFactsOf(stub, 'stub-model');
    for (const adapter of rest) {
      const gateless = GATELESS.has(adapter.id);
      const code = gateless ? 'no_core_hook' : 'adapter_not_built';
      expect(adapter.built, adapter.id).toBe(gateless ? undefined : false);
      if (gateless) expect(adapter.cliLogin, adapter.id).toBe(false);
      const on = Object.entries(adapter.caps).filter(([, v]) => v === true);
      expect(on, adapter.id).toEqual([]);
      expect(adapter.caps.channels).toEqual([]);
      const ep = PROFILES[0]!.endpoint!;
      const bound = adapter.bindEndpoint(ep.channel, ep.endpoint);
      expect(bound, adapter.id).toMatchObject({ ok: false, code });
      const launched = await adapter.launch({} as SessionSpec);
      expect(launched.ok).toBe(false);
      expect(launched.ok ? '' : launched.reason).toMatch(new RegExp(`^${code}: ${adapter.id} `));
      const verdict = compat(compatAdapterOf(adapter), facts.route, facts.model, {
        allowed: [{ adapter: adapter.id, route: stub.id, modelPattern: '*' }],
        dlp: { required: false, parses: [] },
        translations: [],
        needsTools: false,
      });
      expect(verdict, adapter.id).toMatchObject({ kind: 'refused', code });
    }
  });

  // Подтверждённый транскрипт ведёт дорогу к продолжению чужого разговора (F2, adopt-gate): у
  // переходника без продолжения (`resume: false` — opencode, cursor отказывают `spec.resume`)
  // подтверждение пропустило бы просьбу мимо `resume_unproven` к аренде и отказу уже на запуске.
  // Codex, Goose, Kimi, Gemini продолжают (копия транскрипта в дом сеанса): суд у них — свой, id чужой формы
  // отказан до чтения хранилища.
  it('ownsTranscript only where the adapter resumes: without resume the adopt gate says resume_unproven', () => {
    const registry = createAdapterRegistry();
    for (const adapter of registry.all()) {
      if (adapter.caps.resume !== true) {
        expect(adapter.ownsTranscript, adapter.id).toBeUndefined();
      }
    }
    for (const id of ['codex', 'goose', 'kimi', 'gemini']) {
      const adapter = registry.get(id)!;
      expect(adapter.caps.resume, id).toBe(true);
      expect(typeof adapter.ownsTranscript, id).toBe('function');
      const start = {
        adapterId: id,
        cwd: 'C:\\repo',
        pin: {},
        resume: { conversationId: '../x', adopt: { adapter: id } },
      } as unknown as RoadStart;
      expect(adoptRefusal(start, adapter), id).toBe('resume_not_owned');
      expect(adoptRefusal({ ...start, adapterId: 'claude' } as RoadStart, adapter), id).toBe(
        'resume_other_cli',
      );
    }
    for (const id of ['opencode', 'cursor']) {
      const adapter = registry.get(id)!;
      expect(adapter.caps.resume, id).toBe(false);
      const start = {
        adapterId: id,
        cwd: 'C:\\repo',
        pin: {},
        resume: { conversationId: 'x', adopt: { adapter: id } },
      } as unknown as RoadStart;
      expect(adoptRefusal(start, adapter), id).toBe('resume_unproven');
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
