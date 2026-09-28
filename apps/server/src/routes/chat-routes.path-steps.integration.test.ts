import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { groupSchema } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { createHandoffPlanner } from './chat/handoff-routes.ts';
import { registerChatRunRoutes } from './chat/run-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { sandboxRoot } from '../domains/chat/ChatArtifacts.ts';
import { chatPathSteps } from '../domains/chat/path-steps.ts';
import { chatGroupSettingsView, storeTreeReader } from '../domains/chat/chat-autonomy.ts';
import type { ChatLink } from '../lib/app-store/app-store.types.ts';

/**
 * Свои шаги «Пути» группы идут ходами в чате стадии, а следующее звено
 * решается по ответу СТАДИИ. Путь настоящий: маршрут отправки сообщения →
 * реестр → планировщик (шаги, затем звенья) → связи в хранилище на диске;
 * группа и выбор чата — в том же хранилище. Подменён только процесс CLI.
 */

const CHAT = 'чат-правки-путь';
const SESSION = 'sess-fix';

const FIX_LINK: ChatLink = {
  parentChatId: 'родитель',
  createdAt: '2026-09-26T10:00:00.000Z',
  title: 'Переименования',
  branch: 'split/rename',
  groupIndex: 0,
  model: 'sonnet',
  effort: 'medium',
  kind: 'mechanical',
  lowered: true,
  stage: 'fix',
  ceilingModel: 'claude-opus-5',
  workModel: 'sonnet',
  workEffort: 'medium',
};

const STEP_EN = 'Run the whole test suite and paste the summary line.';

describe('шаги пути группы — после стадии, в её чате, с проверкой', () => {
  let root: string;
  let work: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let runs: { prompt: string; sessionId?: string; model?: string; append?: string }[];
  let ended: { stage?: string; status: string; waitingFor?: string }[];
  let gatePassed: boolean;
  /** Чем кончается ход шага: блоком проверки, сбоем CLI или вопросом человеку. */
  let stepEnds: 'gate' | 'error' | 'question';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-path-steps-'));
    work = join(root, 'copy');
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(join(root, 'agentdeck'));
    runs = [];
    ended = [];
    gatePassed = true;
    stepEnds = 'gate';
    registry = new ChatRunRegistry((): RunLike => ({
      start: async (options, onEvent) => {
        runs.push({
          prompt: options.prompt,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.appendSystemPrompt ? { append: options.appendSystemPrompt } : {}),
        });
        if (options.prompt.includes(STEP_EN) && stepEnds !== 'gate') {
          if (stepEnds === 'error') onEvent({ kind: 'error', message: 'API Error 529 overloaded' });
          else onEvent({ kind: 'text', text: 'Which test runner should I use?' });
          onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: SESSION });
          return;
        }
        const text = options.prompt.includes(STEP_EN)
          ? `Tests: 12 passed.\n\n\`\`\`agentdeck:gate\n${JSON.stringify({
              passed: gatePassed,
              note: gatePassed ? '12 passed' : '2 tests red',
            })}\n\`\`\``
          : 'Правки готовы.';
        onEvent({ kind: 'text', text });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: SESSION });
      },
      stop: () => undefined,
    }));
    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains: new HandoffChains(),
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        cascade: {
          linkOf: (aliases) => aliases.map((key) => store.getChatLink(key)).find(Boolean),
          saveLink: (chatId, link) => store.setChatLink(chatId, link),
          markReviewed: () => undefined,
          hasWork: () => true,
          settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
        },
        split: {
          onTriageFinished: () => undefined,
          onChainEnded: (link, outcome) =>
            void ended.push({
              ...(link.stage ? { stage: link.stage } : {}),
              status: outcome.status,
              ...(outcome.waitingFor ? { waitingFor: outcome.waitingFor } : {}),
            }),
          delivers: () => true,
        },
        // Та же сборка, что в `bootstrap/runtime.ts`.
        pathSteps: {
          stepsAt: (aliases, stage) =>
            chatPathSteps(
              store.getGroups(),
              chatGroupSettingsView(storeTreeReader(store), aliases).groupChoice,
              stage,
            ),
        },
      }),
    );
    const ctx = {
      store,
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          appData: join(root, 'agentdeck'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, new ChatSession(registry));
    await app.ready();
    store.setChatLink(CHAT, FIX_LINK);
    store.saveGroup(
      groupSchema.parse({
        id: 'tests-first',
        name: 'Сначала тесты',
        path: {
          steps: [
            {
              id: 'suite',
              anchor: 'fix',
              order: 0,
              kind: 'prompt',
              title: { ru: 'Весь набор тестов', en: 'Whole test suite' },
              prompt: { ru: 'Прогони все тесты.', en: STEP_EN },
              source: 'ru',
              gate: { ru: 'все тесты зелёные', en: 'every test is green' },
              createdAt: '2026-09-26T10:00:00.000Z',
            },
          ],
        },
      }),
    );
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(join(sandboxRoot(), CHAT), { recursive: true, force: true });
  });

  async function say(prompt: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: CHAT, prompt, projectPath: work },
    });
    expect(response.statusCode).toBe(200);
    await new Promise((done) => setTimeout(done, 80));
  }

  const delivers = (): ChatLink[] =>
    Object.values(store.getChatLinks()).filter((link) => link.stage === 'deliver');

  it('шаг идёт продолжением сессии стадии, доставка — после прошедшей проверки', async () => {
    store.setChatGroupSettings(CHAT, { groupChoice: 'global:tests-first' });
    await say('Поправь по замечаниям ревью');

    // Второй прогон — шаг: английский текст, та же сессия, та же модель.
    expect(runs[1]?.prompt).toContain(STEP_EN);
    expect(runs[1]?.prompt).toContain('every test is green');
    expect(runs[1]?.prompt).not.toContain('Прогони все тесты.');
    expect(runs[1]?.sessionId).toBe(SESSION);
    // Третий — доставка, заведённая по ответу стадии, а не шага.
    expect(delivers()).toHaveLength(1);
    expect(runs).toHaveLength(3);
    expect(runs[2]?.prompt).toContain('Правки готовы.');
    expect(runs[2]?.prompt).not.toContain('Tests: 12 passed');
    expect(store.getChatLink(CHAT)?.pathRun).toEqual({ done: ['suite'] });
  });

  it('проваленная проверка держит цепочку: доставки нет, группа ждёт ответа', async () => {
    store.setChatGroupSettings(CHAT, { groupChoice: 'global:tests-first' });
    gatePassed = false;
    await say('Поправь по замечаниям ревью');

    expect(runs).toHaveLength(2);
    expect(delivers()).toHaveLength(0);
    expect(ended.at(-1)).toEqual({ stage: 'fix', status: 'awaiting', waitingFor: 'question' });
    expect(store.getChatLink(CHAT)?.pathRun?.pending).toBe('suite');
  });

  // Ревью 28.09 (F-28): ход шага кончился сбоем или вопросом — `wait` молчал,
  // конвейер не узнавал, группа висела «в работе», ждавшие не стартовали.
  it('ход шага кончился сбоем — конвейер узнаёт, шаг остаётся незакрытым', async () => {
    store.setChatGroupSettings(CHAT, { groupChoice: 'global:tests-first' });
    stepEnds = 'error';
    await say('Поправь по замечаниям ревью');

    expect(runs).toHaveLength(2);
    expect(delivers()).toHaveLength(0);
    expect(ended.at(-1)).toMatchObject({ stage: 'fix', status: 'failed' });
    expect(store.getChatLink(CHAT)?.pathRun?.pending).toBe('suite');
  });

  it('ход шага кончился вопросом — группа ждёт ответа', async () => {
    store.setChatGroupSettings(CHAT, { groupChoice: 'global:tests-first' });
    stepEnds = 'question';
    await say('Поправь по замечаниям ревью');

    expect(runs).toHaveLength(2);
    expect(ended.at(-1)).toEqual({ stage: 'fix', status: 'awaiting', waitingFor: 'question' });
    expect(store.getChatLink(CHAT)?.pathRun?.pending).toBe('suite');
  });

  it('шаг не заводится второй раз на следующем ходу человека', async () => {
    store.setChatGroupSettings(CHAT, { groupChoice: 'global:tests-first' });
    await say('Поправь по замечаниям ревью');
    await say('А описание MR обновил?');

    expect(runs.filter((run) => run.prompt.includes(STEP_EN))).toHaveLength(1);
  });

  it('чат без выбранной группы идёт как шёл: сразу доставка', async () => {
    await say('Поправь по замечаниям ревью');

    expect(runs.some((run) => run.prompt.includes(STEP_EN))).toBe(false);
    expect(delivers()).toHaveLength(1);
  });

  it('обычный чат с группой получает путь подсказкой, ходом шаг не заводится', async () => {
    const plain = 'обычный-чат';
    store.setChatGroupSettings(plain, { groupChoice: 'global:tests-first' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: plain, prompt: 'Переименуй функцию', projectPath: work },
    });
    expect(response.statusCode).toBe(200);
    await new Promise((done) => setTimeout(done, 80));

    expect(runs).toHaveLength(1);
    expect(runs[0]?.append).toContain('group "Сначала тесты"');
    expect(runs[0]?.append).toContain(STEP_EN);
  });

  // Раунд 4: связь ребёнка веера пишется только перед запуском, после сборки
  // дописки, — выбор родителя должен дойти до подсказки уже на первом ходу.
  it('ребёнок веера на первом ходу получает путь группы родителя', async () => {
    store.setChatGroupSettings('родитель-веера', { groupChoice: 'global:tests-first' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: {
        chatId: 'ребёнок-веера',
        prompt: 'Переименуй функцию',
        projectPath: work,
        parentChatId: 'родитель-веера',
        parentTitle: 'Родитель',
      },
    });
    expect(response.statusCode).toBe(200);
    await new Promise((done) => setTimeout(done, 80));

    expect(runs).toHaveLength(1);
    expect(runs[0]?.append).toContain('group "Сначала тесты"');
    expect(runs[0]?.append).toContain(STEP_EN);
  });

  it('чат группы разделения подсказки не получает — шаги идут ходами', async () => {
    store.setChatGroupSettings(CHAT, { groupChoice: 'global:tests-first' });
    await say('Поправь по замечаниям ревью');

    expect(runs[0]?.append ?? '').not.toContain(STEP_EN);
  });

  // Свой шаг внутри порядка скилла и сценарий не заводят ходов: оба едут
  // строкой дописки — в обычный чат и в звено разделения одинаково.
  it('шаг внутри скилла — строкой дописки, ходом не заводится', async () => {
    store.saveGroup(
      groupSchema.parse({
        id: 'inside',
        name: 'Внутри скилла',
        path: {
          steps: [
            {
              id: 'shot',
              anchor: 'work',
              order: 0,
              within: { skillId: 'ticket-delivery', index: 3, after: 'BEFORE shots' },
              kind: 'prompt',
              title: { ru: 'Скрин', en: 'Shot' },
              prompt: { ru: 'Сними экран.', en: 'Take a screenshot of the page.' },
              source: 'ru',
              createdAt: '2026-09-26T10:00:00.000Z',
            },
          ],
        },
      }),
    );
    store.setChatGroupSettings(CHAT, { groupChoice: 'global:inside' });
    await say('Поправь по замечаниям ревью');
    // Звено правок: шаг в его дописке, отдельного хода нет — сразу доставка.
    expect(runs[0]?.append).toContain(
      'Skill `ticket-delivery`, right after its step "BEFORE shots"',
    );
    expect(runs.some((run) => run.prompt.includes('Take a screenshot of the page.'))).toBe(false);
    expect(delivers()).toHaveLength(1);

    store.setChatGroupSettings('обычный-2', { groupChoice: 'global:inside' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'обычный-2', prompt: 'Сделай задачу', projectPath: work },
    });
    expect(response.statusCode).toBe(200);
    await new Promise((done) => setTimeout(done, 80));
    expect(runs.at(-1)?.append).toContain('Take a screenshot of the page.');
  });

  it('сценарий — одной строкой по порядку, без ходов после стадии', async () => {
    store.saveGroup(
      groupSchema.parse({
        id: 'jira',
        name: 'Задача из Jira',
        flow: 'scenario',
        path: {
          steps: ['Read the ticket description.', 'Create a branch for it.'].map((en, order) => ({
            id: `s${order}`,
            anchor: 'fix',
            order,
            kind: 'prompt',
            title: { ru: `Шаг ${order}`, en: `Step ${order}` },
            prompt: { ru: en, en },
            source: 'en',
            createdAt: '2026-09-26T10:00:00.000Z',
          })),
        },
      }),
    );
    store.setChatGroupSettings(CHAT, { groupChoice: 'global:jira' });
    await say('Поправь по замечаниям ревью');
    // Шаг сценария с якорем `fix` ходом после правок НЕ идёт.
    expect(runs.some((run) => run.prompt.includes('Create a branch for it.'))).toBe(false);
    const append = runs[0]?.append ?? '';
    expect(append).toContain('scenario "Задача из Jira"');
    expect(append.indexOf('1. Step 0: Read the ticket description.')).toBeLessThan(
      append.indexOf('2. Step 1: Create a branch for it.'),
    );
    expect(delivers()).toHaveLength(1);
  });
});
