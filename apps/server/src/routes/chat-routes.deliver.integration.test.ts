import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HANDOFF_BLOCK_LANG, HANDOFF_GROUP_MAX_CHAIN } from '@agentdeck/contracts/chat-handoff';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { createHandoffPlanner, registerChatHandoffRoutes } from './chat/handoff-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { AUTONOMOUS_PERMISSION_MODE } from '../domains/chat/ChatWorkspace.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import type { ChatLink } from '../lib/app-store/app-store.types.ts';

/**
 * Доставка группы разделения (журнал 55/57/58/59/65, 42/44/45): звено доставки
 * после правок и после чистого ревью, собственный блок продолжения группы без
 * тумблера и авторежим продолжения группы. Планировщик и реестр настоящие,
 * подменён только процесс CLI.
 */

const CWD = 'C:/work/проект-worktrees/rename';

const PROPOSAL = {
  done: 'правки по ревью сделаны',
  next: 'коммит, пуш, MR',
  checkpoint: '.agent/PROGRESS.md',
};

function handoffBlock(): string {
  return ['```' + HANDOFF_BLOCK_LANG, JSON.stringify(PROPOSAL), '```'].join('\n');
}

const WORK_LINK: ChatLink = {
  parentChatId: 'родитель',
  createdAt: '2026-09-07T10:00:00.000Z',
  title: 'Переименования',
  branch: 'split/rename',
  groupIndex: 0,
  model: 'sonnet',
  effort: 'medium',
  kind: 'mechanical',
  lowered: true,
  stage: 'work',
  ceilingModel: 'claude-opus-5',
  ceilingEffort: 'high',
};

const FIX_LINK: ChatLink = {
  ...WORK_LINK,
  stage: 'fix',
  workModel: 'sonnet',
  workEffort: 'medium',
};

const REVIEW_LINK: ChatLink = {
  ...WORK_LINK,
  stage: 'review',
  model: 'claude-opus-5',
  effort: 'high',
  lowered: false,
  workModel: 'sonnet',
  workEffort: 'medium',
};

interface Started {
  chatId: string;
  prompt: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
}

/** Задание первого прогона: ему CLI отвечает `text`, всем звеньям за ним — «Готово.». */
const FIRST_PROMPT = 'задание звена';

function build(
  text: string,
  options: { delivers?: boolean; mtime?: number; every?: boolean } = {},
) {
  const chains = new HandoffChains();
  const registry = new ChatRunRegistry((): RunLike => ({
    start: async (runOptions, onEvent) => {
      onEvent({
        kind: 'text',
        text: options.every || runOptions.prompt === FIRST_PROMPT ? text : 'Готово.',
      });
      onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-звено' });
    },
    stop: () => undefined,
  }));
  const links = new Map<string, ChatLink>();
  const runs: Started[] = [];
  const ended: { stage?: string; status: string }[] = [];
  // Звенья, заведённые в одну миллисекунду, делят ключ `new-<ms>`: связь каждого — отсюда.
  const saved: ChatLink[] = [];
  const start = registry.start.bind(registry);
  registry.start = (chatId, opts, meta) => {
    runs.push({
      chatId,
      prompt: opts.prompt,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    });
    return start(chatId, opts, meta);
  };
  registry.setHandoffPlanner(
    createHandoffPlanner({
      runs: registry,
      chains,
      session: new ChatSession(registry),
      selfBaseUrl: 'http://127.0.0.1:5178',
      stat: () => options.mtime,
      carryLink: (from, to) => {
        const link = from.map((key) => links.get(key)).find(Boolean);
        if (link) links.set(to, link);
      },
      cascade: {
        linkOf: (aliases) => aliases.map((key) => links.get(key)).find(Boolean),
        saveLink: (chatId, link) => {
          links.set(chatId, link);
          saved.push(link);
        },
        markReviewed: () => undefined,
        hasWork: () => true,
        settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
      },
      split: {
        onTriageFinished: () => undefined,
        onChainEnded: (link, outcome) =>
          void ended.push({ ...(link.stage ? { stage: link.stage } : {}), status: outcome.status }),
        identityOf: () => 'Ветка группы: split/rename. Задачи группы: PROJ-7.',
        delivers: () => options.delivers ?? false,
      },
    }),
  );
  return { registry, links, runs, ended, saved };
}

async function run(registry: ChatRunRegistry, chatId: string, permissionMode?: string) {
  registry.start(
    chatId,
    { prompt: FIRST_PROMPT, cwd: CWD, ...(permissionMode ? { permissionMode } : {}) },
    { projectPath: CWD },
  );
  await new Promise((done) => setTimeout(done, 20));
}

const stageRuns = (runs: Started[]) => runs.filter((item) => item.chatId.startsWith('new-'));

describe('звено доставки группы разделения', () => {
  it('правки группы с доставкой заводят звено доставки на модели работы', async () => {
    const { registry, links, runs, ended } = build('Поправил все три замечания.', {
      delivers: true,
    });
    links.set('чат-правки', FIX_LINK);

    await run(registry, 'чат-правки');

    const deliver = stageRuns(runs)[0];
    expect(links.get(deliver?.chatId ?? '')?.stage).toBe('deliver');
    expect(deliver?.model).toBe('sonnet');
    expect(deliver?.permissionMode).toBe(AUTONOMOUS_PERMISSION_MODE);
    // Ветка и задачи — первой строкой (журнал 98), дальше — шаги доставки.
    expect(deliver?.prompt.startsWith('Ветка группы: split/rename.')).toBe(true);
    expect(deliver?.prompt).toContain('git fetch');
    expect(deliver?.prompt).toContain('rebase');
    expect(deliver?.prompt).toContain('MR');
    // Итог группы сказал конец доставки, а не правок.
    expect(ended).toEqual([{ stage: 'deliver', status: 'done' }]);
  });

  it('чистое ревью группы с доставкой тоже заводит доставку', async () => {
    const verdict = ['```agentdeck:review', '{"findings":[]}', '```'].join('\n');
    const { registry, links, runs, ended } = build(`Проверил.\n${verdict}`, { delivers: true });
    links.set('чат-ревью', REVIEW_LINK);

    await run(registry, 'чат-ревью');

    const deliver = stageRuns(runs)[0];
    expect(links.get(deliver?.chatId ?? '')).toMatchObject({ stage: 'deliver', model: 'sonnet' });
    expect(ended).toEqual([{ stage: 'deliver', status: 'done' }]);
  });

  it('правки группы с доставкой знают, что доставка идёт следом (журнал 59d)', async () => {
    const verdict = ['```agentdeck:review', '{"findings":["поправь a.ts:1"]}', '```'].join('\n');
    const { registry, links, runs, saved } = build(`Проверил.\n${verdict}`, { delivers: true });
    links.set('чат-ревью', REVIEW_LINK);

    await run(registry, 'чат-ревью');

    const fix = stageRuns(runs)[0];
    expect(saved[0]?.stage).toBe('fix');
    expect(fix?.prompt).toContain('коммит, пуш и MR им не запрещены');
  });

  it('конец доставки — конец цепочки: итог уходит конвейеру, звеньев больше нет', async () => {
    // Даже блок вердикта в ответе доставки правок не заводит: звено конечно.
    const verdict = ['```agentdeck:review', '{"findings":["ещё одно"]}', '```'].join('\n');
    const { registry, links, runs, ended } = build(
      `MR: https://git/x/-/merge_requests/9\n${verdict}`,
      {
        delivers: true,
      },
    );
    links.set('чат-доставка', { ...FIX_LINK, stage: 'deliver' });

    await run(registry, 'чат-доставка');

    expect(stageRuns(runs)).toEqual([]);
    expect(ended).toEqual([{ stage: 'deliver', status: 'done' }]);
  });

  // M8 (финальное ревью 25.09): работа, которой ревью не положено (шла на
  // потолке), кончала цепочку — до MR группу доводили только напоминания
  // конвейера по фактам git. Теперь за ней сразу звено доставки.
  it('работа на потолке группы с доставкой заводит доставку, без ревью', async () => {
    const { registry, links, runs, ended, saved } = build('Сделал.', { delivers: true });
    links.set('чат-работы', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работы');

    const deliver = stageRuns(runs)[0];
    // Звено — доставка, не ревью; сама работа помечена «доставка этого круга заведена».
    expect(saved[0]?.stage).toBe('deliver');
    expect(links.get('чат-работы')?.deliveredAt).toBeTruthy();
    expect(links.get(deliver?.chatId ?? '')).toMatchObject({ stage: 'deliver', model: 'sonnet' });
    expect(deliver?.prompt).toContain('отдельного ревью у неё нет');
    expect(ended).toEqual([{ stage: 'deliver', status: 'done' }]);
  });

  it('работа на потолке группы без доставки кончается, как раньше', async () => {
    const { registry, links, runs, ended } = build('Сделал.', { delivers: false });
    links.set('чат-работы', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работы');

    expect(stageRuns(runs)).toEqual([]);
    expect(ended).toEqual([{ stage: 'work', status: 'done' }]);
  });

  it('группа без доставки после правок кончается, как раньше', async () => {
    const { registry, links, runs, ended } = build('Поправил.', { delivers: false });
    links.set('чат-правки', FIX_LINK);

    await run(registry, 'чат-правки');

    expect(stageRuns(runs)).toEqual([]);
    expect(ended).toEqual([{ stage: 'fix', status: 'done' }]);
  });
});

describe('собственный блок продолжения группы (журнал 42c, 44)', () => {
  it('группа разделения продолжается по своему блоку без тумблера автомата', async () => {
    const { registry, links, runs, ended } = build(`Правки сделал.\n\n${handoffBlock()}`, {
      mtime: Date.now() + 60_000,
    });
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работа');

    const next = stageRuns(runs)[0];
    expect(next?.prompt).toContain('коммит, пуш, MR');
    // Продолжение идёт авторежимом группы, даже если прогон режим потерял.
    expect(next?.permissionMode).toBe(AUTONOMOUS_PERMISSION_MODE);
    expect(links.get(next?.chatId ?? '')?.parentChatId).toBe('родитель');
    // Цепочку закрыл конец продолжения — ровно один раз.
    expect(stageRuns(runs)).toHaveLength(1);
    expect(ended).toEqual([{ stage: 'work', status: 'done' }]);
  });

  it('план группы с блоком продолжения — всё равно работа, а не продолжение плана', async () => {
    const { registry, links, runs, saved } = build(`План готов.\n\n${handoffBlock()}`, {
      mtime: Date.now() + 60_000,
    });
    links.set('чат-план', { ...WORK_LINK, stage: 'plan', workModel: 'sonnet', task: 'задача' });

    await run(registry, 'чат-план');

    expect(saved[0]?.stage).toBe('work');
    // Первым пошло звено работы, а не чистая сессия по блоку плана.
    expect(stageRuns(runs)[0]?.prompt).not.toContain('коммит, пуш, MR');
  });

  // Живой прогон 25.09.2026: группа доделала свою функцию на первом ходе, а
  // продолжения по её же блокам («перейти к группам sum и isWeekend») чинили
  // чужие файлы и коммитили — задание группы шло в промпт «для ориентира».
  it('продолжение группы держит задание границей и кончается на потолке группы', async () => {
    const { registry, links, runs, ended } = build(
      `Правки сделал.

${handoffBlock()}`,
      {
        mtime: Date.now() + 60_000,
        every: true,
      },
    );
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работа');
    await new Promise((done) => setTimeout(done, 100));

    const hops = stageRuns(runs);
    expect(hops).toHaveLength(HANDOFF_GROUP_MAX_CHAIN);
    const prompt = hops[0]?.prompt ?? '';
    expect(prompt.startsWith('Это новая сессия группы разделения')).toBe(true);
    expect(prompt).toContain('задачи других групп не бери');
    expect(prompt).toContain('ответь коротким итогом без блока продолжения');
    // Задание группы — целиком и после предложения прошлой сессии.
    expect(
      prompt.indexOf(`Задание группы:
${FIRST_PROMPT}`),
    ).toBeGreaterThan(prompt.indexOf('коммит, пуш, MR'));
    // За потолком ход группы кончился, и дальше её ведёт конвейер — один раз.
    expect(ended).toHaveLength(1);
  });

  it('обычный разговор без тумблера по блоку не продолжается', async () => {
    const { registry, runs } = build(`Готово.\n\n${handoffBlock()}`, {
      mtime: Date.now() + 60_000,
    });

    await run(registry, 'обычный');

    expect(stageRuns(runs)).toEqual([]);
  });

  it('группа без права правок продолжается без него', async () => {
    const { registry, links, runs } = build(`Дальше.\n\n${handoffBlock()}`, {
      mtime: Date.now() + 60_000,
    });
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работа', 'default');

    expect(stageRuns(runs)[0]?.permissionMode).toBe('default');
  });
});

describe('POST /api/chat/handoff: продолжение группы разделения (журнал 44)', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let started: { chatId: string; permissionMode?: string }[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-deliver-'));
    project = mkdtempSync(join(tmpdir(), 'cc-deliver-proj-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    started = [];
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async (options) => {
        started.push({
          chatId: options.permissionPrompt?.runId ?? '',
          ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        });
      },
      stop: () => undefined,
    }));
    store = new AppStore(join(root, 'agentdeck'));
    store.setSplitPlan({
      parentChatId: 'parent-1',
      projectPath: project,
      createdAt: '2026-09-24T00:00:00.000Z',
      order: [0],
      request: { allowEdits: true },
      proposal: { groups: [] },
      groups: [],
    });
    store.setChatLink('sess-группа', {
      parentChatId: 'parent-1',
      title: 'Форма входа',
      createdAt: '2026-09-24T10:00:00.000Z',
      branch: 'fix-PROJ-1115',
      groupIndex: 0,
      model: 'sonnet',
    });
    const ctx = {
      location: {
        paths: {
          root,
          appData: join(root, 'agentdeck'),
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatHandoffRoutes(app, ctx, {
      runs: registry,
      chains: new HandoffChains(),
      providerChats: new ProviderChatService(),
      session: new ChatSession(registry),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('продолжение группы с правом правок идёт авторежимом, а не default', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: project, chatId: 'sess-группа', proposal: PROPOSAL },
    });

    expect(response.statusCode).toBe(200);
    expect(started[0]?.permissionMode).toBe(AUTONOMOUS_PERMISSION_MODE);
  });

  it('обычный разговор с правом правок продолжается в авторежиме чата', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: project, chatId: 'обычный', proposal: PROPOSAL, allowEdits: true },
    });

    expect(started[0]?.permissionMode).toBe(AUTONOMOUS_PERMISSION_MODE);
  });

  it('авторежим выключен глобально — продолжение обычного разговора в acceptEdits', async () => {
    store.updateSettings({ chatAutoMode: false });
    await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: project, chatId: 'обычный', proposal: PROPOSAL, allowEdits: true },
    });

    expect(started[0]?.permissionMode).toBe('acceptEdits');
  });

  it('группа, заведённая без права правок, его не получает', async () => {
    store.setSplitPlan({ ...store.getSplitPlan('parent-1')!, request: {} });

    await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: project, chatId: 'sess-группа', proposal: PROPOSAL },
    });

    expect(started[0]?.permissionMode).toBe('default');
  });
});
