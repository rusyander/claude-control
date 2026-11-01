import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import type { AdapterEvent } from '../adapters/index.ts';
import { liveRoot, type LiveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
} from '../adapters/conformance/__fixtures__/replay.ts';
import { claudeConfigDir } from '../adapters/claude/user-layer.ts';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { toolchainReadRoots } from '../platform/toolchain-roots.ts';
import type { RouteRegistry } from '../routes/registry.ts';
import { roadStart, roadTask } from './__fixtures__/road-start.ts';
import { coreHookCommand } from './session-road/hook-file.ts';
import { releaseTaskLeases } from './session-road/lease-release.ts';
import { qwenHookCommand } from '../adapters/qwen/qwen.ts';
import { bootCore, type BootedCore } from './boot.ts';
import type { RoadStart } from './session-road.ts';

/**
 * Дорога сессии ядра (03 §Launcher, 06 §Session permissions) на НАСТОЯЩЕЙ загрузке: одна точка
 * входа совместимость → окружение с PATH входа → токен → хук ядра + оверлей → запуск →
 * прикрепление → на остановке поиск ресурсов, в конце задачи их снятие с чтением назад. CLI —
 * подставной (запись живого Claude), но хук он получает настоящий: команда из его `--settings`
 * исполняется здесь так, как её исполнил бы CLI, и решает ядро.
 */

const A = '11111111-1111-4111-8111-111111111111';
const LOGIN_DIR = join(tempDir('road-login-'), 'login-bin');
const LOGIN_REASON = 'login shell timed out after 10000 ms';

const cores: BootedCore[] = [];
const stops: (() => Promise<unknown>)[] = [];
const spacedDirs: string[] = [];
afterAll(async () => {
  for (const stop of stops) await stop().catch(() => undefined);
  for (const core of cores) await core.stop();
  for (const dir of spacedDirs) rmSync(dir, { recursive: true, force: true });
});

interface Stand {
  core: BootedCore;
  live: LiveRoot;
  bin: string;
}

async function stand(home = join(tempDir('road-'), 'core')): Promise<Stand> {
  const core = await bootCore({
    home,
    build: 'road-test',
    // PATH оболочки входа — подменённое чтение (настоящее — P104 в `platform/shell-path`):
    // здесь проверяется, что дорога кладёт его в окружение CLI и называет запасной путь.
    loginPath: async () => ({
      path: [LOGIN_DIR, process.env.PATH ?? ''].join(delimiter),
      source: 'known-dirs',
      reason: LOGIN_REASON,
    }),
  });
  cores.push(core);
  const live = liveRoot('road-');
  const bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, claudeRunFacts.binary.command);
  return { core, live, bin };
}

const task = (core: BootedCore, allowed: boolean, sourceRepo?: string): Promise<LiveTask> =>
  roadTask(core, claudeRunFacts.id, { allowed, ...(sourceRepo ? { sourceRepo } : {}) });

const startOf = (s: Stand, live: LiveTask, fixture: string, dump: string): RoadStart =>
  roadStart({ live: s.live, bin: s.bin, task: live, adapterId: claudeRunFacts.id, fixture, dump });

async function permit(core: BootedCore, token: string, raw: unknown) {
  const res = await fetch(`${core.url}/v1/session/permit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function until<T>(probe: () => T | undefined, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const lines = (t: LiveTask): JournalLine[] => readJournalLines(t.dir, t.taskId).lines;

const envOf = (env: Record<string, string>, name: string): string | undefined =>
  Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

/** Команда хука ядра из `--settings`, который получил CLI. */
function hookCommandOf(argv: string[]): string {
  const settings = argv[argv.indexOf('--settings') + 1]!;
  const parsed = JSON.parse(readFileSync(settings, 'utf8')) as {
    hooks: { PreToolUse: { hooks: { command: string }[] }[] };
  };
  // Хук ядра — последняя группа PreToolUse (переходник ставит его после своих).
  return parsed.hooks.PreToolUse.at(-1)!.hooks[0]!.command;
}

/**
 * Хук так, как его зовёт CLI: строка команды оболочкой, окружение CLI, вызов на stdin.
 * Асинхронно: ядро живёт в этом же процессе, и синхронный запуск заморозил бы его ответ.
 */
function runHook(
  command: string,
  env: Record<string, string>,
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

/**
 * Хук так, как его зовёт Qwen Code 0.24.3 на Windows без Git Bash (бандл `executeCommandHook` +
 * `getShellConfiguration`): `%ComSpec% /d /s /c <команда>`, `shell: false` — аргумент кавычит
 * Node, дословной передачи нет.
 */
function runHookLikeQwen(
  command: string,
  env: Record<string, string>,
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const comSpec = envOf(env, 'COMSPEC') ?? 'cmd.exe';
    const child = spawn(comSpec, ['/d', '/s', '/c', command], {
      shell: false,
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

const call = (command: string): string =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

describe('session road: one entry from compat to resource release', () => {
  it('compat refuses a route outside the allowed set: the decision is journaled and nothing is launched', async () => {
    const s = await stand();
    const live = await task(s.core, false);
    const start = startOf(
      s,
      live,
      fixturePath(claudeRunFacts.id, 'permit'),
      join(s.live.root, 'd.json'),
    );
    const got = await s.core.road.prepare(start);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.compat).toMatchObject({ kind: 'refused', code: 'not_allowed' });
    const compat = lines(live).filter(
      (l) => l.kind === 'decision' && (l.data as { class: string }).class === 'compat',
    );
    expect(compat).toHaveLength(1);
    expect((compat[0]!.data as unknown as { output: { kind: string } }).output.kind).toBe(
      'refused',
    );
    // Ни каталога сессии, ни токена, ни запуска.
    expect(existsSync(start.dir)).toBe(false);
    expect(lines(live).some((l) => l.kind === 'session.started')).toBe(false);
  }, 60_000);

  it('P110 compat refusal names the allowed tier alternatives with facts the road read itself; an unregistered alternative is not a candidate (stage 5 W)', async () => {
    const core = await bootCore({
      home: join(tempDir('road-alt-'), 'core'),
      build: 'road-test',
      routeConfig: { stub: [{ name: 'alt', script: [], models: ['m1'] }] },
    });
    cores.push(core);
    const s: Stand = { ...(await stand()), core };
    const live = await core.registry.create({
      ...CREATED,
      allowedRoutes: [
        { adapter: claudeRunFacts.id, route: { kind: 'stub', id: 'stub:alt' }, modelPattern: '*' },
      ],
    });
    const start = startOf(
      s,
      live,
      fixturePath(claudeRunFacts.id, 'permit'),
      join(s.live.root, 'd.json'),
    );
    const got = await core.road.prepare({
      ...start,
      alternatives: [
        { adapterId: claudeRunFacts.id, routeId: 'stub:alt', model: 'm1' },
        { adapterId: claudeRunFacts.id, routeId: 'stub:gone', model: 'm1' },
      ],
    });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.compat).toMatchObject({ kind: 'refused', code: 'not_allowed' });
    const alternatives = (got.compat as { alternatives: { route: string; model: string }[] })
      .alternatives;
    expect(alternatives.map((a) => `${a.route}/${a.model}`)).toEqual(['stub:alt/m1']);
  }, 60_000);

  it('the road launches with the login PATH and the core procs file in the CLI env, attaches the session (permit tool 200, not 503), and its core hook decides every tool call', async () => {
    const s = await stand();
    const { core } = s;
    const live = await task(core, true);
    // Запись живого CLI до ответа инструмента: модель запросила Bash и ждёт — вопрос законен.
    const full = readFileSync(fixturePath(claudeRunFacts.id, 'permit'), 'utf8').split('\n');
    const cut = full.findIndex((l) => l.includes('"tool_result"'));
    const fixture = join(s.live.root, 'permit-pending.jsonl');
    writeFileSync(fixture, `${full.slice(0, cut).join('\n')}\n`);
    const dump = join(s.live.root, 'dump.json');
    const start = startOf(s, live, fixture, dump);

    const prepared = await core.road.prepare(start);
    if (!prepared.ok) throw new Error(prepared.reason);
    const p = prepared.prepared;
    expect(p.compat).toMatchObject({ kind: 'direct', channel: { via: 'login' } });
    expect(p.loginPath).toMatchObject({ source: 'known-dirs', reason: LOGIN_REASON });
    expect(readFileSync(join(core.layout.logs, 'core.jsonl'), 'utf8')).toContain(LOGIN_REASON);
    const raw = { tool_name: 'Bash', input: { command: 'node -v' }, tool_use_id: 'toolu_stub_1_0' };
    // Токен уже отчеканен, сессии в журнале ещё нет: вопрос о праве — отказ (403), не «да».
    const early = await permit(core, p.token, raw);
    expect(early.status).toBe(403);
    expect(early.body).toMatchObject({ code: 'no-session' });
    // Список инструментов CLI спрашивает при старте мостов MCP — до `session.started` (Qwen
    // успевает раньше, чем запуск вернул pid): 503 «повтори», не 403, иначе CLI теряет сервер.
    const listEarly = await fetch(`${core.url}/v1/session/tools`, {
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(listEarly.status).toBe(503);

    const launched = await core.road.launch(p);
    if (!launched.ok) throw new Error(launched.reason);
    stops.push(() => p.adapter.stop(launched.handle, 'tree'));
    core.road.started(p, launched.handle, launched.layer);
    // Сессия в журнале, но не прикреплена: ответа ядра нет — 503 (хук повторяет, потом отказ).
    expect((await permit(core, p.token, raw)).status).toBe(503);
    const list = await fetch(`${core.url}/v1/session/tools`, {
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { tools: { name: string }[] }).tools.length).toBeGreaterThan(0);
    const seen: AdapterEvent[] = [];
    const session = core.road.attach({
      task: live,
      sessionId: p.spec.sessionId,
      adapter: p.adapter,
      handle: launched.handle,
      context: p.context,
      cwd: p.spec.cwd,
      onEvent: (e) => seen.push(e),
    });
    await p.adapter.send(launched.handle, 'RUN_BASH now', A);
    await until(() => seen.find((e) => e.type === 'tool.requested'));

    // Красное до дороги: прикреплённой сессии не было — 503. Теперь решает кодек переходника.
    const answered = await permit(core, p.token, raw);
    expect(answered.status).toBe(200);
    expect(answered.body.outcome).toBe('decided');
    expect(answered.body.reply).toMatchObject({ behavior: 'allow' });

    // Окружение, которое получил CLI: PATH входа (после каталогов стенда) и файл procs ядра.
    const got = await until(() => readDump(dump) ?? undefined);
    const path = envOf(got.env, 'PATH') ?? '';
    expect(path.split(delimiter)).toContain(LOGIN_DIR);
    expect(path.indexOf(LOGIN_DIR)).toBeGreaterThan(path.indexOf(s.bin));
    expect(envOf(got.env, 'AGENTDECK_CORE_PROCS')).toBe(core.layout.procs);

    // Хук ядра — команда из настроек CLI, исполненная как её исполнил бы CLI.
    const hook = hookCommandOf(got.argv);
    const allow = await runHook(hook, got.env, call('node -v'));
    expect(allow, allow.stderr).toMatchObject({ code: 0, stdout: '' });
    const deny = await runHook(hook, got.env, call('git push origin main'));
    expect(deny.code).toBe(2);
    expect(deny.stderr).toMatch(/platform/i);
    const hookDecisions = lines(live)
      .filter(
        (l) =>
          l.kind === 'decision' &&
          (l.data as { class: string }).class === 'permit' &&
          (l.data as { output: { road?: string } }).output.road === 'hook',
      )
      .map((l) => (l.data as unknown as { output: { allow: boolean; tool: string } }).output);
    expect(hookDecisions.map((d) => [d.tool, d.allow])).toEqual([
      ['Bash', true],
      ['Bash', false],
    ]);
    // Нечитаемый вызов — отказ (код 2), не «разрешено».
    const garbage = await runHook(hook, got.env, 'not json');
    expect(garbage.code).toBe(2);

    // node под путём с пробелом (установщик Node кладёт его в `C:\Program Files\nodejs`): Qwen
    // берёт команду хука только словами без пробелов — короткое имя 8.3 даёт такое слово, и хук
    // ядра доходит до ядра тем путём, каким его зовёт Qwen на Windows.
    if (process.platform === 'win32') {
      const spaced = join(tempDir('road-space-'), 'node dir with space');
      spacedDirs.push(dirname(spaced));
      mkdirSync(spaced, { recursive: true });
      copyFileSync(process.execPath, join(spaced, 'node.exe'));
      const built = coreHookCommand(
        launched.handle.dir,
        [join(spaced, 'node.exe'), '--experimental-strip-types', '--no-warnings'],
        'win32',
      );
      if (!built.ok) throw new Error(built.reason);
      const qwenCommand = qwenHookCommand(built.command);
      expect(qwenCommand, built.command).not.toBeNull();
      const qAllow = await runHookLikeQwen(qwenCommand!, got.env, call('node -v'));
      expect(qAllow, qAllow.stderr).toMatchObject({ code: 0, stdout: '' });
      const qDeny = await runHookLikeQwen(qwenCommand!, got.env, call('git push origin main'));
      expect(qDeny.code, qDeny.stderr).toBe(2);
      expect(qDeny.stderr).toMatch(/platform/i);
    }

    // Область чтения (F-87) дорогой: вне копии — `outside-copy`; корень инструментов — можно.
    const read = (file: string) =>
      runHook(
        hook,
        got.env,
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: file },
        }),
      );
    const outside = join(tempDir('road-outside-'), 'secret.txt');
    writeFileSync(outside, 'x');
    const refused = await read(outside);
    expect(refused.code, refused.stderr).toBe(2);
    const toolRoot = toolchainReadRoots({ copyRoot: s.live.cwd }).find((root) => existsSync(root));
    if (!toolRoot) throw new Error('no toolchain root exists on this machine');
    const allowedRead = await read(join(toolRoot, 'any-file'));
    expect(allowedRead, allowedRead.stderr).toMatchObject({ code: 0, stdout: '' });
    const reads = lines(live)
      .filter(
        (l) =>
          l.kind === 'decision' &&
          (l.data as { class: string }).class === 'permit' &&
          (l.data as unknown as { output: { tool?: string } }).output.tool === 'Read',
      )
      .map((l) => (l.data as unknown as { output: { allow: boolean; code?: string } }).output);
    expect(reads.map((d) => [d.allow, d.code])).toEqual([
      [false, 'outside-copy'],
      [true, undefined],
    ]);

    // Слой CLI (F-86/F-87) дорогой: каталог навыков CLI — можно, его файл учётных данных — нет.
    const config = claudeConfigDir(start.pin);
    const skill = await read(join(config, 'skills', 'some-skill', 'SKILL.md'));
    expect(skill, skill.stderr).toMatchObject({ code: 0, stdout: '' });
    const credential = await read(join(config, '.credentials.json'));
    expect(credential.code, credential.stderr).toBe(2);
    const layerReads = lines(live)
      .filter(
        (l) =>
          l.kind === 'decision' &&
          (l.data as { class: string }).class === 'permit' &&
          (l.data as unknown as { output: { tool?: string } }).output.tool === 'Read',
      )
      .slice(2)
      .map((l) => (l.data as unknown as { output: { allow: boolean; code?: string } }).output);
    expect(layerReads.map((d) => [d.allow, d.code])).toEqual([
      [true, undefined],
      [false, 'credential-path'],
    ]);

    // Сессия оставила файл во временном каталоге — найден на остановке, снят в конце задачи.
    const leftover = join(launched.handle.dir, 'tmp', 'left-by-session.txt');
    writeFileSync(leftover, 'x');
    const ended = await session.end('tree');
    expect(ended.found.map((f) => [f.kind, f.ref])).toContainEqual(['tmpdir', leftover]);
    const created = lines(live).filter(
      (l) =>
        l.kind === 'resource.created' &&
        (l.data as { owner: string; ref: string }).ref === leftover,
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.data).toMatchObject({
      kind: 'tmpdir',
      owner: 'session',
      release: 'task-end',
    });
    expect(core.sessions.size()).toBe(0);
    // Кончившаяся сессия — отказ по журналу (403 `session-ended`), не «да».
    const late = await permit(core, p.token, raw);
    expect(late.status).toBe(403);
    expect(late.body).toMatchObject({ code: 'session-ended' });

    const released = await core.road.releaseTask(live);
    expect(released.leaks).toEqual([]);
    expect(existsSync(leftover)).toBe(false);
    const rid = (created[0]!.data as { rid: string }).rid;
    expect(live.state.resources[rid]?.status).toBe('verified');
  }, 120_000);

  it('the road names the SOURCE repo of the task for trust and journals the layer the session ran with: unmarked → observe, CLI-marked → on', async () => {
    const s = await stand();
    const { core } = s;
    // Источник — настоящий каталог, не копия: CLI хранит доверие по пути исходного репозитория.
    const unmarkedRepo = tempDir('road-src-plain-');
    const markedRepo = tempDir('road-src-marked-');
    writeFileSync(
      join(s.live.home, '.claude.json'),
      JSON.stringify({
        projects: { [markedRepo.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } },
      }),
    );
    const layerOf = async (sourceRepo: string) => {
      const live = await task(core, true, sourceRepo);
      const start = startOf(
        s,
        live,
        fixturePath(claudeRunFacts.id, 'permit'),
        join(s.live.root, `dump-${newId()}.json`),
      );
      const prepared = await core.road.prepare(start);
      if (!prepared.ok) throw new Error(prepared.reason);
      const p = prepared.prepared;
      expect(p.spec.trust).toEqual({ sourceRepo, panelMark: false });
      const launched = await core.road.launch(p);
      if (!launched.ok) throw new Error(launched.reason);
      stops.push(() => p.adapter.stop(launched.handle, 'tree'));
      core.road.started(p, launched.handle, launched.layer);
      await p.adapter.stop(launched.handle, 'tree');
      const line = lines(live).find((l) => l.kind === 'session.started');
      return (line?.data as { layer?: unknown } | undefined)?.layer;
    };
    expect(await layerOf(unmarkedRepo)).toEqual({
      asked: 'on',
      ran: 'observe',
      repoLayer: false,
      trust: 'none',
      detail: expect.stringContaining(unmarkedRepo) as unknown,
    });
    expect(await layerOf(markedRepo)).toEqual({
      asked: 'on',
      ran: 'on',
      repoLayer: true,
      trust: 'cli',
    });
  }, 120_000);

  it('continuation same-session: the road passes --resume <conversation root> to the CLI and journals resumeOf + cacheAgeMs; a fresh start journals nulls (stage 5 W)', async () => {
    const s = await stand();
    const { core } = s;
    const startedOf = async (resume: RoadStart['resume']) => {
      const live = await task(core, true);
      const base = startOf(
        s,
        live,
        fixturePath(claudeRunFacts.id, 'permit'),
        join(s.live.root, `dump-${newId()}.json`),
      );
      const prepared = await core.road.prepare(resume ? { ...base, resume } : base);
      if (!prepared.ok) throw new Error(prepared.reason);
      const p = prepared.prepared;
      const launched = await core.road.launch(p);
      if (!launched.ok) throw new Error(launched.reason);
      stops.push(() => p.adapter.stop(launched.handle, 'tree'));
      core.road.started(p, launched.handle, launched.layer);
      await p.adapter.stop(launched.handle, 'tree');
      const line = lines(live).find((l) => l.kind === 'session.started');
      return line?.data as { argv: string[]; resumeOf: unknown; cacheAgeMs: unknown };
    };
    const root = newId();
    const prior = newId();
    const resumed = await startedOf({ conversationId: root, of: prior, cacheAgeMs: 4000 });
    expect(resumed.argv[resumed.argv.indexOf('--resume') + 1]).toBe(root);
    expect(resumed.argv).not.toContain('--session-id');
    expect({ resumeOf: resumed.resumeOf, cacheAgeMs: resumed.cacheAgeMs }).toEqual({
      resumeOf: prior,
      cacheAgeMs: 4000,
    });
    const fresh = await startedOf(undefined);
    expect(fresh.argv).not.toContain('--resume');
    expect({ resumeOf: fresh.resumeOf, cacheAgeMs: fresh.cacheAgeMs }).toEqual({
      resumeOf: null,
      cacheAgeMs: null,
    });
  }, 120_000);

  it('a task end releases the route lease the road took — of a launched session and of a launch that never came — read back, once', async () => {
    const home = join(tempDir('road-lease-'), 'core');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ routes: { stub: [{ name: 'lease', script: ['hi'] }] } }),
    );
    const s = await stand(home);
    const { core } = s;
    const live = await core.registry.create({
      ...CREATED,
      allowedRoutes: [
        {
          adapter: claudeRunFacts.id,
          route: { kind: 'stub', id: 'stub:lease' },
          modelPattern: '*',
        },
      ],
    });
    const stubStart = (): RoadStart => ({
      ...startOf(
        s,
        live,
        fixturePath(claudeRunFacts.id, 'permit'),
        join(s.live.root, `dump-${newId()}.json`),
      ),
      routeId: 'stub:lease',
    });
    const answers = async (origin: string): Promise<boolean> =>
      fetch(origin, { signal: AbortSignal.timeout(3000) }).then(
        () => true,
        () => false,
      );
    const leaseOf = (p: { lease: { resources: { rid: string }[] } }): string =>
      p.lease.resources[0]!.rid;

    // Сессия запущена, кончилась — аренда ещё держится (сервер маршрута отвечает).
    const first = await core.road.prepare(stubStart());
    if (!first.ok) throw new Error(first.reason);
    const p = first.prepared;
    const origin = p.spec.endpoint!.endpoint.baseUrl;
    const launched = await core.road.launch(p);
    if (!launched.ok) throw new Error(launched.reason);
    stops.push(() => p.adapter.stop(launched.handle, 'tree'));
    core.road.started(p, launched.handle, launched.layer);
    const session = core.road.attach({
      task: live,
      sessionId: p.start.sessionId,
      adapter: p.adapter,
      handle: launched.handle,
      context: p.context,
      cwd: p.start.cwd,
    });
    await session.end('tree');
    expect(await answers(origin)).toBe(true);
    expect(live.state.resources[leaseOf(p)]?.status).toBe('live');

    // Аренда, взятая подготовкой, чей запуск так и не состоялся (смерть до process-start).
    const second = await core.road.prepare(stubStart());
    if (!second.ok) throw new Error(second.reason);
    const orphanOrigin = second.prepared.spec.endpoint!.endpoint.baseUrl;
    expect(await answers(orphanOrigin)).toBe(true);

    // Перезапущенное ядро памяти дороги не имеет: аренду сессии оно находит по журналу
    // (`session.started.lease`), а не запущенную — по строке аренды, которую дорога пишет в
    // журнал сразу при взятии (ревью B2r4-F06: иначе сервер маршрута жил бы до ручной уборки).
    const fromJournal = await releaseTaskLeases(live, core.routes, []);
    expect(fromJournal).toEqual({
      verified: [
        { rid: leaseOf(p), fact: expect.any(String) as unknown },
        { rid: leaseOf(second.prepared), fact: expect.any(String) as unknown },
      ],
      leaks: [],
      unread: [],
    });
    expect(await answers(origin)).toBe(false);
    expect(await answers(orphanOrigin)).toBe(false);

    // Маршрута нет в реестре или он промолчал о ресурсе своей аренды — утечка с причиной, не
    // «снято»; следующий конец задачи пробует снова настоящим маршрутом.
    const third = await core.road.prepare(stubStart());
    if (!third.ok) throw new Error(third.reason);
    const thirdOrigin = third.prepared.spec.endpoint!.endpoint.baseUrl;
    const thirdTaken = [{ routeId: 'stub:lease', lease: third.prepared.lease }];
    const missing = { get: () => undefined } as unknown as RouteRegistry;
    expect(await releaseTaskLeases(live, missing, thirdTaken)).toEqual({
      verified: [],
      leaks: [{ rid: leaseOf(third.prepared), reason: expect.stringMatching(/not registered/) }],
      unread: [],
    });
    const silent = {
      get: () => ({ release: async () => ({ verified: [], leaks: [] }) }),
    } as unknown as RouteRegistry;
    expect(await releaseTaskLeases(live, silent, thirdTaken)).toEqual({
      verified: [],
      leaks: [{ rid: leaseOf(third.prepared), reason: expect.stringMatching(/reported nothing/) }],
      unread: [],
    });
    expect(live.state.resources[leaseOf(third.prepared)]?.status).toBe('leak');
    expect(await answers(thirdOrigin)).toBe(true);

    const released = await core.road.releaseTask(live);
    expect(released.leaks).toEqual([]);
    expect(released.verified.map((v) => v.rid)).toEqual([leaseOf(third.prepared)]);
    for (const rid of [leaseOf(p), leaseOf(second.prepared), leaseOf(third.prepared)]) {
      expect(live.state.resources[rid]?.status).toBe('verified');
    }
    expect(await answers(origin)).toBe(false);
    expect(await answers(orphanOrigin)).toBe(false);
    expect(await answers(thirdOrigin)).toBe(false);
    // Повтор конца задачи ничего не снимает второй раз.
    const again = await core.road.releaseTask(live);
    expect(again).toEqual({ verified: [], leaks: [], unread: [] });
    const verifiedLines = lines(live).filter(
      (l) =>
        l.kind === 'resource.verified' &&
        [leaseOf(p), leaseOf(second.prepared), leaseOf(third.prepared)].includes(
          (l.data as { rid: string }).rid,
        ),
    );
    expect(verifiedLines).toHaveLength(3);

    // Бросок звена после аренды (здесь — контекст права) — отказ подготовки, а не исключение:
    // аренда снята сразу с чтением назад, токен сессии не отчеканен (ревью B2r4-F05).
    const minted: unknown[] = [];
    const mint = core.sessionTokens.mint.bind(core.sessionTokens);
    core.sessionTokens.mint = (claims) => {
      minted.push(claims);
      return mint(claims);
    };
    const broken = stubStart();
    const deny = Object.defineProperty({ ...broken.deny }, 'mcpTools', {
      get: () => {
        throw new Error('deny unreadable');
      },
      enumerable: false,
    });
    const thrown = await core.road
      .prepare({ ...broken, deny })
      .catch((error: unknown) => ({ threw: String(error) }));
    core.sessionTokens.mint = mint;
    expect(thrown).toEqual({
      ok: false,
      reason: 'prepare failed: deny unreadable',
      compat: expect.objectContaining({ kind: 'direct' }) as unknown,
    });
    expect(minted).toEqual([]);
    const leased = lines(live)
      .filter(
        (l) =>
          l.kind === 'signal' &&
          (l as JournalLine<'signal'>).data.signal === 'route-lease' &&
          l.sessionId === broken.sessionId,
      )
      .map((l) => JSON.parse((l as JournalLine<'signal'>).data.detail) as { rids: string[] });
    expect(leased).toHaveLength(1);
    for (const rid of leased[0]!.rids) {
      expect(live.state.resources[rid]?.status).toBe('verified');
    }
  }, 120_000);
});
