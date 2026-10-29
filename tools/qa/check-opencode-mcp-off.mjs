/**
 * Лёгкий набор MCP группы OpenCode (P-16) на НАСТОЯЩЕМ opencode: мессенджер снят
 * целиком, вики трекера — поимённо, имена задач трекера на месте; и в живой сессии
 * `opencode serve`, и в одиночном `opencode run`.
 *
 * Путь: серверы `opencode.json` тем же чтением, что у панели (`readProviderMcpServers`)
 * → правило группы (`foreignGroupMcp`, поимённо) → шаблоны выключателя
 * (`opencodeToolDeny`, как их пишет `setMcpOff` в `runtime.ts`) → НАСТОЯЩИЙ
 * `ProviderChatRun` → либо НАСТОЯЩИЙ `OpencodeServe` (набор правил сессии), либо — сессия
 * не сложилась — одиночный `opencode run` (`OPENCODE_PERMISSION`). Серверы MCP — заглушка
 * `mcp-wiki-stub.mjs` под двумя именами. Свидетель — имена инструментов в запросах
 * opencode к заглушке модели (OpenAI `/chat/completions`): ровно то, что видит модель.
 *
 * Сценарии:
 *   контроль — без выключателя: в запросе все 10 имён обоих серверов (свидетель их видит);
 *   живая сессия — ход ушёл сессией (`transport: session`), в запросе нет ни
 *     `telegram-inbox_*`, ни `jira_confluence_*`, `jira_jira_*` — оба;
 *   одиночный запуск — то же, ход ушёл процессом (`transport` не session).
 *
 * Дом CLI — временный (HOME, XDG_*, OPENCODE_CONFIG): `~/.config/opencode` человека не
 * трогается. Водитель — дочерний процесс с этим окружением: его наследует и сервер
 * `opencode serve`, один на все ходы (почему — у `driver`). Подменена только модель
 * (сетевая граница). Нет opencode — «не
 * проверено», код 2.
 *
 * Запуск: [STEER_CLI_DIR=<каталог с opencode>] node tools/qa/check-opencode-mcp-off.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

const IS_WIN = process.platform === 'win32';
const SELF = fileURLToPath(import.meta.url);
const server = (path) => new URL(`../../apps/server/src/${path}`, import.meta.url).href;
const STUB = fileURLToPath(new URL('./mcp-wiki-stub.mjs', import.meta.url));

if (process.argv[2] === '--driver') await driver(process.argv[3]);
else await main();

/**
 * Водитель: ходы настоящего `ProviderChatRun` по очереди, разговоры разные, сервер
 * `opencode serve` ОДИН на все — как у панели (один `OpencodeServe` на все
 * разговоры). Свой сервер на каждый ход здесь не годится: следующий `opencode serve`
 * в том же каталоге данных после жёсткого снятия прошлого иногда молча не отвечает
 * минутами (замер 25.10, opencode 1.18.35: 3 из 8 стартов под нагрузкой), и ход
 * уходил в одиночный запуск — красное, которое о выключателе ничего не говорит.
 * Перед ходом водитель называет его заглушке модели (`/label/<ход>`): по метке
 * свидетель делит имена инструментов по ходам. Итоги — в файл задания.
 */
async function driver(jobFile) {
  const job = JSON.parse(readFileSync(jobFile, 'utf8'));
  const { ProviderChatRun } = await import(
    server('domains/provider-chat/ProviderChatRun/ProviderChatRun.ts')
  );
  const { OpencodeServe } = await import(server('domains/opencode-serve/opencode-serve.ts'));
  const { getProvider } = await import(server('providers/registry.ts'));
  const { serve, attempt } = await warmServe(OpencodeServe, job.work);
  const results = { warm: attempt };
  if (!serve) return void writeFileSync(jobFile, JSON.stringify(results));
  const noSession = { ask: async () => undefined, steer: async () => false, dispose() {} };
  try {
    for (const turn of job.turns) {
      await fetch(`${job.model}/label/${turn.label}`);
      const events = [];
      await new ProviderChatRun().start(
        {
          provider: getProvider('opencode'),
          history: [{ role: 'user', content: 'say done' }],
          chatId: `chat-${turn.label}`,
          appDataDir: job.appData,
          workdir: job.work,
          detect: () => true,
          sessionServe: turn.session ? serve : noSession,
          timeoutMs: 120_000,
          ...(turn.env ? { platformEnv: turn.env } : {}),
        },
        (event) => events.push(event),
      );
      const done = events.find((event) => event.type === 'done');
      const error = events.find((event) => event.type === 'error');
      results[turn.label] = { transport: done?.transport ?? null, error: error?.error ?? null };
    }
  } finally {
    serve.dispose();
  }
  writeFileSync(jobFile, JSON.stringify(results));
}

/**
 * Сервер для ходов — настоящий `OpencodeServe.ensure` и первый запрос каталога, как в
 * начале `createSession`. Свежий `opencode serve` иногда отвечает на здоровье, а запрос
 * каталога висит без конца (opencode 1.18.35 под нагрузкой: в журнале CLI после чтения
 * конфига — ничего, процесс простаивает); такой сервер снимается и поднимается новый,
 * до трёх раз. Не поднялся — `serve` нет: сессионный путь не проверен, это не красное.
 */
async function warmServe(OpencodeServe, work) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const serve = new OpencodeServe();
    const base = await serve.ensure({ command: 'opencode', workdir: work });
    const res = base
      ? await fetch(`${base}/config?directory=${encodeURIComponent(work)}`, {
          signal: AbortSignal.timeout(30_000),
        }).catch(() => undefined)
      : undefined;
    if (res?.ok) return { serve, attempt };
    serve.dispose();
  }
  return { serve: undefined, attempt: 3 };
}

function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/**
 * Заглушка модели: копит имена инструментов каждого запроса под меткой текущего хода
 * (`seen[метка]`), отвечает «done». `GET /label/<метка>` — начался следующий ход.
 */
async function startModel() {
  const seen = {};
  let label = 'none';
  const stub = await startStubModel({
    // `/label/<ход>` — метка водителя; прочее вне chat/completions — 404, как было.
    route: ({ path }) => {
      if (path.startsWith('/label/')) {
        label = decodeURIComponent(path.slice('/label/'.length));
        return { body: {} };
      }
      return path.includes('chat/completions') ? undefined : { status: 404, body: {} };
    },
    script: ({ request }) => {
      const names = (request.body.tools ?? []).map((tool) => tool.function?.name);
      (seen[label] ??= []).push(...names.filter(Boolean));
      return 'done';
    },
  });
  return { seen, port: stub.port, close: () => stub.close() };
}

async function removeLater(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.log(`  (временный каталог не удалён: ${dir})`);
}

async function main() {
  const cliDir = findCli('opencode');
  if (!cliDir) {
    console.log('НЕ ПРОВЕРЕНО: opencode не найден (STEER_CLI_DIR или PATH)');
    process.exit(2);
  }
  const { foreignGroupMcp } = await import(server('domains/chat/group-profile/group-profile.ts'));
  const { readProviderMcpServers } = await import(server('domains/provider-mcp/section.ts'));
  const { OPENCODE_TOOL_DENY_ENV, opencodeToolDeny } = await import(
    server('domains/opencode-serve/tool-deny.ts')
  );

  let bad = 0;
  const check = (text, ok, detail) => {
    console.log(
      `  ${ok ? '✓' : '✗'} ${text}${!ok && detail ? ` — ${String(detail).slice(0, 700)}` : ''}`,
    );
    if (!ok) bad += 1;
  };

  const model = await startModel();
  const home = mkdtempSync(join(tmpdir(), 'cc-opencode-mcp-off-'));
  const work = join(home, 'work');
  const appData = join(home, 'appdata');
  mkdirSync(work, { recursive: true });
  mkdirSync(appData, { recursive: true });
  const config = join(home, 'opencode.json');
  writeFileSync(
    config,
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        stub: {
          npm: '@ai-sdk/openai-compatible',
          name: 'stub',
          options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'x' },
          models: { 'stub-model': { name: 'stub', tool_call: true } },
        },
      },
      model: 'stub/stub-model',
      small_model: 'stub/stub-model',
      mcp: {
        // `mcp-atlassian` в команде — так панель узнаёт сервер трекера с вики.
        jira: { type: 'local', command: [process.execPath, STUB, 'mcp-atlassian'], enabled: true },
        'telegram-inbox': { type: 'local', command: [process.execPath, STUB], enabled: true },
      },
    }),
  );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(AGENTDECK_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_)/i.test(key)) delete env[key];
  Object.assign(env, {
    PATH: `${cliDir}${delimiter}${process.env.PATH ?? ''}`,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    OPENCODE_CONFIG: config,
  });

  // Серверы — тем же чтением, что `providerMcpEntries` в `runtime.ts`.
  const entries = readProviderMcpServers({ format: 'opencode-json', filePath: config }).map(
    (item) => ({
      id: item.name,
      config: { url: item.url, command: item.command, args: item.args },
    }),
  );
  const mcp = foreignGroupMcp(
    { entries, tasksText: 'PROJ-1 fix the export button', extra: [] },
    true,
  );
  const deny = opencodeToolDeny(mcp.off, mcp.disabledTools);
  console.log('— правило группы');
  check('мессенджер снят целиком', JSON.stringify(mcp.off) === '["telegram-inbox"]', mcp.off);
  check(
    'вики трекера снята поимённо, строка о ней есть',
    deny.includes('jira_confluence_search') && /Tracker wiki tools/.test(mcp.note ?? ''),
    JSON.stringify(deny.slice(0, 4)),
  );

  const platformEnv = { [OPENCODE_TOOL_DENY_ENV]: JSON.stringify(deny) };
  const job = join(home, 'job.json');
  writeFileSync(
    job,
    JSON.stringify({
      model: `http://127.0.0.1:${model.port}`,
      work,
      appData,
      turns: [
        { label: 'plain', session: true },
        { label: 'live', session: true, env: platformEnv },
        { label: 'once', session: false, env: platformEnv },
      ],
    }),
  );
  const child = spawn(process.execPath, ['--experimental-strip-types', SELF, '--driver', job], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  let results = {};
  try {
    results = JSON.parse(readFileSync(job, 'utf8'));
  } catch {
    // водитель упал — итог в логе
  }
  if (results.warm > 1 || (results.warm && !results.plain)) {
    console.log(`  (opencode serve не ответил на запрос каталога — стартов: ${results.warm})`);
  }
  if (results.warm && !results.plain) {
    await model.close();
    await removeLater(home);
    console.log('\nНЕ ПРОВЕРЕНО: opencode serve не поднялся трижды');
    process.exit(2);
  }
  /** Итог хода и имена инструментов MCP, что увидела модель за этот ход. */
  const turn = (label) => ({
    ...(results[label] ?? {
      transport: null,
      error: `водитель упал (код ${code}): ${log.slice(-400)}`,
    }),
    tools: [...new Set(model.seen[label] ?? [])].filter((name) =>
      /^(jira|telegram-inbox)_/.test(name),
    ),
  });
  const wikiOf = (tools) => tools.filter((name) => name.startsWith('jira_confluence_'));
  const inboxOf = (tools) => tools.filter((name) => name.startsWith('telegram-inbox_'));
  const tasksOf = (tools) => tools.filter((name) => name.startsWith('jira_jira_'));

  console.log('— контроль: без выключателя, живая сессия');
  const plain = turn('plain');
  check('ход ушёл сессией', plain.transport === 'session', JSON.stringify(plain));
  check('свидетель видит все 10 имён обоих серверов', plain.tools.length === 10, plain.tools);

  console.log('— живая сессия opencode serve с выключателем (тот же сервер, другой разговор)');
  const live = turn('live');
  check(
    'ход ушёл сессией (ключ не увёл в одиночный запуск)',
    live.transport === 'session',
    JSON.stringify(live),
  );
  check('мессенджера в запросе нет', inboxOf(live.tools).length === 0, live.tools);
  check('вики трекера в запросе нет', wikiOf(live.tools).length === 0, live.tools);
  check('имена задач трекера на месте (2)', tasksOf(live.tools).length === 2, live.tools);

  console.log('— одиночный opencode run с выключателем');
  const once = turn('once');
  check(
    'ход ушёл процессом',
    code === 0 && once.transport !== null && once.transport !== 'session' && !once.error,
    JSON.stringify(once),
  );
  check('мессенджера в запросе нет', inboxOf(once.tools).length === 0, once.tools);
  check('вики трекера в запросе нет', wikiOf(once.tools).length === 0, once.tools);
  check('имена задач трекера на месте (2)', tasksOf(once.tools).length === 2, once.tools);

  await model.close();
  await removeLater(home);
  console.log(bad === 0 ? '\nOK' : `\nПРОВАЛОВ: ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}
