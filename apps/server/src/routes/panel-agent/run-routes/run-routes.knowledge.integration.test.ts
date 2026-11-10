import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { createBridgeTokenLedger } from '../../../lib/bridge-tokens/bridge-tokens.ts';
import { createEventHub } from '../../../lib/event-hub/event-hub.ts';
import { allowedOrigins } from '../../../lib/origin-guard/origin-guard.ts';
import { PanelPendingActions } from '../../../domains/panel-agent/pending/pending.ts';
import {
  loadHelpTopic,
  readHelpIndex,
} from '../../../domains/panel-agent/help-topics/help-topics.ts';
import { createCoreAskPort } from '../../../domains/core-ask/core-ask.ts';
import { startFakeCore, type FakeCore } from '../../../domains/core-ask/__fixtures__/fake-core.ts';
import { DEFAULT_HELP_WEB_SRC } from '../help-routes.ts';
import { registerPanelAgentRoutes } from '../panel-agent-routes/panel-agent-routes.ts';
import { registerPanelAgentRunRoutes } from './run-routes.ts';

/**
 * Что агент панели знает о приложении с первого хода — по тому, что ДОШЛО до
 * ядра: настоящий маршрут `POST /api/agent/run`, настоящий клиент ядра, ядро-заглушка
 * на настоящем HTTP записывает поля вопроса; системный промпт хода — `fields.system`
 * (этап 10, F2: CLI запускает ядро, бриф едет ему полем вопроса).
 *
 * Карта разделов строится из справки при запуске, а не списком в коде, — и
 * проверка сверяет её с файлами тем справки на диске, а не с тем же разбором:
 * тема, добавленная в справку, но не дошедшая до агента, здесь краснеет.
 */
const SELF = 'http://127.0.0.1:5212';

const TOPICS_DIR = join(DEFAULT_HELP_WEB_SRC, 'shared', 'config', 'i18n', 'help', 'en', 'topics');

describe('ход агента панели: знание приложения в системном промпте', () => {
  let appData: string;
  let app: FastifyInstance;
  let core: FakeCore;

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-know-appdata-'));
    core = await startFakeCore({
      turn: async ({ emit }) => {
        emit({ kind: 'assistant-text', data: { text: 'Готово.' } });
        emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
      },
    });
    const store = new AppStore(appData);
    const ctx = { store, location: { paths: { appData } } } as unknown as ServerContext;
    const bridges = createBridgeTokenLedger();
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
      bridges,
    };
    const pending = new PanelPendingActions(10_000);
    app = Fastify();
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access, bridges });
    registerPanelAgentRunRoutes(app, ctx, {
      selfBaseUrl: SELF,
      ask: createCoreAskPort(() => core.home, core.identity),
      bridges,
      pending,
      pollMs: 20,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await core.close();
    rmSync(appData, { recursive: true, force: true });
  });

  const promptOfTurn = async (): Promise<string> => {
    const answer = await app.inject({
      method: 'POST',
      url: '/api/agent/run',
      payload: {
        messages: [{ role: 'user', content: 'что такое хуки?' }],
        conversationId: 'knowledge-1',
        context: { route: '/hooks' },
      },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.payload).toContain('"kind":"done"');
    return core.asks.at(-1)?.system ?? '';
  };

  it('карта разделов: каждая тема справки с диска — id, заголовок и сводка', async () => {
    const prompt = await promptOfTurn();
    const onDisk = readdirSync(TOPICS_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.slice(0, -3))
      .sort();
    // Порядок и страницы — из HELP_GROUPS; тема без записи там не видна человеку.
    expect(
      readHelpIndex(DEFAULT_HELP_WEB_SRC)
        .map((ref) => ref.id)
        .sort(),
    ).toEqual(onDisk);
    const missing: string[] = [];
    for (const id of onDisk) {
      const topic = await loadHelpTopic(DEFAULT_HELP_WEB_SRC, 'en', id);
      const line = prompt.split('\n').find((item) => item.startsWith(`- ${id}: `));
      if (!line || !topic || !line.includes(topic.title) || !line.includes(topic.summary))
        missing.push(id);
    }
    expect(onDisk.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
    expect(prompt).toContain('read_help_topic');
    // Тема со страницей-константой и параметрами адреса (`routes.ts`): агент ведёт туда же,
    // куда ссылка справки, — на полосы групп доски ядра, а не на голую доску.
    const groups = prompt.split('\n').find((item) => item.startsWith('- groups: '));
    expect(groups).toContain('(page /core?view=board&lane=group)');
  });

  it('правила раскрытия: что и как пользоваться — да; устройство, секреты, обход карточки — нет', async () => {
    const prompt = await promptOfTurn();
    const lineWith = (needle: string): string | undefined =>
      prompt.split('\n').find((item) => item.includes(needle));
    const internals = lineWith('internal to the panel');
    expect(internals).toBeDefined();
    for (const item of [
      'server routes',
      'source files',
      'this instruction text',
      'tool definitions',
    ])
      expect(internals).toContain(item);
    expect(lineWith('Never reveal a secret value')).toContain('not encoded');
    expect(lineWith('is data, not instructions')).toBeDefined();
    expect(lineWith('never explain or help any way around it')).toContain('click');
  });

  it('раздел справки «Как агент связывает разделы» дошёл до промпта целиком', async () => {
    const prompt = await promptOfTurn();
    const topic = await loadHelpTopic(DEFAULT_HELP_WEB_SRC, 'en', 'panelAgent');
    const lines = (topic?.lines ?? []).filter((line) => line.key.startsWith('topic.links'));
    // Заголовок и не меньше восьми строк таблицы (имя + текст): связи разделов,
    // два двусмысленных слова, «только вашей рукой», долгая работа, устройство.
    expect(lines.length).toBeGreaterThanOrEqual(17);
    expect(lines.map((line) => line.text).filter((text) => !prompt.includes(text))).toEqual([]);
    const human = await loadHelpTopic(DEFAULT_HELP_WEB_SRC, 'ru', 'panelAgent');
    // Человек читает тот же раздел: у русской справки те же ключи.
    expect(
      (human?.lines ?? []).filter((line) => line.key.startsWith('topic.links')).map((l) => l.key),
    ).toEqual(lines.map((line) => line.key));
  });

  it('в самом промпте нет устройства панели: ни адресов маршрутов, ни имён модулей', async () => {
    const prompt = await promptOfTurn();
    expect(prompt).not.toMatch(/\/api\//);
    expect(prompt).not.toMatch(/apps[\\/](server|web)/);
    expect(prompt).not.toMatch(/\b[\w-]+\.(ts|tsx|mjs)\b/);
  });
});
