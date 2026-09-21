/**
 * Живое доказательство Т8: что НАСТОЯЩИЙ CLI делает с нашими слоями.
 *
 * Почему без этого прогона таблица `layers.test.ts` ничего не значит. Она
 * проверяет, что панель попросила — вернула такой-то список флагов; а вопрос Т8
 * ровно один и другой: УНОСИТ ли каждый флаг именно тот слой, который подписан
 * на карточке. Ответ на него нельзя прочитать в справке по флагу (у CLI один
 * источник настроек `user` на правила, хуки, права, личные скиллы и личные MCP —
 * из справки это не следует) и нельзя подсмотреть у себя в процессе: он виден
 * только в теле запроса, ушедшего наверх.
 *
 * Поэтому здесь не подменяется ничего, кроме самой модели: одноразовый каталог
 * конфигурации с УНИКАЛЬНОЙ меткой в каждом слое, стаб вместо API Anthropic,
 * настоящий `claude`, запущенный настоящим реестром прогонов панели — то есть
 * через ту же оболочку и те же кавычки, что и в работе. Что нашлось в записанном
 * запросе, то и правда.
 *
 * Метки и где каждая всплывает в запросе:
 *   правила  — текст `CLAUDE.md` в системном промпте
 *   скилл    — имя скилла в перечне системного промпта
 *   хук      — вывод хука SessionStart, вложенный контекстом
 *   MCP      — `mcp__t8marker__marker` в списке инструментов
 *   проект   — ТРИ метки репозитория, а не одна: `CLAUDE.md`, скилл в
 *              `.claude/skills` и сервер из `.mcp.json`. До ревью Т8 здесь лежал
 *              только `CLAUDE.md`, и «проектный слой остаётся» было доказано на
 *              одном файле из трёх — при том, что `--disable-slash-commands` и
 *              `--strict-mcp-config` уносят и проектные скиллы, и проектные
 *              серверы, то есть инструменты самой задачи (MAJOR-1, MAJOR-2)
 *   брокер   — сервер, приехавший своим `--mcp-config`: так приезжает брокер
 *              прав панели, и он обязан пережить `--strict-mcp-config`, иначе
 *              каждый запрос разрешения станет молчаливым отказом посреди
 *              работы агента. Настоящий брокер панели в список инструментов
 *              запроса не попадает вовсе (он назван
 *              `--permission-prompt-tool`, и модели его не показывают),
 *              поэтому его место в последней проверке занимает такой же сервер
 *              с меткой; порядок флагов самой панели доказывает
 *              `check-platform-run-env.mjs`
 *   дописка  — наша добавка к системному промпту: её снимает сама панель
 *   предок   — `.claude/CLAUDE.md` в каталоге ВЫШЕ рабочего: так до агента
 *              панели доезжал `~/.claude/CLAUDE.md` — его временная папка лежит
 *              под домашним каталогом, и CLI читает файл как правила проекта `~`
 *              (случай 7, лёгкое окно агента панели)
 *   домAGENTS— то же место под именем `AGENTS.md` (2.1.277): исключение обязано
 *              снимать ОБА имени (П2.7). Случай пропускается там, где CLI это
 *              имя не читает вовсе — см. случай 9.
 *   дом      — `<дом>/.claude/CLAUDE.md` над проектом, а рядом `CLAUDE.md`
 *   монорепо   монорепозитория между домом и проектом: снятые личные настройки
 *              обязаны унести первый и оставить второй (случай 8, прогон чата)
 *
 * Запуск: `node tools/qa/check-run-layers.mjs`
 * Нужен установленный `claude` (путь можно задать `CLAUDE_CLI`); стенд человека
 * не трогается — каталог конфигурации свой, одноразовый, и в нём же остаются
 * транскрипты прогона.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

const MARK = {
  rule: 'T8RULEMARKER',
  skill: 't8-skill-marker',
  hook: 'T8HOOKMARKER',
  mcp: 'mcp__t8marker__marker',
  project: 'T8PROJMARKER',
  projectSkill: 't8-project-skill-marker',
  projectMcp: 'mcp__t8proj__marker',
  broker: 'mcp__t8broker__marker',
  append: 'T8APPENDMARKER',
  ancestor: 'T8ANCESTORMARKER',
  home: 'T8HOMEMARKER',
  // То же место, но под ИМЕНЕМ `AGENTS.md`: с 2.1.277 CLI читает его тем же
  // поиском вверх, и исключение, снимающее только `CLAUDE.md`, оставило бы
  // личные правила в запросе через вторую дверь (П2.7).
  homeAgents: 'T8HOMEAGENTSMARKER',
  mono: 'T8MONOMARKER',
};

/** Сервер MCP с одной меткой: он же лежит рядом с пробой, откуда эта проверка выросла. */
const MCP_SERVER = fileURLToPath(new URL('./mcp-marker.mjs', import.meta.url));

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок   ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

/**
 * Случай, который эта среда провести не может. Не «ок» и не «плохо»: зелёным он
 * соврал бы, красным обвинил бы код в чужом запрете. Печатается всегда и
 * повторяется в итоге — иначе пропуск тихо зарастает.
 */
const skipped = [];
const skip = (text, why) => {
  console.log(`ПРОПУСК ${text} — ${why}`);
  skipped.push(text);
};

class NotChecked extends Error {}

/**
 * Путь до настоящего CLI. На Windows берётся `claude.exe` пакета: `.cmd` без
 * оболочки не запускается, а с оболочкой кавычки разбирает `cmd.exe` — но это
 * забота панели, и здесь она проверяется как есть, реестром.
 */
function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const root of [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')]) {
    const exe = join(root, tail);
    if (existsSync(exe)) return exe;
  }
  return '';
}

/** Стаб вместо API: записывает каждый запрос и отвечает одним словом. */
function startStub() {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }

      if (req.url?.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (!req.url?.includes('/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }

      seen.push(body);
      const events = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'msg_layers',
              type: 'message',
              role: 'assistant',
              model: body.model ?? 'stub',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          },
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ок' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const [event, data] of events)
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seen,
        close: () => server.close(),
      }),
    );
  });
}

/** Одноразовый каталог конфигурации, в каждом слое — своя метка. */
function buildConfigDir(work) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-layers-home-')));

  writeFileSync(join(home, 'CLAUDE.md'), `# Личные правила\n\n${MARK.rule}\n`, 'utf8');

  const skillDir = join(home, 'skills', MARK.skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${MARK.skill}\ndescription: скилл-метка для проверки слоёв\n---\n\nНичего не делает.\n`,
    'utf8',
  );

  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: `node -e "console.log('${MARK.hook}')"` }],
            },
          ],
        },
        permissions: { deny: ['Bash(rm -rf /*)'] },
      },
      null,
      2,
    ),
    'utf8',
  );

  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: { t8marker: { command: process.execPath, args: [MCP_SERVER] } },
      projects: { [work]: { hasTrustDialogAccepted: true, allowedTools: [] } },
    }),
    'utf8',
  );

  return home;
}

/**
 * Рабочий каталог задачи со СВОИМ слоем: правила, скилл и MCP-сервер репозитория.
 * Именно он отвечает на вопрос, который важнее личных меток: какой флаг уносит
 * инструменты самой задачи, а какой — нет.
 */
function buildProjectDir(inside, instructionsName = 'CLAUDE.md') {
  const work = inside ?? realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-layers-work-')));
  // Имя файла инструкций — параметр: случай 9 кладёт весь путь на `AGENTS.md`,
  // потому что ЛЮБОЙ `CLAUDE.md` в рабочем каталоге или выше отменяет чтение
  // `AGENTS.md` (правило CLI, не наше).
  writeFileSync(join(work, instructionsName), `# Проект\n\n${MARK.project}\n`, 'utf8');

  const skillDir = join(work, '.claude', 'skills', MARK.projectSkill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${MARK.projectSkill}\ndescription: скилл репозитория для проверки слоёв\n---\n\nНичего не делает.\n`,
    'utf8',
  );

  writeFileSync(
    join(work, '.mcp.json'),
    JSON.stringify({ mcpServers: { t8proj: { command: process.execPath, args: [MCP_SERVER] } } }),
    'utf8',
  );
  // Без этого сервер репозитория ждал бы согласия человека и в запрос не попал
  // бы ни при каком флаге — проверка мерила бы собственную забывчивость.
  writeFileSync(
    join(work, '.claude', 'settings.json'),
    JSON.stringify({ enableAllProjectMcpServers: true }, null, 2),
    'utf8',
  );

  return work;
}

/** Что из меток доехало наверх. */
function factsOf(body) {
  if (!body) return undefined;
  const text = JSON.stringify(body.system ?? '') + JSON.stringify(body.messages ?? []);
  const tools = (body.tools ?? []).map((tool) => tool.name);
  return {
    rules: text.includes(MARK.rule),
    skill: text.includes(MARK.skill),
    hook: text.includes(MARK.hook),
    mcp: tools.includes(MARK.mcp),
    project: text.includes(MARK.project),
    projectSkill: text.includes(MARK.projectSkill),
    projectMcp: tools.includes(MARK.projectMcp),
    broker: tools.includes(MARK.broker),
    append: text.includes(MARK.append),
    ancestor: text.includes(MARK.ancestor),
    home: text.includes(MARK.home),
    homeAgents: text.includes(MARK.homeAgents),
    mono: text.includes(MARK.mono),
    text,
    tools,
  };
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new NotChecked('не нашёлся настоящий `claude` — задайте путь через CLAUDE_CLI.');

  // Импорт ВНУТРИ функции: наверху он случился бы до перезапуска со снятием
  // типов, и на Node 22.6 сорвался бы на первом же `.ts`.
  const { ChatRunRegistry } = await import('../../apps/server/src/domains/chat/ChatRunRegistry.ts');
  const { runLayers } = await import('../../apps/server/src/domains/platform/layers.ts');
  const { startPanelAgentRun } =
    await import('../../apps/server/src/domains/panel-agent/runner.ts');
  const { resolvePanelAgentLaunch } =
    await import('../../apps/server/src/domains/panel-agent/launch.ts');
  const { AppStore } = await import('../../apps/server/src/lib/app-store.ts');
  const { defaultOurRules, defaultPlatformRules } =
    await import('../../packages/contracts/src/platform.ts');

  const stub = await startStub();
  console.log(`CLI: ${exe}\nСтаб: ${stub.url}\n`);

  /** Один прогон настоящего CLI через настоящий реестр панели. */
  const runCase = async (label, ours, tree) => {
    const work = tree?.work ?? buildProjectDir();
    const home = buildConfigDir(tree?.cwd ?? work);

    // Контур целиком выдуман здесь, но слои считает НАСТОЯЩИЙ `runLayers` —
    // вторая, «проверочная» копия списка флагов проверяла бы сама себя.
    const platform = {
      rules: { platform: defaultPlatformRules(), ours: { ...defaultOurRules(), ...ours } },
    };
    const layers = runLayers(platform);

    const runs = new ChatRunRegistry();
    runs.setPlatformRouting(() => ({
      env: {
        ANTHROPIC_BASE_URL: stub.url,
        ANTHROPIC_AUTH_TOKEN: 'layers-stub-token',
        ANTHROPIC_API_KEY: 'layers-stub-token',
        ANTHROPIC_MODEL: 'stub-layers',
        DISABLE_AUTOUPDATER: '1',
        // Тишина в сети — умолчание проверки. Но ровно эти переменные отключают
        // и забор флагов у Anthropic, а без него CLI не читает `AGENTS.md`
        // вовсе (док «Features that need feature-flag fetching»). Случай про
        // имя файла просит их снять — `flags: true`.
        ...(tree?.flags
          ? {}
          : {
              DISABLE_TELEMETRY: '1',
              DISABLE_ERROR_REPORTING: '1',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            }),
        ...tree?.env,
      },
      layers,
    }));

    const from = stub.seen.length;
    runs.start(
      `layers-${label}`,
      {
        prompt: 'скажи ок',
        cwd: tree?.cwd ?? work,
        configDir: home,
        // Команда — панельная по умолчанию (`claude.cmd` через оболочку
        // Windows): именно этот путь и надо проверять, кавычки в нём разбирает
        // `cmd.exe`. Свой путь подставляется только заданным `CLAUDE_CLI`.
        ...(process.env.CLAUDE_CLI ? { command: process.env.CLAUDE_CLI } : {}),
        permissionMode: 'default',
        appendSystemPrompt: MARK.append,
        permissionPrompt: { runId: `layers-${label}`, baseUrl: 'http://127.0.0.1:1' },
      },
      { origin: 'chat' },
    );

    // Ждём не завершения прогона, а записанного запроса: он и есть предмет.
    for (let i = 0; i < 4 * 120 && stub.seen.length === from; i += 1) await wait(250);
    runs.stopAll?.();
    await wait(300);

    const facts = factsOf(stub.seen[from]);
    // Транскрипт пишется ВНУТРЬ каталога конфигурации — тот самый факт, из-за
    // которого слои снимаются флагами, а не подменой каталога: подменив его,
    // панель потеряла бы переписку, продолжение и аналитику.
    const transcripts = existsSync(join(home, 'projects'));
    if (!tree) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return { facts, transcripts, args: layers.args };
  };

  /** Прямой запуск CLI — только ради поведения самого CLI (случай 6). */
  const runRaw = async (label, args) => {
    const work = buildProjectDir();
    const home = buildConfigDir(work);
    const brokerConfig = join(work, 'broker-mcp.json');
    writeFileSync(
      brokerConfig,
      JSON.stringify({
        mcpServers: { t8broker: { command: process.execPath, args: [MCP_SERVER] } },
      }),
      'utf8',
    );

    const from = stub.seen.length;
    const cli = spawn(
      exe,
      ['-p', 'скажи ок', '--permission-mode', 'default', '--mcp-config', brokerConfig, ...args],
      {
        cwd: work,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_BASE_URL: stub.url,
          ANTHROPIC_AUTH_TOKEN: 'layers-stub-token',
          ANTHROPIC_API_KEY: 'layers-stub-token',
          ANTHROPIC_MODEL: 'stub-layers',
          DISABLE_TELEMETRY: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_ERROR_REPORTING: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        stdio: ['ignore', 'ignore', 'ignore'],
        shell: false,
      },
    );
    await new Promise((done) => {
      const timer = setTimeout(() => {
        cli.kill();
        done();
      }, 120_000);
      cli.on('close', () => {
        clearTimeout(timer);
        done();
      });
      cli.on('error', () => {
        clearTimeout(timer);
        done();
      });
    });

    const facts = factsOf(stub.seen[from]);
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return { label, facts };
  };

  const stubEnv = {
    ANTHROPIC_BASE_URL: stub.url,
    ANTHROPIC_AUTH_TOKEN: 'layers-stub-token',
    ANTHROPIC_API_KEY: 'layers-stub-token',
    ANTHROPIC_MODEL: 'stub-layers',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };

  /**
   * Ход агента панели настоящим запускателем (`resolvePanelAgentLaunch` →
   * `startPanelAgentRun`: те же флаги, та же оболочка, настоящий переходник) в
   * дереве, где над временной папкой лежит `.claude/CLAUDE.md` с меткой — модель
   * домашнего каталога человека. Временная папка подменяется через TEMP/TMP:
   * запускатель берёт её у `os.tmpdir()`, и другого способа поставить над ней
   * «предка» без записи в настоящий `~` нет.
   */
  const runPanelAgent = async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-layers-ancestor-')));
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'CLAUDE.md'),
      `# Предок

${MARK.ancestor}
`,
      'utf8',
    );
    const temp = join(root, 'Temp');
    mkdirSync(temp);
    const home = buildConfigDir(temp);
    const appData = join(root, 'appdata');
    mkdirSync(appData);

    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    const setTemp = (value) => {
      for (const key of Object.keys(saved)) {
        if (value === undefined) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        } else process.env[key] = value;
      }
    };

    // Положительный контроль: прежние флаги агента (`project,local`) в том же
    // дереве. Метка предка обязана доехать — иначе зелень случая ниже значила бы
    // только, что проба её не видит.
    const control = join(temp, 'control');
    mkdirSync(control);
    const controlFrom = stub.seen.length;
    const cli = spawn(
      exe,
      ['-p', 'скажи ок', '--setting-sources', 'project,local', '--strict-mcp-config'],
      {
        cwd: control,
        env: { ...process.env, ...stubEnv, CLAUDE_CONFIG_DIR: home },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    await new Promise((done) => {
      const timer = setTimeout(() => (cli.kill(), done()), 120_000);
      cli.on('close', () => (clearTimeout(timer), done()));
      cli.on('error', () => (clearTimeout(timer), done()));
    });
    const controlFacts = factsOf(stub.seen[controlFrom]);

    let facts;
    let command;
    setTemp(temp);
    try {
      const launch = resolvePanelAgentLaunch({
        store: new AppStore(appData),
        appDataDir: appData,
        gatewayPort: () => 0,
      });
      if (!launch.ok) throw new NotChecked(`запускатель агента отказал: ${launch.message}`);
      command = process.env.CLAUDE_CLI ?? launch.command;
      const from = stub.seen.length;
      const run = startPanelAgentRun({
        command,
        env: { ...launch.env, ...stubEnv, CLAUDE_CONFIG_DIR: home },
        // Панели нет: переходник отдаст один инструмент `panel_unavailable`, и
        // этого хватает — вопрос в том, что КРОМЕ него в запросе.
        selfBaseUrl: 'http://127.0.0.1:1',
        conversationId: 'layers-panel-agent',
        context: { route: '/projects' },
        messages: [{ role: 'user', content: 'скажи ок' }],
        onEvent: () => {},
      });
      for (let i = 0; i < 4 * 120 && stub.seen.length === from; i += 1) await wait(250);
      run.stop();
      await Promise.race([run.done, wait(10_000)]);
      facts = factsOf(stub.seen[from]);
    } finally {
      setTemp(undefined);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return { facts, controlFacts, command };
  };

  /**
   * Проект ПОД домашним каталогом, как у человека: `<дом>/.claude/CLAUDE.md` с
   * меткой, `<дом>/mono/CLAUDE.md` — правила монорепозитория, `<дом>/mono/proj` —
   * сама задача. Дом подменяется переменными окружения процесса CLI
   * (`USERPROFILE`/`HOME`), настоящий `~` не трогается. На Windows рабочий каталог
   * отдаётся в НИЖНЕМ регистре: CLI сравнивает исключения с путём, собранным от
   * рабочего каталога как он есть, с учётом регистра (замерено), а путь проекта в
   * панели приходит в том регистре, в каком его выбрал человек.
   */
  const runUnderHome = async (label, ours, options = {}) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-layers-under-home-')));
    mkdirSync(join(root, '.claude'), { recursive: true });
    // Имя файла инструкций — параметр случая, а не константа. При `agents: true`
    // на `AGENTS.md` переводится ВЕСЬ путь от рабочего каталога вверх: CLI
    // читает `AGENTS.md` только там, где ни в рабочем каталоге, ни выше нет ни
    // одного `CLAUDE.md`/`.claude/CLAUDE.md`/`CLAUDE.local.md`. Оставь здесь
    // хоть один — и метка не доехала бы независимо от нашего исключения,
    // а проверка мерила бы правило CLI вместо своего флага.
    const name = options.agents ? 'AGENTS.md' : 'CLAUDE.md';
    writeFileSync(
      join(root, '.claude', name),
      `# Дом\n\n${options.agents ? MARK.homeAgents : MARK.home}\n`,
      'utf8',
    );
    const mono = join(root, 'mono');
    const work = join(mono, 'proj');
    mkdirSync(work, { recursive: true });
    writeFileSync(join(mono, name), `# Монорепозиторий\n\n${MARK.mono}\n`, 'utf8');
    buildProjectDir(work, name);
    const cwd = process.platform === 'win32' ? work.toLowerCase() : work;
    try {
      return await runCase(label, ours, {
        work,
        cwd,
        env: { USERPROFILE: root, HOME: root },
        flags: options.agents === true,
      });
    } finally {
      // Дерево CLI, остановленное реестром, отпускает рабочий каталог не сразу
      // (EBUSY на Windows). Недоудалённая папка во временном каталоге — не повод
      // ронять проверку, чей вердикт уже в записанном запросе.
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
      } catch (error) {
        console.log(`(не удалилось ${root}: ${error.code ?? error.message})`);
      }
    }
  };

  try {
    // ── 1. Всё наше на месте: метки должны найтись ВСЕ ────────────────────────
    // Без этой строки любая «зелень» ниже ничего не стоит: она докажет, что
    // метки вообще доезжают, а не что флаг их снял.
    const full = await runCase('full', {});
    check(Boolean(full.facts), 'запрос наверх записан на полном наборе слоёв');
    if (full.facts) {
      check(full.args.length === 0, `флагов снятия нет: ${JSON.stringify(full.args)}`);
      check(full.facts.rules, 'личные правила доезжают до запроса');
      check(full.facts.hook, 'вывод хука доезжает до запроса');
      check(full.facts.skill, 'личный скилл доезжает до запроса');
      check(full.facts.mcp, 'личный MCP-сервер доезжает до запроса');
      check(full.facts.append, 'дописка панели к системному промпту на месте');
      check(full.facts.project, 'проектный CLAUDE.md на месте');
      check(full.facts.projectSkill, 'скилл репозитория доезжает до запроса');
      check(full.facts.projectMcp, 'MCP-сервер репозитория доезжает до запроса');
    }
    check(full.transcripts, 'транскрипт пишется внутрь каталога конфигурации');

    // ── 2. Снятые личные настройки ───────────────────────────────────────────
    // Здесь и видно, почему галочка одна на пять вещей: `--setting-sources`
    // уносит источник `user` целиком. Рисовать три галочки там, где исполняется
    // одна, значило бы обещать раздельное снятие (подпись `rules-partial`).
    const settings = await runCase('settings', { settings: false });
    check(Boolean(settings.facts), 'запрос записан и со снятыми личными настройками');
    if (settings.facts) {
      check(!settings.facts.rules, 'личные правила сняты');
      check(!settings.facts.hook, 'хуки сняты тем же флагом');
      check(!settings.facts.skill, 'личные скиллы уходят вместе с ними');
      check(!settings.facts.mcp, 'личные MCP-серверы уходят вместе с ними');
      // Весь проектный слой, а не один файл: это ЕДИНСТВЕННЫЙ флаг, про который
      // карточка обещает «правила задачи остаются», и обещание проверяется
      // тремя метками сразу (ревью Т8).
      check(settings.facts.project, 'проектный CLAUDE.md остаётся — это правила задачи');
      check(settings.facts.projectSkill, 'скилл репозитория остаётся');
      check(settings.facts.projectMcp, 'MCP-сервер репозитория остаётся');
    }

    // ── 3. Скиллы — своим флагом, не трогая остального ────────────────────────
    const skills = await runCase('skills', { skills: false });
    check(Boolean(skills.facts), 'запрос записан и со снятыми скиллами');
    if (skills.facts) {
      check(!skills.facts.skill, 'скилл снят');
      check(skills.facts.rules && skills.facts.hook, 'правила и хуки при этом на месте');
      check(skills.facts.mcp, 'MCP-серверы при этом на месте');
      // Неприятная правда, названная на карточке: раздельного флага у CLI нет,
      // и вместе с личными уходят скиллы репозитория (ревью Т8, MAJOR-2).
      check(!skills.facts.projectSkill, 'скилл репозитория уходит тем же флагом');
      check(skills.facts.project, 'проектный CLAUDE.md при этом остаётся');
    }

    // ── 4. MCP — своим флагом, и брокер прав его переживает ───────────────────
    const mcp = await runCase('mcp', { mcp: false });
    check(Boolean(mcp.facts), 'запрос записан и со снятыми MCP-серверами');
    if (mcp.facts) {
      check(!mcp.facts.mcp, 'личный MCP-сервер снят');
      check(mcp.facts.rules && mcp.facts.skill, 'правила и скиллы при этом на месте');
      // И здесь то же: снимается ВЕСЬ MCP, включая инструменты самой задачи
      // (ревью Т8, MAJOR-1) — на карточке это сказано словами.
      check(!mcp.facts.projectMcp, 'MCP-сервер репозитория уходит тем же флагом');
      check(mcp.facts.projectSkill, 'скиллы репозитория при этом на месте');
    }

    // ── 5. Общий выключатель: не едет ничего нашего ───────────────────────────
    const none = await runCase('none', { enabled: false });
    check(Boolean(none.facts), 'запрос записан и со снятым общим выключателем');
    if (none.facts) {
      const nothing = !none.facts.rules && !none.facts.hook && !none.facts.skill && !none.facts.mcp;
      check(nothing, 'ни правил, ни хуков, ни скиллов, ни MCP');
      check(!none.facts.append, 'дописки панели нет: её снимает сама панель, флага у неё нет');
      check(none.facts.project, 'проектный CLAUDE.md остаётся и здесь');
      // А вот проектные скиллы и серверы — нет, и человек, снявший всё разом,
      // должен прочитать это на карточке, а не обнаружить по поведению агента.
      check(
        !none.facts.projectSkill && !none.facts.projectMcp,
        'скиллы и MCP репозитория при снятии всего уходят тоже',
      );
    }

    // ── 6. Брокер прав переживает снятие MCP ──────────────────────────────────
    // Здесь CLI запускается напрямую, и это единственное место, где так: предмет
    // проверки — поведение самого CLI («сервер, приехавший своим --mcp-config,
    // остаётся при --strict-mcp-config»), а не проводка панели. Настоящий брокер
    // подставить нельзя: он назван `--permission-prompt-tool` и в список
    // инструментов запроса не попадает вовсе. Порядок флагов при этом не решает
    // ничего: здесь `--mcp-config` стоит ПЕРЕД `--strict-mcp-config`, и брокер
    // жив — прежнее утверждение «переставь флаги, и права умрут» опровергнуто
    // этим же прогоном (ревью Т8, MINOR-3).
    const broker = await runRaw('broker', ['--strict-mcp-config']);
    check(Boolean(broker.facts), 'запрос записан и в прямом запуске');
    if (broker.facts) {
      check(!broker.facts.mcp, 'личный MCP-сервер снят и в прямом запуске');
      check(broker.facts.broker, 'сервер, приехавший своим --mcp-config, остался');
    }

    // ── 7. Агент панели — лёгкое окно ────────────────────────────────────────
    // Ни одного нашего слоя и ни одного чужого проекта: только системная дописка
    // агента и инструменты переходника панели. Проверяется НАСТОЯЩИМ
    // запускателем агента, а не списком флагов: до 17.09.2026 флаги были
    // «правильные», а `~/.claude/CLAUDE.md` доезжал до модели через поиск вверх.
    const agent = await runPanelAgent();
    check(Boolean(agent.controlFacts), 'контроль: запрос записан при прежних флагах агента');
    if (agent.controlFacts) {
      check(
        agent.controlFacts.ancestor,
        'контроль: при `project,local` .claude/CLAUDE.md предка доезжает (проба его видит)',
      );
    }
    check(Boolean(agent.facts), `агент панели: запрос записан (${agent.command})`);
    if (agent.facts) {
      const f = agent.facts;
      check(!f.ancestor, 'агент панели: CLAUDE.md предка (модель ~/.claude/CLAUDE.md) не доехал');
      check(!f.rules, 'агент панели: личные правила каталога конфигурации не доехали');
      check(
        !f.hook && !f.skill && !f.mcp,
        'агент панели: ни хука, ни личного скилла, ни личного MCP',
      );
      check(
        f.text.includes('agent of the AgentDeck panel'),
        'агент панели: его системная дописка на месте',
      );
      const foreign = f.tools.filter((name) => !name.startsWith('mcp__agentdeck-panel__'));
      check(
        f.tools.length > 0 && foreign.length === 0,
        `агент панели: инструменты только переходника панели (${f.tools.join(', ') || 'нет'})`,
      );
    }

    // ── 8. Проект под домашним каталогом ─────────────────────────────────────
    // Случаи 1–5 кладут проект во временную папку без «дома» над ней, и там
    // снятые личные настройки выглядели снятыми. У человека проект лежит под `~`,
    // и CLI поиском вверх читал `~/.claude/CLAUDE.md` как правила ПРОЕКТА `~` —
    // при `project,local` (находка A2b). Контроль с полным набором обязателен:
    // без него «метки дома нет» могло бы значить «поиск вверх до дома не доходит».
    const homeFull = await runUnderHome('home-full', {});
    check(Boolean(homeFull.facts), 'под домом: запрос записан на полном наборе');
    if (homeFull.facts) {
      check(homeFull.facts.home, 'контроль: под домом ~/.claude/CLAUDE.md доезжает поиском вверх');
      check(homeFull.facts.mono, 'контроль: CLAUDE.md монорепозитория доезжает');
    }
    const homeOff = await runUnderHome('home-settings', { settings: false });
    check(Boolean(homeOff.facts), 'под домом: запрос записан со снятыми личными настройками');
    if (homeOff.facts) {
      check(
        !homeOff.facts.home,
        'под домом: ~/.claude/CLAUDE.md снят вместе с личными настройками',
      );
      check(!homeOff.facts.rules, 'под домом: CLAUDE.md каталога конфигурации снят');
      check(
        homeOff.facts.mono,
        'под домом: CLAUDE.md монорепозитория остаётся — это правила задачи',
      );
      check(homeOff.facts.project, 'под домом: CLAUDE.md проекта остаётся');
    }

    // ── 9. То же под именем AGENTS.md ────────────────────────────────────────
    // С 2.1.277 личный файл может называться `AGENTS.md`, и CLI читает его тем же
    // поиском вверх. Исключение, снимающее одно имя, оставляло бы снятые личные
    // правила в запросе через второе (П2.7). Весь путь от рабочего каталога вверх
    // переведён на `AGENTS.md`: хоть один `CLAUDE.md` над ним — и CLI не читает
    // `AGENTS.md` вовсе. Контроль обязателен: без него «метки нет» значило бы
    // лишь, что до этого имени дело не дошло.
    // Чтение `AGENTS.md` включено флагом, который CLI забирает у Anthropic, и в
    // сессии без этого забора он читает только `CLAUDE.md` (док «Features that
    // need feature-flag fetching»). Тишину в сети случай поэтому снимает
    // (`flags: true`), но стабовый токен забор не проходит — и тогда контроль
    // пуст. Это запрет среды, а не наша ошибка: случай честно пропускается, а
    // «снят» без доехавшей метки не засчитывается ни при каких условиях.
    const agentsFull = await runUnderHome('home-agents-full', {}, { agents: true });
    check(Boolean(agentsFull.facts), 'под домом (AGENTS.md): запрос записан на полном наборе');
    if (agentsFull.facts?.homeAgents !== true) {
      skip(
        'под домом (AGENTS.md): исключение снимает и второе имя',
        'CLI не прочитал ни одного AGENTS.md даже на полном наборе — сессия без флагов Anthropic (стабовый токен), и чтение этого имени в ней выключено целиком',
      );
    } else {
      check(true, 'контроль: под домом ~/.claude/AGENTS.md доезжает поиском вверх');
      const agentsOff = await runUnderHome(
        'home-agents-settings',
        { settings: false },
        { agents: true },
      );
      check(
        Boolean(agentsOff.facts),
        'под домом (AGENTS.md): запрос записан со снятыми личными настройками',
      );
      if (agentsOff.facts) {
        check(
          !agentsOff.facts.homeAgents,
          'под домом: ~/.claude/AGENTS.md снят вместе с личными настройками',
        );
        check(agentsOff.facts.mono, 'под домом (AGENTS.md): AGENTS.md монорепозитория остаётся');
        check(agentsOff.facts.project, 'под домом (AGENTS.md): AGENTS.md проекта остаётся');
      }
    }
  } finally {
    stub.close();
  }

  console.log(
    bad === 0
      ? '\nКаждый флаг уносит ровно тот слой, который подписан на карточке.'
      : `\nПроблем: ${bad}`,
  );
  if (skipped.length > 0) console.log(`Не проверено здесь: ${skipped.join('; ')}.`);
  process.exit(bad === 0 ? 0 : 1);
}

// Типы снимаются самим Node с 22.18; на более старом 22.x нужен флаг, поэтому
// перезапускаем себя с ним, а не падаем с невнятным ERR_UNKNOWN_FILE_EXTENSION.
if (!process.features.typescript && !process.env.CC_LAYERS_RETRY) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, CC_LAYERS_RETRY: '1' } },
  );
  process.exit(result.status ?? 1);
} else {
  await main().catch((error) => {
    if (error instanceof NotChecked) {
      console.log(`НЕ ПРОВЕРЕНО: ${error.message}`);
      process.exit(2);
    }
    console.error(error);
    process.exit(1);
  });
}
