/**
 * Переходник Jira / Confluence в Qwen Code — настоящим qwen через настоящую панель.
 *
 * Кнопка «Подключить к CLI» у интеграций пишет переходник в раздел MCP
 * АКТИВНОГО CLI. У Qwen это `<QWEN_HOME>/settings.json`; проверяется, что qwen
 * его действительно поднимает и модель видит инструменты Jira. Сценарии:
 *   1. контроль — до подключения: в запросе к модели инструмента `jira_search` нет;
 *   2. подключение: запись в settings.json Qwen, а не в конфиг Claude; в запросе
 *      к модели — `jira_search`;
 *   3. отключение: записи нет, инструмента у модели снова нет.
 *
 * Qwen 0.25 кладёт инструменты MCP не в список инструментов запроса, а за
 * `tool_search` (отложенные инструменты), поэтому заглушка модели сама зовёт
 * `tool_search` с «jira», и свидетель — ответ инструмента в следующем запросе.
 * Свидетель — тело запроса, дошедшего до заглушки модели. Подменена только
 * модель (сетевая граница); панель, адаптер MCP Qwen, сам переходник и CLI —
 * настоящие. QWEN_HOME и дом панели — временные каталоги. CLI — из
 * `STEER_CLI_DIR`, иначе из PATH; нет его — «не проверено», код 2.
 *
 * Запуск: node tools/qa/check-qwen-atlassian-bridge.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { NotChecked, reporter, startStand, wait } from './throwaway-stand.mjs';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

const IS_WIN = process.platform === 'win32';
const BRIDGE = 'agentdeck-atlassian';
const QUESTION = 'Найди задачи Jira';

function findCli() {
  const names = IS_WIN ? ['qwen.cmd', 'qwen.exe', 'qwen'] : ['qwen'];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/**
 * Заглушка OpenAI chat: каждый запрос запоминается целиком. На вопрос человека
 * она зовёт `tool_search` с «jira» — qwen 0.25 прячет инструменты MCP за ним
 * (отложенные инструменты) и в первый запрос их не кладёт. Ответ инструмента
 * приходит следующим запросом; на него и на служебные запросы — «DONE».
 */
async function startModel() {
  const stub = await startStubModel({
    script: ({ info }) => {
      const asked = info.userTexts.some((text) => text.includes(QUESTION));
      const canSearch = info.tools.some((tool) => tool.name === 'tool_search');
      const usage = { input: 5, output: 1 };
      return asked && canSearch && !info.hasToolResult
        ? { tool: { name: 'tool_search', args: { query: 'jira' } }, usage }
        : { text: 'DONE', usage };
    },
  });
  return { base: stub.baseUrl, bodies: stub.bodies, close: () => stub.close() };
}

const { check, finish } = reporter();
const cliDir = findCli();
if (!cliDir) {
  console.log('Не проверено: qwen нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}

const model = await startModel();
const root = mkdtempSync(join(tmpdir(), 'cc-qwen-bridge-'));
const qwenHome = join(root, 'qwen-home');
mkdirSync(qwenHome, { recursive: true });
Object.assign(process.env, {
  QWEN_HOME: qwenHome,
  OPENAI_BASE_URL: `${model.base}/v1`,
  OPENAI_API_KEY: 'x',
  OPENAI_MODEL: 'stub-model',
  QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
});

/** Ответы инструментов во всех запросах хода — для диагноза, если нужного нет. */
const toolResults = (bodies) =>
  [
    ...new Set(
      bodies.split('\n').flatMap((line) => {
        try {
          return (JSON.parse(line).messages ?? [])
            .filter((message) => message.role === 'tool')
            .map((message) => JSON.stringify(message.content).slice(0, 300));
        } catch {
          return [];
        }
      }),
    ),
  ].join(' | ') || 'ответов инструментов нет';

const qwenServers = () => {
  const file = join(qwenHome, 'settings.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {}) : {};
};

let stand;
try {
  stand = await startStand({
    label: 'qwen-bridge',
    settings: { provider: 'qwen' },
    web: false,
    extraPath: [cliDir],
  });
  console.log(`Одноразовая панель ${stand.apiUrl}\n`);
  const claudeServers = () => {
    const file = join(stand.cfg, '.claude.json');
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {}) : {};
  };

  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  /** Новый разговор Qwen, один вопрос; тела запросов этого хода. */
  const ask = async () => {
    const chat = await stand.api('/provider-chat/chats', {
      method: 'POST',
      body: { workdir: project },
    });
    if (chat.status !== 200) throw new Error(`разговор не создан: ${chat.text}`);
    const from = model.bodies.length;
    const sent = await stand.api(`/provider-chat/chats/${chat.body.id}/send`, {
      method: 'POST',
      body: { text: QUESTION },
    });
    check('вопрос принят', sent.status === 200, sent.text);
    for (let i = 0; i < 480; i += 1) {
      const status = (await stand.api(`/provider-chat/chats/${chat.body.id}/status`)).body;
      if (status?.isRunning === false && model.bodies.length > from) break;
      await wait(250);
    }
    await wait(500);
    return model.bodies.slice(from).join('\n');
  };

  console.log('1. Контроль: переходник не подключён');
  const bare = await ask();
  check('запрос дошёл до модели', bare.length > 0);
  check('tool_search не находит jira_search', !bare.includes('jira_search'));

  console.log('\n2. «Подключить к CLI» при активном Qwen');
  const connected = await stand.api('/integrations/mcp/connect', { method: 'POST' });
  check('подключение принято', connected.status === 200, connected.text);
  check(
    'запись в settings.json Qwen',
    Boolean(qwenServers()[BRIDGE]),
    JSON.stringify(qwenServers()),
  );
  check('в конфиг Claude запись не ушла', !claudeServers()[BRIDGE]);
  const state = (await stand.api('/integrations/mcp/connect')).body;
  check('панель видит подключение там же', state?.connected === true, JSON.stringify(state));
  const bridged = await ask();
  check('запрос дошёл до модели', bridged.length > 0);
  check(
    'tool_search находит jira_search переходника',
    bridged.includes('jira_search'),
    toolResults(bridged),
  );

  console.log('\n3. «Отключить»');
  const removed = await stand.api('/integrations/mcp/connect', { method: 'DELETE' });
  check(
    'отключение принято',
    removed.status === 200 && removed.body?.removed === true,
    removed.text,
  );
  check('записи в settings.json Qwen нет', !qwenServers()[BRIDGE]);
  const after = await ask();
  check(
    'tool_search снова не находит jira_search',
    after.length > 0 && !after.includes('jira_search'),
  );
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    process.exitCode = 2;
  } else {
    check('сценарий дошёл до конца', false, error instanceof Error ? error.stack : String(error));
  }
} finally {
  await stand?.stop();
  // Корень прогона (проект, домашний каталог CLI) — иначе он копился в temp.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Держит ещё не вышедший CLI — на вердикт проверки это не влияет.
  }
  model.close();
}
if (process.exitCode !== 2) finish();
