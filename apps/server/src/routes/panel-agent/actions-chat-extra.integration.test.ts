import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  PanelActionResult,
  PanelPendingAction,
  PanelActionsList,
} from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { HANDOFF_BLOCK_LANG } from '@agentdeck/contracts/chat-handoff';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { agentJournalPath } from '../../domains/panel-agent/journal.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff.ts';
import { chatDirectory } from '../../domains/chat/ChatArtifacts.ts';
import { ProviderChatService } from '../../domains/provider-chat.ts';
import { registerChatRunRoutes } from '../chat/run-routes.ts';
import { registerChatTranscriptRoutes } from '../chat/transcript-routes.ts';
import { registerChatArtifactRoutes } from '../chat/artifact-routes.ts';
import { registerChatBrowseRoutes } from '../chat/browse-routes.ts';
import { registerChatHandoffRoutes } from '../chat/handoff-routes.ts';
import { registerProjectRoutes } from '../project-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * Чат сверх первого набора (P3): продолжение в новой сессии, «Перезапустить
 * сессию», файлы чата и «Открыть в редакторе» — настоящими маршрутами окна.
 * Реестр прогонов, цепочки продолжений, транскрипты на диске — настоящие;
 * подменены только процесс CLI (он лишь записывает, чем его запустили) и
 * редактор (фальшивый `code` первым в PATH пишет, какой каталог ему дали).
 *
 * Домашний каталог — временный: папки чатов панели лежат под `~/.agentdeck`.
 */
const ORIGIN = 'http://localhost:8888';
const SECRET = `sk-ant-api03-${'Q'.repeat(40)}`;
const PROJECT_CHAT = 'sess-project';
const PANEL_CHAT = 'sess-panel';
const PLAIN_CHAT = 'sess-plain';
const isWindows = process.platform === 'win32';

const handoffBlock = (done: string, next: string) =>
  '```' +
  HANDOFF_BLOCK_LANG +
  '\n' +
  JSON.stringify({ done, next, checkpoint: '.agent/PROGRESS.md' }) +
  '\n```';

describe('panel-agent actions: chat session, chat files, editor', () => {
  let base: string;
  let home: string;
  let root: string;
  let appData: string;
  let project: string;
  let panelDir: string;
  let bin: string;
  let store: AppStore;
  let pending: PanelPendingActions;
  let registry: ChatRunRegistry;
  let app: FastifyInstance;
  /** Чем реестр запускал CLI: ключ прогона, текст хода, каталог. */
  let started: Array<{ key: string; prompt: string; cwd: string; permissionMode?: string }>;
  let session: ChatSession;
  /** Прогоны, которые не кончаются сами: «идёт ход». */
  let hang: Set<string>;
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
  };

  const transcript = (id: string, cwd: string, records: Array<Record<string, unknown>>) => {
    const dir = join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.jsonl`),
      records.map((record) => JSON.stringify({ sessionId: id, cwd, ...record })).join('\n') + '\n',
    );
  };
  const human = (text: string, at: string) => ({
    type: 'user',
    uuid: `u-${at}`,
    timestamp: at,
    message: { role: 'user', content: text },
  });
  const agent = (text: string, at: string) => ({
    type: 'assistant',
    uuid: `a-${at}`,
    timestamp: at,
    message: { id: `m-${at}`, role: 'assistant', content: [{ type: 'text', text }] },
  });

  beforeEach(async () => {
    // Длинное написание пути: `where` печатает его, а не 8.3 из `tmpdir()`.
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-agent-u5c-chat-')));
    home = join(base, 'home');
    root = join(home, '.claude');
    appData = join(root, 'agentdeck');
    project = join(base, 'work', 'shop');
    bin = join(base, 'bin');
    for (const dir of [appData, project, bin]) mkdirSync(dir, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    // Разговор проекта: последний ход агента несёт блок продолжения.
    transcript(PROJECT_CHAT, project, [
      human('Почини корзину', '2026-09-28T09:00:00.000Z'),
      agent(
        `Корзина починена.\n\n${handoffBlock('Корзина считает скидку', 'Проверить оформление заказа')}`,
        '2026-09-28T09:05:00.000Z',
      ),
    ]);
    // Разговор проекта без блока — продолжать нечего.
    transcript(PLAIN_CHAT, project, [
      human('Что в README?', '2026-09-28T08:00:00.000Z'),
      agent('Там описание сборки.', '2026-09-28T08:01:00.000Z'),
    ]);
    // Разговор в своей папке панели с двумя файлами.
    panelDir = chatDirectory(PANEL_CHAT);
    writeFileSync(join(panelDir, 'notes.md'), `# План\n\nКлюч ${SECRET} не публиковать.\n`);
    writeFileSync(join(panelDir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    transcript(PANEL_CHAT, panelDir, [
      human('Сделай заметку', '2026-09-28T07:00:00.000Z'),
      agent('Готово: notes.md', '2026-09-28T07:01:00.000Z'),
    ]);

    started = [];
    hang = new Set();
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent) => {
        const key = options.permissionPrompt?.runId ?? options.sessionId ?? '';
        started.push({
          key,
          prompt: options.prompt,
          cwd: options.cwd,
          permissionMode: options.permissionMode,
        });
        onEvent({ kind: 'session', sessionId: `cli-${started.length}`, model: 'm', tools: 0 });
        return hang.has(options.sessionId ?? '') ? new Promise(() => undefined) : Promise.resolve();
      },
      stop: () => undefined,
    }));
    store = new AppStore(appData);
    store.addProject({ id: 'p-shop', name: 'Shop', path: project });
    pending = new PanelPendingActions(10_000);
    const ctx = {
      store,
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          mcpConfig: join(home, '.claude.json'),
        },
      },
      backupDir: join(appData, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
      effectiveSettings: () => store.getSettings(),
    } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };
    session = new ChatSession(registry);
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    // Настройки окна — то, что отдаёт `GET /api/settings` (как в соседних проверках).
    app.get('/api/settings', () => ctx.effectiveSettings());
    registerProjectRoutes(app, ctx);
    registerChatRunRoutes(app, ctx, registry, session);
    registerChatTranscriptRoutes(app, ctx);
    registerChatArtifactRoutes(app, ctx);
    registerChatBrowseRoutes(app, ctx);
    registerChatHandoffRoutes(app, ctx, {
      runs: registry,
      chains: new HandoffChains(),
      providerChats: new ProviderChatService(),
      session,
    });
    registerPanelAgentRoutes(app, ctx, {
      hub: createEventHub(),
      pending,
      access,
      streamHeadTimeoutMs: 3_000,
    });
    await app.ready();
  });

  afterEach(async () => {
    pending.cancelAll();
    registry.stopAll();
    await app.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const call = async (name: string, input: unknown): Promise<PanelActionResult> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-u5c' },
    });
    expect(res.statusCode).toBe(200);
    return res.json<PanelActionResult>();
  };

  const waitPending = async (): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const list = (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json<
        PanelPendingAction[]
      >();
      if (list[0]) return list[0];
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('карточка так и не появилась');
  };

  /** Решение человека в окне: Origin интерфейса, без пометки агента. */
  const decided = async (
    name: string,
    input: unknown,
    decision: 'approve' | 'reject',
  ): Promise<{ card: PanelPendingAction; result: PanelActionResult }> => {
    const result = call(name, input);
    const card = await waitPending();
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision },
    });
    expect(res.statusCode).toBe(200);
    return { card, result: await result };
  };

  const fieldsOf = (card: PanelPendingAction) =>
    Object.fromEntries(card.preview.fields.map((field) => [field.labelCode, field.value]));

  it('действия в реестре с заявленным риском', async () => {
    const { actions } = (
      await app.inject({ method: 'GET', url: '/api/agent/actions' })
    ).json<PanelActionsList>();
    const risk = Object.fromEntries(actions.map((action) => [action.name, action.risk]));
    expect(risk).toMatchObject({
      continue_chat_handoff: 'danger',
      restart_chat_session: 'danger',
      list_chat_artifacts: 'read',
      read_chat_artifact: 'read',
      delete_chat_artifact: 'danger',
      open_project_in_editor: 'change',
    });
  });

  it('continue_chat_handoff: карточка несёт предложение агента; одобрено — новый прогон ровно с ним', async () => {
    const { card, result } = await decided(
      'continue_chat_handoff',
      { chat: PROJECT_CHAT },
      'approve',
    );
    expect(card.risk).toBe('danger');
    expect(card.preview.summaryCode).toBe('summary-continue-chat-handoff');
    const fields = fieldsOf(card);
    expect(fields['label-handoff-done']).toBe('Корзина считает скидку');
    expect(fields['label-handoff-next']).toBe('Проверить оформление заказа');
    expect(fields['label-handoff-checkpoint']).toBe('.agent/PROGRESS.md');
    expect(fields['label-project']).toBe(project);
    expect(card.preview.fields).toContainEqual(
      expect.objectContaining({ labelCode: 'label-file-edits', valueCode: 'value-edits-denied' }),
    );

    expect(result).toMatchObject({ outcome: 'done' });
    const next = (result.result as { chatId: string }).chatId;
    expect(next).toBeTruthy();
    expect(next).not.toBe(PROJECT_CHAT);
    // Доказательство — реестр прогонов: запущен новый разговор в каталоге проекта
    // с заданием из блока, а не пересказом.
    expect(started).toHaveLength(1);
    expect(started[0]?.cwd).toBe(project);
    expect(started[0]?.prompt).toContain('Проверить оформление заказа');
    expect(result.page).toEqual({ route: '/chat', focus: next });
    expect(readFileSync(agentJournalPath(appData), 'utf8')).toContain(
      '"summaryCode":"journal-continue-chat-handoff"',
    );
  });

  it('continue_chat_handoff: отклонено — ни одного прогона; без блока — отказ до карточки', async () => {
    const { result } = await decided('continue_chat_handoff', { chat: PROJECT_CHAT }, 'reject');
    expect(result.outcome).toBe('rejected');
    expect(started).toEqual([]);

    const none = await call('continue_chat_handoff', { chat: PLAIN_CHAT });
    expect(none.outcome).toBe('failed');
    expect(none.message).toMatch(/no continuation proposal/);
    expect((await app.inject({ method: 'GET', url: '/api/agent/pending' })).json()).toEqual([]);
    expect(started).toEqual([]);
  });

  it('continue_chat_handoff: право правок — тумблер чата, а не просьба модели (ревью 28.09, M3)', async () => {
    const { card, result } = await decided(
      'continue_chat_handoff',
      { chat: PROJECT_CHAT, allowEdits: true },
      'approve',
    );
    expect(card.preview.fields).toContainEqual(
      expect.objectContaining({ labelCode: 'label-file-edits', valueCode: 'value-edits-denied' }),
    );
    expect(result).toMatchObject({ outcome: 'done' });
    expect(started).toHaveLength(1);
    expect(started[0]?.permissionMode).toBe('default');
  });

  it('restart_chat_session: право правок — тумблер чата, а не просьба модели (ревью 28.09, M3)', async () => {
    // У чата правок нет: `allowEdits: true` от модели не превращает его в чат с правками.
    const { card, result } = await decided(
      'restart_chat_session',
      { chat: PROJECT_CHAT, allowEdits: true },
      'approve',
    );
    expect(card.preview.fields).toContainEqual(
      expect.objectContaining({ labelCode: 'label-file-edits', valueCode: 'value-edits-denied' }),
    );
    expect(result).toMatchObject({ outcome: 'done' });
    expect(started).toHaveLength(1);
    expect(started[0]?.permissionMode).toBe('default');
  });

  it('restart_chat_session: опора несвежая — чату уходит просьба обновить её, автопродолжение включено', async () => {
    // Человек шёл в этом чате с правками — ход агента идёт так же.
    session.armAutoApprove(PROJECT_CHAT, { enabled: false, allowEdits: true });
    const { card, result } = await decided(
      'restart_chat_session',
      { chat: PROJECT_CHAT },
      'approve',
    );
    expect(card.preview.summaryCode).toBe('summary-restart-chat-session');
    expect(card.preview.fields).toContainEqual(
      expect.objectContaining({ labelCode: 'label-file-edits', valueCode: 'value-edits-allowed' }),
    );
    expect(card.preview.fields).toContainEqual(
      expect.objectContaining({ labelCode: 'label-what-happens', valueCode: 'value-restart-how' }),
    );
    expect(result).toMatchObject({ outcome: 'done' });
    expect(result.result).toMatchObject({ mode: 'requested', chatId: PROJECT_CHAT });
    // Просьба ушла В ЭТОТ ЖЕ разговор маршрутом отправки.
    expect(started).toHaveLength(1);
    expect(started[0]?.cwd).toBe(project);
    expect(started[0]?.prompt).toContain('.agent/PROGRESS.md');
    expect(started[0]?.permissionMode).not.toBe('default');
    const state = (
      await app.inject({
        method: 'GET',
        url: `/api/chat/handoff/state?chatId=${PROJECT_CHAT}&sessionId=${PROJECT_CHAT}`,
      })
    ).json<{ auto: boolean }>();
    expect(state.auto).toBe(true);
  });

  it('restart_chat_session: опора свежее последней реплики — новая сессия сразу', async () => {
    const file = join(project, '.agent', 'PROGRESS.md');
    mkdirSync(join(project, '.agent'), { recursive: true });
    writeFileSync(file, '# Progress\n\n- in progress: оформление заказа\n');
    const later = new Date('2026-09-28T10:00:00.000Z');
    utimesSync(file, later, later);

    const { result } = await decided('restart_chat_session', { chat: PROJECT_CHAT }, 'approve');
    expect(result).toMatchObject({ outcome: 'done' });
    const outcome = result.result as { mode: string; chatId: string };
    expect(outcome.mode).toBe('started');
    expect(outcome.chatId).not.toBe(PROJECT_CHAT);
    expect(started).toHaveLength(1);
    expect(started[0]?.prompt).toContain('.agent/PROGRESS.md');
  });

  it('restart_chat_session: пока идёт ход — отказ до карточки, ничего не запущено', async () => {
    hang.add(PROJECT_CHAT);
    registry.start(
      PROJECT_CHAT,
      { prompt: 'ход', cwd: project, sessionId: PROJECT_CHAT },
      { projectPath: project, sessionId: PROJECT_CHAT },
    );
    started.length = 0;
    const refused = await call('restart_chat_session', { chat: PROJECT_CHAT });
    expect(refused.outcome).toBe('failed');
    expect(refused.message).toMatch(/A run is going in this chat/);
    expect(started).toEqual([]);
  });

  it('файлы чата: список и чтение с маской секрета; картинка текстом не читается', async () => {
    const listed = await call('list_chat_artifacts', { chat: PANEL_CHAT });
    expect(listed).toMatchObject({ outcome: 'done' });
    const files = (listed.result as { files: Array<{ name: string }> }).files.map((f) => f.name);
    expect(files.sort()).toEqual(['notes.md', 'pic.png']);
    // Путь папки — внутренность панели, наружу не уходит.
    expect(JSON.stringify(listed.result)).not.toContain(panelDir.replaceAll('\\', '\\\\'));

    const read = await call('read_chat_artifact', { chat: PANEL_CHAT, name: 'notes.md' });
    expect(read).toMatchObject({ outcome: 'done' });
    const text = (read.result as { text: string }).text;
    expect(text).toContain('# План');
    expect(text).not.toContain(SECRET);

    const picture = await call('read_chat_artifact', { chat: PANEL_CHAT, name: 'pic.png' });
    expect(picture.outcome).toBe('failed');
    expect(picture.message).toMatch(/image or PDF/);

    // У разговора в настоящем проекте файлов панели нет: рабочее дерево не её.
    const inProject = await call('list_chat_artifacts', { chat: PROJECT_CHAT });
    expect(inProject.result).toEqual({ files: [] });
  });

  it('delete_chat_artifact: отклонено — файл на месте; одобрено — файла нет на диске', async () => {
    const kept = await decided(
      'delete_chat_artifact',
      { chat: PANEL_CHAT, name: 'notes.md' },
      'reject',
    );
    expect(kept.card.preview.summaryCode).toBe('summary-delete-chat-artifact');
    expect(kept.result.outcome).toBe('rejected');
    expect(existsSync(join(panelDir, 'notes.md'))).toBe(true);

    const gone = await decided(
      'delete_chat_artifact',
      { chat: PANEL_CHAT, name: 'notes.md' },
      'approve',
    );
    expect(gone.result).toMatchObject({ outcome: 'done' });
    expect(existsSync(join(panelDir, 'notes.md'))).toBe(false);
    expect(existsSync(join(panelDir, 'pic.png'))).toBe(true);

    // Файл проекта удалить нельзя: у такого чата файлов панели нет вовсе.
    writeFileSync(join(project, 'README.md'), '# shop\n');
    const refused = await call('delete_chat_artifact', { chat: PROJECT_CHAT, name: 'README.md' });
    expect(refused.outcome).toBe('failed');
    expect(refused.message).toMatch(/not among the files/);
    expect(existsSync(join(project, 'README.md'))).toBe(true);
  });

  it('название чата с вставленным ключом: ни карточка, ни отказ не показывают ключ', async () => {
    // Название чата пишет первое сообщение человека — туда вставляют ключи.
    const keyedProject = 'sess-keyed-project';
    transcript(keyedProject, project, [
      human(`deploy with ${SECRET} please`, '2026-09-28T10:00:00.000Z'),
      agent(
        `Готово.\n\n${handoffBlock('Выкатка прошла', 'Проверить логи')}`,
        '2026-09-28T10:01:00.000Z',
      ),
    ]);
    const keyedPanel = 'sess-keyed-panel';
    const keyedDir = chatDirectory(keyedPanel);
    writeFileSync(join(keyedDir, 'plan.md'), '# План\n');
    transcript(keyedPanel, keyedDir, [
      human(`token ${SECRET} for the plan`, '2026-09-28T10:02:00.000Z'),
      agent('Записал plan.md', '2026-09-28T10:03:00.000Z'),
    ]);

    const seen: string[] = [];
    for (const [name, input] of [
      ['continue_chat_handoff', { chat: keyedProject }],
      ['restart_chat_session', { chat: keyedProject }],
      ['delete_chat_artifact', { chat: keyedPanel, name: 'plan.md' }],
    ] as const) {
      const { card, result } = await decided(name, input, 'reject');
      expect(result.outcome).toBe('rejected');
      seen.push(JSON.stringify(card), JSON.stringify(result));
    }
    const missing = await call('delete_chat_artifact', { chat: keyedPanel, name: 'nope.md' });
    expect(missing.outcome).toBe('failed');
    seen.push(JSON.stringify(missing));

    // Название узнаётся по началу, ключ — нет.
    expect(seen.join('\n')).toContain('deploy with');
    expect(seen.join('\n')).not.toContain(SECRET);
    expect(started).toEqual([]);
    expect(existsSync(join(keyedDir, 'plan.md'))).toBe(true);
  });

  it('open_project_in_editor: только известный редактор; одобрено — редактор получил каталог проекта', async ({
    skip,
  }) => {
    // Фальшивый `code` первым в PATH: пишет, с чем его запустили.
    const log = join(bin, 'code-args.log');
    const script = join(bin, 'fake-code.mjs');
    writeFileSync(
      script,
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    );
    if (isWindows) {
      writeFileSync(join(bin, 'code.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
      const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      process.env.PATH = `${bin}${delimiter}${system32}`;
    } else {
      writeFileSync(join(bin, 'code'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
        mode: 0o755,
      });
      process.env.PATH = `${bin}${delimiter}/usr/bin${delimiter}/bin`;
    }
    // Настоящий редактор человека не должен открыться ни при каком раскладе PATH.
    const found = execFileSync(isWindows ? 'where' : 'which', ['code'], { encoding: 'utf8' })
      .split(/\r?\n/)[0]
      ?.trim();
    if (!found?.toLowerCase().startsWith(bin.toLowerCase())) skip();

    const missing = await call('open_project_in_editor', { project: 'p-shop', editor: 'cursor' });
    expect(missing.outcome).toBe('failed');
    expect(missing.message).toMatch(/Cursor is not installed/);

    const arbitrary = await call('open_project_in_editor', { project: 'p-shop', editor: 'calc' });
    expect(arbitrary.outcome).toBe('invalid');

    const { card, result } = await decided(
      'open_project_in_editor',
      { project: 'p-shop', editor: 'code' },
      'approve',
    );
    expect(card.risk).toBe('change');
    expect(fieldsOf(card)['label-editor']).toBe('VS Code (code)');
    expect(fieldsOf(card)['label-directory']).toBe(project);
    expect(result).toMatchObject({ outcome: 'done' });
    expect(result.result).toEqual({ opened: true, editor: 'code' });
    for (let waited = 0; !existsSync(log) && waited < 5_000; waited += 50) {
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(JSON.parse(readFileSync(log, 'utf8').trim())).toEqual([project]);
  });
});
