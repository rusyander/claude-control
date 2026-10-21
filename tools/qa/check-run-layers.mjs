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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  // Набор панели (В2): заголовок его правил — первая строка `rules/standard.md`,
  // взятая из самого файла, чтобы правка правил не сделала метку чужой. Доезжает
  // выводом его хука SessionStart, то есть доказывает и подключение плагина, и
  // исполнение его хука.
  kitRule: readFileSync(
    fileURLToPath(
      new URL('../../apps/server/assets/kit/agentdeck-kit/rules/standard.md', import.meta.url),
    ),
    'utf8',
  )
    .split(/\r?\n/)[0]
    .replace(/^#\s*/, '')
    .trim(),
  kitSkill: 'read-before-edit',
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

/**
 * Убрать временную папку прогона. На Windows вышедший CLI (и его дети) держат
 * рабочую папку ещё секунды после остановки — EPERM здесь не про проверяемое
 * поведение, поэтому ждём до десяти секунд, а не отпустившую папку оставляем
 * в %TEMP% с предупреждением вместо падения всего прогона.
 */
function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (error) {
    console.warn(`временная папка не удалена (${error.code ?? error.message}): ${dir}`);
  }
}
/**
 * Папки прошлых прогонов, которые Windows тогда не отпустил: к следующему
 * запуску их уже никто не держит. Только свои (`cc-layers-`) и старше часа —
 * параллельный прогон этой же проверки свои свежие папки сохранит.
 */
function sweepStale() {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('cc-layers-')) continue;
    const dir = join(tmpdir(), name);
    try {
      if (statSync(dir).mtimeMs < hourAgo) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Всё ещё занята — уберёт следующий запуск.
    }
  }
}
sweepStale();

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
    kitRule: text.includes(MARK.kitRule),
    kitSkill: text.includes(MARK.kitSkill),
    text,
    tools,
    // Размер запроса по слоям — для облегчённого набора локальной модели (L1b).
    chars: JSON.stringify(body).length,
    toolChars: JSON.stringify(body.tools ?? []).length,
  };
}

/**
 * Группа, собранная нынешними строителями панели (B.6) в том порядке, что и
 * старт копии с доставкой в `ChatSplit`: преамбула окружения, доставка, задание
 * группы, блок тикета. Дописка — та же, что у чата; ребёнка из неё делает реестр.
 */
async function syntheticGroupInput(pad) {
  const split = await import('../../packages/contracts/src/task-split.ts');
  const { initiativePrompt } =
    await import('../../apps/server/src/domains/chat/initiative/initiative.ts');
  const { e2eChatLine } = await import('../../apps/server/src/domains/project-tests/e2e-chat.ts');
  const group = {
    title: 'Форма входа',
    branch: 'feat/proj-1-login',
    tasks: [
      'PROJ-1 Форма входа: ошибка под полем пароля вместо всплывающего окна',
      'PROJ-2 Вход: кнопка «Войти» недоступна, пока поля пусты',
    ],
    owns: ['apps/web'],
  };
  const task = [
    split.environmentPreamble({
      bootstrap: {
        command: 'pnpm install --frozen-lockfile',
        status: 'ok',
        startedAt: '2026-10-22T00:00:00.000Z',
        logTail: '',
      },
      scope: group.owns,
      root: '/copy',
    }),
    split.deliveryPreamble({
      branch: group.branch,
      questions: 'plan',
      reviewPack: 'node "/panel/tools/review-pack.mjs"',
    }),
    split.buildGroupPrompt(group, 'Общее: макет экрана входа в задаче PROJ-1.'),
    split.splitTicketPreamble(),
  ].join('\n\n');
  return {
    prompt: pad > 0 ? `${task}\n\n${'x'.repeat(pad)}` : task,
    append: initiativePrompt(
      { taskSplitInitiative: true, handoffInitiative: true },
      { splitMuted: true },
    ),
    child: true,
    note: (cwd, run) =>
      e2eChatLine({
        root: cwd,
        folder: { state: 'missing', framework: 'unknown', specs: 0, excluded: false, git: false },
        cliPath: '/panel/tools/tests-cli.mjs',
        hasStandUrl: false,
        automation: { command: 'npm test' },
        group: run.group,
        // Группа Claude — строкой без путей, как в панели (X1).
        projectFromEnv: run.group,
      }),
  };
}

/**
 * Инварианты первого запроса синтетической группы — в обе стороны: нужное
 * доехало (дописка ребёнка, строка «Тесты», задание, описание навыка звена),
 * снятое не доехало (инструменты, закрытые ребёнку и всем прогонам, дописка
 * обычного чата). Без них бюджет зеленел бы и у запроса, потерявшего главное.
 */
async function checkGroupInvariants(stage, body, stageDesc) {
  const { CHILD_DENIED_TOOLS, UNUSED_HEAVY_TOOLS } =
    await import('../../apps/server/src/domains/chat/initiative/initiative.ts');
  const text = JSON.stringify(body.system ?? '') + JSON.stringify(body.messages ?? []);
  const tools = (body.tools ?? []).map((tool) => tool.name);
  const present = {
    'дописка ребёнка разделения': 'as a split group',
    'строка блока «Тесты» группы': 'QA workspace of this project',
    'задание группы': 'Форма входа',
    'описание навыка звена skill-map': `${stageDesc}-skill-map`,
  };
  for (const [what, needle] of Object.entries(present)) {
    check(text.includes(needle), `инвариант «${stage}»: ${what} в запросе`);
  }
  for (const needle of ['cards with buttons', 'Ask the user once']) {
    check(!text.includes(needle), `инвариант «${stage}»: дописки обычного чата нет («${needle}»)`);
  }
  const leaked = [...CHILD_DENIED_TOOLS, ...UNUSED_HEAVY_TOOLS].filter((name) =>
    tools.includes(name),
  );
  check(
    leaked.length === 0,
    `инвариант «${stage}»: закрытых инструментов в перечне нет${leaked.length ? ` — ${leaked.join(', ')}` : ''}`,
  );
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new NotChecked('не нашёлся настоящий `claude` — задайте путь через CLAUDE_CLI.');

  // Импорт ВНУТРИ функции: наверху он случился бы до перезапуска со снятием
  // типов, и на Node 22.6 сорвался бы на первом же `.ts`.
  const { ChatRunRegistry } =
    await import('../../apps/server/src/domains/chat/ChatRunRegistry/ChatRunRegistry.ts');
  const { runLayers } = await import('../../apps/server/src/domains/platform/layers/layers.ts');
  const { startPanelAgentRun } =
    await import('../../apps/server/src/domains/panel-agent/runner/runner.ts');
  const { resolvePanelAgentLaunch } =
    await import('../../apps/server/src/domains/panel-agent/launch.ts');
  const { AppStore } = await import('../../apps/server/src/lib/app-store/app-store.ts');
  const { defaultOurRules, defaultPlatformRules } =
    await import('../../packages/contracts/src/platform.ts');
  const { KitService } = await import('../../apps/server/src/domains/kit/service.ts');

  // Набор панели (В2): данные панели — свой временный каталог, каталог Claude —
  // одноразовый каталог конфигурации прогона (он же решает конфликты гибрида).
  const kitData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-layers-kit-')));
  let kitClaudeDir = '';
  const kit = new KitService({
    appDataDir: kitData,
    claudeDir: () => kitClaudeDir,
    providers: () => [{ id: 'claude', name: 'Claude Code' }],
  });

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

    // Набор — тем же `KitService.runExtras`, что зовёт `runRoute` сборки панели,
    // и с тем же `hasSources`: флаги и окружение не переписаны здесь второй раз.
    let kitExtras;
    if (tree?.kit) {
      kitClaudeDir = home;
      kit.setMode('claude', tree.kit);
      kitExtras = kit.runExtras({
        provider: 'claude',
        local: false,
        hasSources: layers.args.includes('--setting-sources'),
      });
    }

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
      ...(kitExtras ? { kit: kitExtras } : {}),
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
    if (!tree?.work) removeDir(work);
    removeDir(home);
    return { facts, transcripts, args: layers.args, kitArgs: kitExtras?.args ?? [] };
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
    removeDir(work);
    removeDir(home);
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
    removeDir(root);
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

  /**
   * Звено группы (L1.2, L1.3): профиль считает НАСТОЯЩИЙ `groupRunProfile`, кладёт
   * в запуск настоящий реестр — тем же резолвером профиля, что ставит `runtime.ts`.
   * Сервер выдаёт себя хранилищем кода (`gitlab` в имени) и несёт имена чтения и
   * записи рядом; навыки группы — личными навыками с меткой в описании.
   */
  const STAGE_DESC = 'T8STAGEDESC';
  const STAGE_TOOLS = {
    read: ['get_issue', 'list_merge_requests', 'jira_get_link_types'],
    write: [
      'create_issue',
      'jira_create_issue',
      'update_merge_request',
      'merge_merge_request',
      'create_merge_request',
      'create_merge_request_note',
      'jira_transition_issue',
      'execute_graphql',
    ],
  };
  /** `input` — первое сообщение и дописка настоящей группы (`--group-base --input`). */
  const runStage = async (stage, ahead, input = {}) => {
    const { groupRunProfile, GROUP_SKILLS } =
      await import('../../apps/server/src/domains/chat/group-profile/group-profile.ts');
    const work = buildProjectDir();
    input.prepare?.(work);
    const home = buildConfigDir(work);
    for (const name of GROUP_SKILLS) {
      mkdirSync(join(home, 'skills', name), { recursive: true });
      writeFileSync(
        join(home, 'skills', name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${STAGE_DESC}-${name}\n---\n\nНичего не делает.\n`,
        'utf8',
      );
    }
    const profile = groupRunProfile({
      entries: [
        {
          id: 't8-gitlab',
          config: {
            command: process.execPath,
            args: [MCP_SERVER, '--tools', [...STAGE_TOOLS.read, ...STAGE_TOOLS.write].join(',')],
          },
        },
      ],
      tasksText: 'PROJ-1',
      extra: [],
      skills: { user: [...GROUP_SKILLS], group: [], plugins: [] },
      stage,
      ...(ahead ? { ahead } : {}),
    });
    const runs = new ChatRunRegistry();
    runs.setPlatformRouting(() => ({ env: { ...stubEnv, ...input.env } }));
    // `dropArgs` — красный контроль общего префикса (X1): тот же профиль без флага.
    runs.setGroupProfileResolver(() =>
      input.args || input.dropArgs
        ? {
            ...profile,
            args: [...(profile.args ?? []), ...(input.args ?? [])].filter(
              (arg) => !input.dropArgs?.includes(arg),
            ),
          }
        : profile,
    );
    if (input.denied) runs.setDeniedToolsResolver(() => input.denied);
    // Синтетическая группа (B.6): ребёнок разделения и строка блока «Тесты» —
    // склеивает их сам реестр, как на старте настоящей группы.
    if (input.child) runs.setChildResolver(() => true);
    if (input.note) runs.setWorkspaceNote(input.note);
    // Проводка панели целиком (`wireTestsChatNote`), а не готовая строка (X1).
    input.wire?.(runs);
    const from = stub.seen.length;
    runs.start(
      `layers-stage-${stage}`,
      {
        prompt: input.prompt ?? 'скажи ок',
        ...(input.append ? { appendSystemPrompt: input.append } : {}),
        cwd: work,
        configDir: home,
        ...(process.env.CLAUDE_CLI ? { command: process.env.CLAUDE_CLI } : {}),
        permissionMode: 'default',
        permissionPrompt: { runId: `layers-stage-${stage}`, baseUrl: 'http://127.0.0.1:1' },
      },
      { origin: 'chat' },
    );
    for (let i = 0; i < 4 * 120 && stub.seen.length === from; i += 1) await wait(250);
    runs.stopAll?.();
    await wait(300);
    const body = stub.seen[from];
    removeDir(work);
    removeDir(home);
    if (!body) return undefined;
    const all = JSON.stringify(body);
    // Имя целиком: `create_merge_request` — начало `create_merge_request_note`.
    const tool = (name) => new RegExp(`mcp__t8-gitlab__${name}(?![A-Za-z0-9_])`).test(all);
    return {
      body,
      chars: all.length,
      read: STAGE_TOOLS.read.filter(tool),
      write: STAGE_TOOLS.write.filter(tool),
      described: GROUP_SKILLS.filter((name) => all.includes(`${STAGE_DESC}-${name}`)),
      named: GROUP_SKILLS.filter((name) => all.includes(name)),
      // Инструмент подагентов в перечне запроса (F-09: перед ревью он под запретом).
      agent: (body.tools ?? []).some((entry) => entry?.name === 'Agent'),
    };
  };

  // `--group-base` — замер первого запроса каждого звена по блокам (B.1), без
  // проверок слоёв. `--input <run-input.json>` — первое сообщение и дописка
  // настоящей группы из записи панели (`agentdeck/run-inputs/<сессия>.json`,
  // запись 0), иначе «скажи ок» без дописки; `--out <каталог>` — куда писать.
  //
  // `--synthetic` — вместо записи панели группа, собранная нынешними строителями
  // задания и дописки (B.6): запись заморожена на дне своего прогона и роста
  // текстов панели не видит. `--pin <файл>` записывает числа замера как пин;
  // `--budget <файл>` сверяет с пином: блок вырос больше BUDGET_SLACK — красное,
  // плюс инварианты в обе стороны (нужное в запросе есть, снятое — нет).
  // `--pad <n>` дописывает n знаков в задание — мутант для проверки самой сверки.
  if (process.argv.includes('--group-base')) {
    const { blocksOf, budgetOf, overBudget, writeGroupBase, BUDGET_SLACK } =
      await import('./group-base-blocks.mjs');
    const arg = (name) => {
      const at = process.argv.indexOf(name);
      return at > 0 ? process.argv[at + 1] : undefined;
    };
    const inputFile = arg('--input');
    const record = inputFile ? JSON.parse(readFileSync(inputFile, 'utf8'))['0'] : undefined;
    const synthetic = process.argv.includes('--synthetic')
      ? await syntheticGroupInput(Number(arg('--pad') ?? 0))
      : undefined;
    const pinFile = arg('--pin');
    const budgetFile = arg('--budget');
    const pinned = budgetFile ? JSON.parse(readFileSync(budgetFile, 'utf8')) : undefined;
    const cli = spawnSync(exe, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    }).stdout?.trim();
    const pin = { cli, slack: BUDGET_SLACK, stages: {} };
    // Стаб — не адрес Anthropic, и CLI без подсказки шлёт каждый свой инструмент
    // со схемой целиком; настоящая группа идёт к Anthropic с поиском инструментов,
    // где редкие из них — одной строкой имени. Замер базы — как у неё.
    const env = {
      ENABLE_TOOL_SEARCH: 'true',
      ...(record?.model ? { ANTHROPIC_MODEL: record.model } : {}),
    };
    // Тяжёлые неиспользуемые схемы снимает runtime каждому прогону (`chatLeanTools`,
    // по умолчанию включено) — тем же списком.
    const { UNUSED_HEAVY_TOOLS } =
      await import('../../apps/server/src/domains/chat/initiative/initiative.ts');
    const base = { env, denied: UNUSED_HEAVY_TOOLS };
    const input = synthetic
      ? { ...base, ...synthetic }
      : record
        ? { ...base, prompt: record.prompt, append: record.appendSystemPrompt }
        : base;
    const out =
      arg('--out') ?? join(fileURLToPath(new URL('../../', import.meta.url)), '.agent', 'tmp');
    for (const stage of ['work', 'review', 'fix', 'deliver']) {
      const measured = await runStage(stage, undefined, input);
      check(Boolean(measured), `замер звена «${stage}»: запрос записан`);
      if (!measured) continue;
      const file = writeGroupBase(out, stage, measured.body, { input: inputFile ?? null });
      const blocks = blocksOf(measured.body);
      console.log(
        `     ${stage}: всего ${blocks.total}, системный ${blocks.system.chars}, инструменты ${blocks.tools.chars} ` +
          `(свои ${blocks.tools.builtin.count}/${blocks.tools.builtin.chars}, MCP ${blocks.tools.mcp.count}/${blocks.tools.mcp.chars}), ` +
          `сообщения ${blocks.messages.chars} → ${file}`,
      );
      pin.stages[stage] = budgetOf(blocks);
      if (synthetic) await checkGroupInvariants(stage, measured.body, STAGE_DESC);
      if (pinned) {
        const was = pinned.stages?.[stage];
        check(Boolean(was), `бюджет «${stage}»: звено есть в пине`);
        const grown = was ? overBudget(was, pin.stages[stage], pinned.slack ?? BUDGET_SLACK) : [];
        check(
          was !== undefined && grown.length === 0,
          `бюджет «${stage}»: ни один блок не вырос больше ${pinned.slack ?? BUDGET_SLACK} знаков` +
            (grown.length > 0
              ? ` — ${grown.map((item) => `${item.block} ${item.pinned ?? '—'} → ${item.now}`).join(', ')}` +
                ` (пин снят на CLI ${pinned.cli ?? '?'}, сейчас ${cli ?? '?'})`
              : ''),
        );
      }
    }
    if (pinFile) {
      writeFileSync(pinFile, `${JSON.stringify(pin, null, 2)}\n`, 'utf8');
      console.log(`     пин бюджета записан → ${pinFile}`);
    }
    stub.close();
    removeDir(kitData);
    finish();
  }

  // `--shared-prefix` (X1) — две копии одной группы подряд, проводка панели
  // целиком (`wireTestsChatNote` на настоящем реестре, профиль группы с флагом
  // выноса личных секций): системный промпт обязан совпасть байт в байт — кэш
  // между копиями ловится только на границе блока с меткой кэша. Два красных
  // контроля доказывают, что сравнение видит разницу: строка о тестах с путём
  // копии (проводка до X1) и профиль без флага (память копии в системном).
  if (process.argv.includes('--shared-prefix')) {
    const { UNUSED_HEAVY_TOOLS } =
      await import('../../apps/server/src/domains/chat/initiative/initiative.ts');
    const { wireTestsChatNote, testsChatNote } =
      await import('../../apps/server/src/bootstrap/tests-chat-wiring/tests-chat-wiring.ts');
    const { TESTS_PROJECT_ENV } =
      await import('../../packages/contracts/src/chat-group-settings.ts');
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-layers-appdata-')));
    const deps = { appData, chatRuns: undefined };
    // Строку о тестах ставит проводка панели, а не готовая строка синтетики.
    const synthetic = { ...(await syntheticGroupInput(0)), note: undefined };
    const base = {
      env: { ENABLE_TOOL_SEARCH: 'true' },
      denied: UNUSED_HEAVY_TOOLS,
      ...synthetic,
      // Своя команда проекта, как у этого репозитория: строка о тестах — её редакции.
      prepare: (work) => {
        mkdirSync(join(work, '.agent', 'tests'), { recursive: true });
        writeFileSync(
          join(work, '.agent', 'tests', 'automation.json'),
          JSON.stringify({ command: 'npm test' }),
          'utf8',
        );
      },
      wire: (runs) => wireTestsChatNote({ ...deps, chatRuns: runs }),
    };
    const variants = [
      { name: 'как в панели', input: base, same: true },
      {
        name: 'контроль: строка с путём копии',
        input: {
          ...base,
          wire: (runs) => {
            wireTestsChatNote({ ...deps, chatRuns: runs });
            runs.setWorkspaceNote((cwd, run) => testsChatNote(deps, cwd, run?.group));
          },
        },
        same: false,
      },
      {
        name: 'контроль: без флага',
        input: { ...base, dropArgs: ['--exclude-dynamic-system-prompt-sections'] },
        same: false,
      },
    ];
    const blocksOfSystem = (body) =>
      (Array.isArray(body.system) ? body.system : [{ text: String(body.system ?? '') }]).map(
        (block) => ({ text: block.text ?? '', mark: block.cache_control ?? null }),
      );
    const firstDiff = (left, right) => {
      let at = 0;
      while (at < left.length && at < right.length && left[at] === right[at]) at += 1;
      return at;
    };
    const dump = process.argv.includes('--dump')
      ? process.argv[process.argv.indexOf('--dump') + 1]
      : undefined;
    for (const [index, variant] of variants.entries()) {
      const one = await runStage('work', undefined, variant.input);
      const two = await runStage('work', undefined, variant.input);
      check(Boolean(one && two), `общий префикс, ${variant.name}: оба запроса записаны`);
      if (!one || !two) continue;
      if (dump) {
        mkdirSync(dump, { recursive: true });
        writeFileSync(join(dump, `x1-${index}-1.json`), JSON.stringify(one.body, null, 1));
        writeFileSync(join(dump, `x1-${index}-2.json`), JSON.stringify(two.body, null, 1));
      }
      const left = blocksOfSystem(one.body);
      const right = blocksOfSystem(two.body);
      const differ = left
        .map((block, at) => ({ at, block, other: right[at] }))
        .filter(
          ({ block, other }) =>
            block.text !== other?.text ||
            JSON.stringify(block.mark) !== JSON.stringify(other?.mark),
        );
      const where = differ
        .map(({ at, block, other }) => {
          const from = firstDiff(block.text, other?.text ?? '');
          const cut = (text) => text.slice(Math.max(0, from - 40), from + 60).replace(/\s+/g, ' ');
          return `[${at}] с ${from}: «${cut(block.text)}» ⇄ «${cut(other?.text ?? '')}»`;
        })
        .join('; ');
      const system = left.map((block) => block.text).join('\n');
      if (variant.same) {
        // Совпадение ничего не стоит, если строка о тестах не доехала вовсе.
        check(
          system.includes('QA workspace of this project') && system.includes(TESTS_PROJECT_ENV),
          `общий префикс, ${variant.name}: строка о тестах в системном, проект — через ${TESTS_PROJECT_ENV}`,
        );
        check(
          left.length === right.length && differ.length === 0,
          `общий префикс, ${variant.name}: системный промпт копий совпадает байт в байт ` +
            `(${left.length} блоков, ${left.map((block) => block.text.length).join('/')} знаков)` +
            (where ? ` — ${where}` : ''),
        );
        check(
          JSON.stringify(one.body.tools ?? []) === JSON.stringify(two.body.tools ?? []),
          `общий префикс, ${variant.name}: инструменты копий совпадают`,
        );
      } else {
        check(
          left.length !== right.length || differ.length > 0,
          `общий префикс, ${variant.name}: копии расходятся — сравнение видит разницу` +
            (where ? ` (${where})` : ''),
        );
      }
    }
    stub.close();
    removeDir(kitData);
    removeDir(appData);
    finish();
  }

  try {
    // ── 0. Звено группы: MCP наружу на чтение и свои навыки (L1.2, L1.3) ─────
    // Работа — контроль: весь набор записи и все описания доезжают, иначе пропажа
    // ниже значила бы, что проба их просто не видит.
    const stageWork = await runStage('work');
    const stageReview = await runStage('review');
    const stageDeliver = await runStage('deliver');
    // Работа, за которой ревью и доставка (L3): запрет навыков ревью и открытия MR.
    const stageAhead = await runStage('work', { review: true, deliver: true });
    check(
      Boolean(stageWork && stageReview && stageDeliver && stageAhead),
      'звено группы: запросы работы, ревью, доставки и работы перед ними записаны',
    );
    if (stageWork && stageAhead) {
      check(
        stageWork.described.includes('deep-review') &&
          !stageAhead.described.includes('deep-review') &&
          !stageAhead.described.includes('style-conformance-review'),
        `звено группы, работа перед ревью: навыков ревью нет в перечне: ${stageAhead.described.join(', ')}`,
      );
      check(
        stageWork.agent && !stageAhead.agent,
        `звено группы, работа перед ревью: инструмента Agent нет (работа без ревью: ${stageWork.agent}, перед ревью: ${stageAhead.agent})`,
      );
      check(
        stageWork.write.includes('create_merge_request') &&
          !stageAhead.write.includes('create_merge_request') &&
          stageAhead.write.includes('update_merge_request'),
        `звено группы, работа перед доставкой: открытия MR нет, прочая запись есть: ${stageAhead.write.join(', ')}`,
      );
    }
    if (stageWork && stageReview && stageDeliver) {
      const all = (list, of) => list.length === of.length;
      // Слияние MR закрыто в каждом звене (F-13): прочая запись — на месте.
      const open = STAGE_TOOLS.write.filter((name) => name !== 'merge_merge_request');
      check(
        ![stageWork, stageReview, stageDeliver, stageAhead].some((stage) =>
          stage?.write.includes('merge_merge_request'),
        ),
        'звено группы: слияния MR нет ни в одном звене (работа, ревью, доставка, работа перед ними)',
      );
      check(
        all(stageWork.read, STAGE_TOOLS.read) && all(stageWork.write, open),
        `звено группы, работа: все инструменты сервера в запросе: ${[...stageWork.read, ...stageWork.write].join(', ')}`,
      );
      check(
        stageWork.described.length === 12,
        `звено группы, работа: описания всех навыков группы: ${stageWork.described.length}`,
      );
      check(
        all(stageReview.read, STAGE_TOOLS.read),
        `звено группы, ревью: инструменты чтения на месте: ${stageReview.read.join(', ')}`,
      );
      check(
        stageReview.write.length === 0,
        `звено группы, ревью: инструментов записи нет: ${stageReview.write.join(', ') || '—'}`,
      );
      check(
        stageReview.described.includes('deep-review') &&
          !stageReview.described.includes('prepare-mr') &&
          stageReview.named.includes('prepare-mr'),
        `звено группы, ревью: описания только своих навыков, прочим — имя: ${stageReview.described.join(', ')}`,
      );
      check(
        all(stageDeliver.write, open),
        `звено группы, доставка: инструменты записи на месте: ${stageDeliver.write.join(', ')}`,
      );
      check(
        stageDeliver.described.includes('prepare-mr') &&
          !stageDeliver.described.includes('deep-review') &&
          stageDeliver.named.includes('deep-review'),
        `звено группы, доставка: описания только своих навыков, прочим — имя: ${stageDeliver.described.join(', ')}`,
      );
      console.log(
        `     тело запроса: работа ${stageWork.chars} знаков, ревью ${stageReview.chars}, доставка ${stageDeliver.chars}`,
      );
    }
    // `--group-stage` — только этот случай: доказательство профиля звена за минуту,
    // без полутора десятков прогонов остальных слоёв.
    if (process.argv.includes('--group-stage')) {
      stub.close();
      removeDir(kitData);
      finish();
    }

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

    // ── 10. Набор панели (В2): три режима страницы «Набор панели» ─────────────
    // Флаги даёт настоящий `KitService.runExtras` над временными данными панели,
    // плагин собран им же; что набор доехал — только по телу запроса. «Глобальные»
    // — контроль: без него «метка набора есть» могло бы значить, что CLI нашёл
    // её где-то ещё.
    check(
      Boolean(MARK.kitRule),
      `метка правил набора прочитана из rules/standard.md: «${MARK.kitRule}»`,
    );
    const kitGlobal = await runCase('kit-global', {}, { kit: 'global' });
    check(Boolean(kitGlobal.facts), 'набор «глобальные»: запрос записан');
    if (kitGlobal.facts) {
      check(
        kitGlobal.kitArgs.length === 0,
        `набор «глобальные»: флагов нет: ${JSON.stringify(kitGlobal.kitArgs)}`,
      );
      check(!kitGlobal.facts.kitRule, 'набор «глобальные»: правил набора в запросе нет');
      check(kitGlobal.facts.rules, 'набор «глобальные»: личный CLAUDE.md на месте');
    }
    const kitHybrid = await runCase('kit-hybrid', {}, { kit: 'hybrid' });
    check(Boolean(kitHybrid.facts), 'набор «оба»: запрос записан');
    if (kitHybrid.facts) {
      check(
        kitHybrid.kitArgs[0] === '--plugin-dir',
        `набор «оба»: флаг плагина: ${JSON.stringify(kitHybrid.kitArgs)}`,
      );
      check(
        kitHybrid.facts.kitRule,
        'набор «оба»: правила набора доехали (хук SessionStart плагина)',
      );
      check(kitHybrid.facts.kitSkill, 'набор «оба»: навык набора в перечне');
      check(kitHybrid.facts.rules, 'набор «оба»: личный CLAUDE.md тоже на месте');
      check(
        kitHybrid.facts.skill && kitHybrid.facts.hook,
        'набор «оба»: личные навык и хук на месте',
      );
    }
    const kitOurs = await runCase('kit-ours', {}, { kit: 'ours' });
    check(Boolean(kitOurs.facts), 'набор «только наш»: запрос записан');
    if (kitOurs.facts) {
      check(
        kitOurs.kitArgs.includes('--setting-sources'),
        `набор «только наш»: источник user снят: ${JSON.stringify(kitOurs.kitArgs)}`,
      );
      check(kitOurs.facts.kitRule, 'набор «только наш»: правила набора доехали');
      check(kitOurs.facts.kitSkill, 'набор «только наш»: навык набора в перечне');
      check(!kitOurs.facts.rules, 'набор «только наш»: личного CLAUDE.md в запросе нет');
      check(
        !kitOurs.facts.skill && !kitOurs.facts.hook,
        'набор «только наш»: ни личного навыка, ни личного хука',
      );
      check(kitOurs.facts.project, 'набор «только наш»: проектный CLAUDE.md остаётся');
    }
    // ── 11. Облегчённый набор локальной модели (L1b, только по выбору) ────────
    // Слои берутся у ТОГО ЖЕ `localLeanRules`, которым облегчается контур
    // локальной модели: копия списка здесь проверяла бы сама себя. Полный набор —
    // контроль: без него «Cron* нет в запросе» могло бы значить, что этой версии
    // CLI их не было вовсе. Мера — тело запроса: правила и скиллы человека обязаны
    // остаться (они «достижимы»), а запрос — стать заметно короче.
    const { localLeanRules } =
      await import('../../apps/server/src/domains/local-models/connect.ts');
    const lean = await runCase('lean', localLeanRules());
    check(Boolean(lean.facts), 'облегчённый набор: запрос записан');
    if (lean.facts && full.facts) {
      const has = (facts, name) => facts.tools.includes(name);
      for (const name of ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']) {
        check(has(lean.facts, name), `облегчённый набор: рабочий инструмент ${name} на месте`);
      }
      const extras = ['CronCreate', 'ScheduleWakeup', 'Workflow', 'SendMessage', 'EnterWorktree'];
      check(
        extras.some((name) => has(full.facts, name)),
        'контроль: в полном наборе расширенные инструменты (Cron*, Workflow…) есть',
      );
      check(
        extras.every((name) => !has(lean.facts, name)),
        'облегчённый набор: расширенных инструментов нет',
      );
      check(!lean.facts.mcp && !lean.facts.projectMcp, 'облегчённый набор: MCP-серверов нет');
      check(lean.facts.rules, 'облегчённый набор: личные правила на месте');
      check(lean.facts.hook, 'облегчённый набор: хук личных настроек на месте');
      check(lean.facts.skill, 'облегчённый набор: личные скиллы на месте (достижимы)');
      check(lean.facts.project, 'облегчённый набор: проектный CLAUDE.md на месте');
      check(
        lean.facts.toolChars < full.facts.toolChars / 2,
        `облегчённый набор: схемы инструментов ${lean.facts.toolChars} знаков вместо ${full.facts.toolChars}`,
      );
      console.log(
        `     тело запроса: полный набор ${full.facts.chars} знаков, облегчённый ${lean.facts.chars}`,
      );
    }
    // ── 12. Локальная модель ПО УМОЛЧАНИЮ — полный набор (L6, 15.10) ──────────
    // Слои — те, с которыми `localPlatformSettings` заводит контур, а не литерал:
    // вернись умолчание к облегчённому набору — MCP и расширенные инструменты
    // пропадут из запроса, и это увидит именно эта проверка.
    const { localPlatformSettings } =
      await import('../../apps/server/src/domains/local-models/connect.ts');
    const born = localPlatformSettings({
      baseUrl: 'http://127.0.0.1:1',
      model: 'm',
      title: 't',
      consumers: ['chat'],
    });
    const localDefault = await runCase('local-default', born.rules.ours);
    check(Boolean(localDefault.facts), 'локальная модель по умолчанию: запрос записан');
    if (localDefault.facts) {
      check(
        localDefault.args.length === 0,
        `локальная модель по умолчанию: флагов снятия нет: ${JSON.stringify(localDefault.args)}`,
      );
      check(localDefault.facts.mcp, 'локальная модель по умолчанию: личный MCP-сервер в запросе');
      check(localDefault.facts.skill, 'локальная модель по умолчанию: личный скилл в запросе');
      check(
        ['CronCreate', 'ScheduleWakeup', 'Workflow', 'SendMessage', 'EnterWorktree'].some((name) =>
          localDefault.facts.tools.includes(name),
        ),
        'локальная модель по умолчанию: расширенные инструменты на месте',
      );
    }
  } finally {
    stub.close();
    removeDir(kitData);
  }
  finish();
}

/** Итог прогона: строка и код выхода — общие для полного прогона и `--group-stage`. */
function finish() {
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
