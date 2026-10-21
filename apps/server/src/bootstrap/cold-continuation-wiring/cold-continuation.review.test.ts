import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
  mkdtempSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { RunLike } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import type { ChatEvent } from '../../domains/chat/chat-events.ts';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { conversationKeys } from '../../lib/app-store/chat-links.ts';
import { registerChatRoutes } from '../../routes/chat-routes/chat-routes.ts';
import { removeWhenFree } from '../../lib/remove-when-free.ts';
import { RunRetry } from '../../domains/chat/run-retry/run-retry.ts';
import { COLD_RESUME_INTRO } from '../../domains/chat/split-continue.ts';
import {
  STAGE_TASK_LINE,
  decideContinuation,
} from '../../domains/chat/cold-continuation/cold-continuation.ts';
import { createRuntime, type Runtime } from '../runtime/runtime.ts';

/**
 * Cold review of P0.4 (F-05) through the REAL assembly (`createRuntime`): its
 * continuation policy, its session listener (links, aliases), the conveyor's
 * hub resume, child-tell and review-starter. Only the CLI process is fake: it
 * names a new session when started without one and writes that session's
 * transcript, as the real CLI does.
 */

const PARENT = 'par-review';
const S1 = 'sess-old-1';
const S2 = 'sess-new-2';
const HOUR2 = 2 * 60 * 60_000;
/** Адрес API панели для запроса прав: процесс CLI здесь подменён, его никто не зовёт. */
const BASE_URL = 'http://127.0.0.1:0';
const TASK = 'Implement CSV export for reports: columns A,B,C; keep the old JSON endpoint.';

interface Started {
  runId: string;
  sessionId?: string;
  prompt: string;
  wake?: boolean;
}

describe('F-05 cold review — real runtime path', () => {
  let root: string;
  let copy: string;
  let projects: string;
  let store: AppStore;
  let runtime: Runtime;
  let app: FastifyInstance;
  let started: Started[];
  let nextSession: string;

  const call = (context: number) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 0,
          output_tokens: 10,
          cache_read_input_tokens: context,
          cache_creation_input_tokens: 0,
        },
      },
    });
  const transcript = (id: string, idleMs: number, last = 120_000): string => {
    const dir = join(projects, 'C--copy');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, `${[call(40_000), call(last)].join('\n')}\n`, 'utf8');
    const at = (Date.now() - idleMs) / 1000;
    utimesSync(file, at, at);
    return file;
  };
  const plan = (status: string, waitingFor?: string) =>
    store.setSplitPlan({
      parentChatId: PARENT,
      projectPath: copy,
      createdAt: new Date().toISOString(),
      order: [0],
      request: {},
      proposal: { groups: [{ title: 'g', tasks: ['PROJ-1'] }] },
      groups: [
        {
          index: 0,
          title: 'g',
          branch: 'feat/csv',
          after: [],
          chatId: S1,
          path: copy,
          status,
          ...(waitingFor ? { waitingFor } : {}),
        },
      ],
    } as unknown as SplitPlanRecord);
  const link = (extra: Partial<ChatLink> = {}) =>
    store.setChatLink(S1, {
      parentChatId: PARENT,
      createdAt: new Date().toISOString(),
      groupIndex: 0,
      branch: 'feat/csv',
      task: TASK,
      ...extra,
    });
  const events = (chatId: string): ChatEvent[] => {
    const seen: ChatEvent[] = [];
    runtime.chatRuns.attach(chatId, -1, {
      send: ({ event }) => seen.push(event),
      close: () => undefined,
    });
    return seen;
  };
  const coldNotices = (chatId: string) =>
    events(chatId).filter((event) => event.kind === 'notice' && event.code === 'coldResume');
  const settle = () => new Promise((done) => setTimeout(done, 60));

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-f05r-')));
    copy = join(root, 'copy');
    projects = join(root, 'projects');
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    mkdirSync(copy);
    mkdirSync(projects);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(appData);
    store.updateSettings({
      groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, freshOnColdResume: true },
    });
    const ctx = {
      store,
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    runtime = createRuntime(ctx, 'http://127.0.0.1:1');
    started = [];
    nextSession = S2;
    const fake = (): RunLike => ({
      start: async (options: RunOptions, onEvent) => {
        started.push({
          runId: options.permissionPrompt?.runId ?? '?',
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          prompt: options.prompt,
          ...(options.wake ? { wake: true } : {}),
        });
        const id = options.sessionId ?? nextSession;
        // The real CLI writes the new session's transcript: small window, fresh mtime.
        if (!options.sessionId) transcript(id, 0, 45_000);
        onEvent({ kind: 'session', sessionId: id, model: '', tools: 0 });
        onEvent({ kind: 'text', text: 'done' });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: id });
      },
      stop: () => undefined,
    });
    (runtime.chatRuns as unknown as { createRun: () => RunLike }).createRun = fake;
    app = Fastify();
    registerChatRoutes(
      app,
      ctx,
      runtime.chatRuns,
      runtime.chatSession,
      (chatId) => runtime.treePause.awaitsHuman(chatId),
      (chatId) => runtime.statusChats.assignedOf(chatId),
    );
    await app.ready();
  });

  afterEach(async () => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await app.close();
    await removeWhenFree(root);
  });

  // Q1: the group stays attached after the registry drops the cold session.
  it('Q1: fresh S2 inherits the link, next hub turn resumes S2 (warm), tree stays one node', async () => {
    transcript(S1, HOUR2);
    link({ stage: 'work' });
    plan('started');
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: S1, sessionId: S1, prompt: 'answer', projectPath: copy },
    });
    expect(response.statusCode).toBe(200);
    await settle();
    expect(started[0]?.sessionId).toBeUndefined();
    expect(started[0]?.prompt.startsWith(COLD_RESUME_INTRO)).toBe(true);
    expect(coldNotices(S1)).toHaveLength(1);

    const moved = store.getChatLink(S2);
    expect(moved?.parentChatId).toBe(PARENT);
    expect(moved?.groupIndex).toBe(0);
    const keys = conversationKeys(store.getChatLinks(), S1);
    expect(keys).toEqual(expect.arrayContaining([S1, S2]));
    // One tree node: both keys share the canonical conversation.
    expect(store.getChatLink(S1)?.conversation).toBe(S1);
    expect(moved?.conversation).toBe(S1);
    console.log(
      '[Q1] canonical(S1) =',
      store.canonicalChatKey(S1),
      'plan chatId =',
      store.getSplitPlan(PARENT)?.groups[0]?.chatId,
      'status =',
      store.getSplitPlan(PARENT)?.groups[0]?.status,
    );

    // Next turn: hub «Продолжить» on the plan group still keyed S1.
    plan('awaiting', 'interrupted');
    const out = runtime.splitConveyor.resumeInterrupted(PARENT, 0);
    await settle();
    console.log(
      '[Q1] hub resume',
      JSON.stringify(out),
      'second start',
      JSON.stringify({ runId: started[1]?.runId, sessionId: started[1]?.sessionId }),
    );
    expect(out.resumed).toEqual([0]);
    expect(started[1]?.sessionId).toBe(S2);
    expect(started[1]?.prompt.startsWith(COLD_RESUME_INTRO)).toBe(false);
  });

  // Q2 (finding): the hub/child-tell path is decided by review-starter with the
  // caller intro `coldResumeBrief(group, tasks)` — WITHOUT the stage task the
  // registry path adds (`continuationIntro` → link.task). RED = defect.
  it('Q2: hub «Продолжить» of a cold group carries the link task in the brief', async () => {
    transcript(S1, HOUR2);
    link({ stage: 'work' });
    plan('awaiting', 'interrupted');
    runtime.splitConveyor.resumeInterrupted(PARENT, 0);
    await settle();
    expect(started).toHaveLength(1);
    expect(started[0]?.sessionId).toBeUndefined();
    const prompt = started[0]!.prompt;
    console.log('[Q2] brief head:', JSON.stringify(prompt.slice(0, 420)));
    expect(prompt.split(COLD_RESUME_INTRO)).toHaveLength(2);
    expect(coldNotices(S1)).toHaveLength(1);
    expect(prompt).toContain(`${STAGE_TASK_LINE}\n\n${TASK}`);
  });

  // Q2: a retried fresh turn (died before naming a session) is not briefed twice.
  it('Q2: retry of a fresh turn that died before the session keeps ONE brief', async () => {
    transcript(S1, HOUR2);
    link({ stage: 'work' });
    plan('started');
    runtime.chatRuns.start(
      S1,
      {
        prompt: 'task',
        cwd: copy,
        sessionId: S1,
        permissionPrompt: { runId: S1, baseUrl: BASE_URL },
      },
      { origin: 'groups', projectPath: copy, sessionId: S1 },
    );
    await settle();
    const first = (
      runtime.chatRuns as unknown as {
        runs: Map<string, { options: RunOptions }>;
      }
    ).runs.get(S1)!.options;
    new RunRetry({
      start: (chatId, options, meta) => runtime.chatRuns.start(chatId, options, meta),
      schedule: (run) => {
        run();
        return 1;
      },
      log: () => undefined,
    }).finished({
      chatId: S1,
      projectPath: copy,
      origin: 'groups',
      text: '',
      ok: false,
      startedAt: Date.now(),
      contextTokens: 0,
      options: first,
      error: 'API Error: 529 overloaded',
    } as never);
    await settle();
    expect(started).toHaveLength(2);
    expect(started[1]?.prompt.split(COLD_RESUME_INTRO)).toHaveLength(2);
    // The retry replaced the finished buffer and emitted no second notice.
    expect(coldNotices(S1)).toHaveLength(0);
  });

  // Q3: wake turns, starts without a session — untouched; afterLimit never persisted.
  it('Q3: wake turn and session-less start untouched; afterLimit never stored', async () => {
    transcript(S1, HOUR2);
    link({ stage: 'work' });
    plan('started');
    runtime.chatRuns.start(
      S1,
      {
        prompt: 'wake',
        cwd: copy,
        sessionId: S1,
        wake: true,
        permissionPrompt: { runId: S1, baseUrl: BASE_URL },
      },
      { origin: 'groups', projectPath: copy, sessionId: S1, afterLimit: true },
    );
    await settle();
    expect(started[0]?.sessionId).toBe(S1);
    const reg = runtime.chatRuns as unknown as { runs: Map<string, { meta: object }> };
    expect('afterLimit' in reg.runs.get(S1)!.meta).toBe(false);
    runtime.chatRuns.start(
      'new-1-1',
      { prompt: 'first', cwd: copy, permissionPrompt: { runId: 'new-1-1', baseUrl: BASE_URL } },
      { origin: 'groups', projectPath: copy, afterLimit: true },
    );
    await settle();
    expect(started[1]?.prompt.startsWith(COLD_RESUME_INTRO)).toBe(false);
    expect('afterLimit' in reg.runs.get('new-1-1')!.meta).toBe(false);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (readFileSync(path, 'utf8').includes('afterLimit')) hits.push(path);
      }
    };
    walk(join(root, 'agentdeck'));
    expect(hits).toEqual([]);
  });

  // Q4: unreadable transcript resumes; a throwing policy never blocks the start.
  it('Q4: unreadable transcript → resume; throwing policy → start proceeds', async () => {
    mkdirSync(join(projects, 'C--copy', `${S1}.jsonl`), { recursive: true });
    link({ stage: 'work' });
    plan('started');
    expect(
      runtime.chatRuns.start(
        S1,
        {
          prompt: 'p',
          cwd: copy,
          sessionId: S1,
          permissionPrompt: { runId: S1, baseUrl: BASE_URL },
        },
        { origin: 'groups', projectPath: copy, sessionId: S1 },
      ),
    ).toBe(true);
    await settle();
    expect(started[0]?.sessionId).toBe(S1);
    runtime.chatRuns.setContinuationPolicy(() => {
      throw new Error('boom');
    });
    expect(
      runtime.chatRuns.start(
        'sess-x',
        {
          prompt: 'p',
          cwd: copy,
          sessionId: 'sess-x',
          permissionPrompt: { runId: 'sess-x', baseUrl: BASE_URL },
        },
        { origin: 'groups', projectPath: copy, sessionId: 'sess-x' },
      ),
    ).toBe(true);
    await settle();
    expect(started[1]?.sessionId).toBe('sess-x');
  });

  // Q4: cost of the synchronous decision on a large transcript (warm → resume).
  it('Q4: decision cost on a 40 MB transcript among 300 project dirs', () => {
    for (let index = 0; index < 300; index += 1) mkdirSync(join(projects, `C--p${index}`));
    const dir = join(projects, 'C--copy');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'sess-big.jsonl');
    const filler = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(4000) } })}\n`;
    writeFileSync(file, `${call(40_000)}\n${filler.repeat(10_000)}${call(180_000)}\n`, 'utf8');
    const size = statSync(file).size;
    const economy = { ...GROUP_ECONOMY_DEFAULTS, freshOnColdResume: true };
    const time = (now: number) => {
      const at = performance.now();
      const decided = decideContinuation({
        dir: projects,
        sessionId: 'sess-big',
        cwd: copy,
        economy,
        now,
      });
      return { ms: Math.round(performance.now() - at), kind: decided.kind };
    };
    const warm = [time(Date.now()), time(Date.now()), time(Date.now())];
    const cold = time(Date.now() + HOUR2);
    console.log(
      '[Q4] size MB',
      (size / 1e6).toFixed(1),
      'warm',
      JSON.stringify(warm),
      'cold(+git)',
      JSON.stringify(cold),
    );
    expect(warm[0]?.kind).toBe('resume');
    expect(cold.kind).toBe('fresh');
  });
});
