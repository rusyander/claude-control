/**
 * Живое доказательство 1.2: что лёгкий профиль запуска группы разделения
 * действительно уносит из запроса, ушедшего наверх, и что оставляет.
 *
 * Юнит-тесты профиля проверяют список, который панель ПОПРОСИЛА; вопрос же в
 * том, какие MCP-инструменты увидит модель. Ответ виден только в теле запроса,
 * поэтому подменена одна модель: одноразовый каталог конфигурации с сервером-
 * меткой на каждую роль, стаб вместо API Anthropic, настоящий `claude`,
 * запущенный настоящим реестром прогонов панели, профиль — настоящий
 * `groupRunProfile` над настоящим источником MCP (`createLocalMcpSource`), как
 * их связывает `bootstrap/runtime/runtime.ts`.
 *
 * Случаи: без профиля (все серверы на месте — проба видит то, что меряет),
 * группа без макета, группа со ссылкой на макет, группа, попросившая снятый
 * сервер блоком `mcp`.
 *
 * Подключения claude.ai здесь не проверяются: в одноразовом каталоге нет входа
 * в claude.ai, и их нет ни в одном случае. Снятие их переменной
 * `ENABLE_CLAUDEAI_MCP_SERVERS` доказывает тест реестра и замер `pnpm tokens`
 * на прогоне группы.
 *
 * Запуск: `node tools/qa/check-group-profile.mjs`. Нужен установленный `claude`
 * (путь — `CLAUDE_CLI`); стенд человека не трогается.
 */
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

const MCP_SERVER = fileURLToPath(new URL('./mcp-marker.mjs', import.meta.url));
const PREFIX = 'cc-groupprofile-';

/** Серверы владельца по ролям; у каждого свой инструмент `mcp__<имя>__marker`. */
const USER_SERVERS = {
  'telegram-inbox': [],
  'atlassian-full': ['mcp-atlassian'],
  // Переходник панели к трекеру узнаётся по пути `tools/mcp/` в аргументах.
  'agentdeck-atlassian': ['tools/mcp/atlassian.mjs'],
  'figma-desktop': ['figma'],
  'gitlab-forge': ['gitlab'],
  'sentry-unknown': [],
};
const PROJECT_SERVERS = { 'jira-project': ['jira'] };
const tool = (id) => `mcp__${id}__marker`;
const MARK = { keepSkill: 'GPKEEPDESC', idleSkill: 'GPIDLEDESC', pluginSkill: 'GPPLUGINDESC' };
const PLUGIN = 'gp-figma@gp-market';

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок   ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (error) {
    console.warn(`временная папка не удалена (${error.code ?? error.message}): ${dir}`);
  }
}

/** Папки прошлых прогонов старше часа, которые Windows тогда не отпустил. */
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith(PREFIX)) continue;
  const dir = join(tmpdir(), name);
  try {
    if (statSync(dir).mtimeMs < Date.now() - 3_600_000)
      rmSync(dir, { recursive: true, force: true });
  } catch {
    // Занята — уберёт следующий запуск.
  }
}

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

/** Стаб вместо API: записывает каждый запрос к `/messages` и отвечает одним словом. */
function startStub() {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!req.url?.includes('/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.url?.includes('count_tokens') ? '{"input_tokens":10}' : '{}');
        return;
      }
      try {
        seen.push(JSON.parse(raw));
      } catch {
        seen.push({});
      }
      const events = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'msg_gp',
              type: 'message',
              role: 'assistant',
              model: 'stub',
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

const serversOf = (map) =>
  Object.fromEntries(
    Object.entries(map).map(([id, extra]) => [
      id,
      { command: process.execPath, args: [MCP_SERVER, ...extra] },
    ]),
  );

/** Одноразовые каталоги: конфигурация с личными серверами и проект со своим `.mcp.json`. */
function buildDirs() {
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), `${PREFIX}work-`)));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `${PREFIX}home-`)));
  const appData = realpathSync.native(mkdtempSync(join(tmpdir(), `${PREFIX}data-`)));
  writeFileSync(
    join(work, '.mcp.json'),
    JSON.stringify({ mcpServers: serversOf(PROJECT_SERVERS) }),
  );
  mkdirSync(join(work, '.claude'), { recursive: true });
  writeFileSync(
    join(work, '.claude', 'settings.json'),
    JSON.stringify({ enableAllProjectMcpServers: true }),
  );
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: serversOf(USER_SERVERS),
      projects: { [work]: { hasTrustDialogAccepted: true, allowedTools: [] } },
    }),
  );
  // Навыки (1.3): обязательный с меткой описания и навык не по делу с другой меткой.
  for (const [name, mark] of [
    ['deep-review', MARK.keepSkill],
    ['gp-idle-skill', MARK.idleSkill],
  ]) {
    mkdirSync(join(home, 'skills', name), { recursive: true });
    writeFileSync(
      join(home, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${mark} навык для пробы профиля\n---\n\nНичего не делает.\n`,
    );
  }
  // Плагин макетов, установленный так, как его ставит `/plugin`: запись установки и
  // включение в настройках. Плагин несёт один навык с меткой описания.
  // Каталог плагинов — как у `/plugin marketplace add <папка>`: манифест каталога в
  // `.claude-plugin/marketplace.json`, плагин — его подпапка.
  const market = join(home, 'gp-market');
  const plugin = join(market, 'gp-figma');
  mkdirSync(join(market, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(market, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'gp-market',
      owner: { name: 'probe' },
      plugins: [{ name: 'gp-figma', source: './gp-figma', description: 'проба профиля' }],
    }),
  );
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'gp-figma', version: '1.0.0', description: 'проба профиля' }),
  );
  mkdirSync(join(plugin, 'skills', 'gp-figma-use'), { recursive: true });
  writeFileSync(
    join(plugin, 'skills', 'gp-figma-use', 'SKILL.md'),
    `---\nname: gp-figma-use\ndescription: ${MARK.pluginSkill} навык плагина\n---\n\nНичего.\n`,
  );
  mkdirSync(join(home, 'plugins'), { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(
    join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        [PLUGIN]: [
          {
            scope: 'user',
            installPath: plugin,
            version: '1.0.0',
            installedAt: at,
            lastUpdated: at,
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(home, 'plugins', 'known_marketplaces.json'),
    JSON.stringify({
      'gp-market': {
        source: { source: 'directory', path: market },
        installLocation: market,
        lastUpdated: at,
      },
    }),
  );
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ enabledPlugins: { [PLUGIN]: true } }),
  );
  return { work, home, appData };
}

/** Имена MCP-инструментов, которые увидела модель: в списке инструментов или отложенными в тексте. */
function seenTools(body) {
  const all = [...Object.keys(USER_SERVERS), ...Object.keys(PROJECT_SERVERS)];
  const listed = new Set((body?.tools ?? []).map((item) => item.name));
  const text = JSON.stringify(body?.system ?? '') + JSON.stringify(body?.messages ?? []);
  return all.filter((id) => listed.has(tool(id)) || text.includes(tool(id)));
}

async function main() {
  const exe = resolveClaude();
  if (!exe) {
    console.log('ПРОПУСК не нашёлся настоящий `claude` — задайте путь через CLAUDE_CLI.');
    process.exit(2);
  }
  const { ChatRunRegistry } =
    await import('../../apps/server/src/domains/chat/ChatRunRegistry/ChatRunRegistry.ts');
  const { groupRunProfile, statusRunProfile } =
    await import('../../apps/server/src/domains/chat/group-profile/group-profile.ts');
  const { createLocalMcpSource } =
    await import('../../apps/server/src/domains/local-models/mcp-source.ts');
  const { AppStore } = await import('../../apps/server/src/lib/app-store/app-store.ts');
  const { readSkills } = await import('../../apps/server/src/domains/skills/read.ts');
  const { initiativePrompt } =
    await import('../../apps/server/src/domains/chat/initiative/initiative.ts');
  const { e2eChatLine } = await import('../../apps/server/src/domains/project-tests/e2e-chat.ts');

  const stub = await startStub();
  console.log(`CLI: ${exe}\nСтаб: ${stub.url}\n`);
  const dirs = [];

  /**
   * Один прогон настоящего CLI; `group` — что конвейер знает о группе, нет — не
   * группа; `status` — лёгкий чат вопроса о ходе групп (5.1): не ребёнок, свой профиль.
   */
  const runCase = async (label, group, status = false) => {
    const { work, home, appData } = buildDirs();
    dirs.push(work, home, appData);
    const store = new AppStore(appData);
    const source = createLocalMcpSource({
      userConfig: () => join(home, '.claude.json'),
      store,
      appData: () => appData,
      envLookup: () => process.env,
      networkTimeoutMs: () => 10_000,
    });
    const runs = new ChatRunRegistry();
    runs.setPlatformRouting(() => ({
      env: {
        ANTHROPIC_BASE_URL: stub.url,
        ANTHROPIC_AUTH_TOKEN: 'gp-stub-token',
        ANTHROPIC_API_KEY: 'gp-stub-token',
        ANTHROPIC_MODEL: 'stub-gp',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    }));
    // Та же связка, что в runtime.ts: резолвер ключей → вход профиля → серверы проекта.
    // Навыки — тем же `readSkills`, что в runtime.ts; групп панели у пробы нет.
    const skills = {
      user: readSkills(join(home, 'skills'), store)
        .filter((skill) => skill.isEnabled)
        .map((skill) => skill.name),
      group: [],
      plugins: [PLUGIN],
    };
    runs.setGroupProfileResolver((_keys, cwd) => {
      if (status) return statusRunProfile(skills);
      return group ? groupRunProfile({ entries: source.list(cwd), ...group, skills }) : undefined;
    });
    // Дописка панели (1.4): та же склейка, что даёт старт группы, и строка о
    // тестах; ребёнок ли прогон, реестр спрашивает тем же резолвером, что в runtime.ts.
    runs.setChildResolver(() => Boolean(group));
    runs.setWorkspaceNote((cwd, run) =>
      e2eChatLine({
        root: cwd,
        folder: { state: 'missing', framework: 'unknown', specs: 0, excluded: false, git: false },
        cliPath: '/panel/tools/tests-cli.mjs',
        hasStandUrl: false,
        automation: { command: 'npm test' },
        group: run.group,
      }),
    );
    const from = stub.seen.length;
    runs.start(
      `gp-${label}`,
      {
        prompt: 'скажи ок',
        cwd: work,
        configDir: home,
        ...(process.env.CLAUDE_CLI ? { command: process.env.CLAUDE_CLI } : {}),
        permissionMode: 'bypassPermissions',
        appendSystemPrompt: initiativePrompt(
          { taskSplitInitiative: true, handoffInitiative: true },
          { splitMuted: true },
        ),
      },
      { origin: 'chat' },
    );
    for (let i = 0; i < 4 * 120 && stub.seen.length === from; i += 1) await wait(250);
    runs.stopAll?.();
    await wait(300);
    const body = stub.seen[from];
    if (!body) {
      check(false, `${label}: запрос наверх не пришёл за 120 с`);
      return { tools: [], toolChars: 0, text: '' };
    }
    return {
      tools: seenTools(body),
      // Список инструментов, без строки профиля: метки крошечные, и строка весит
      // больше, чем три снятых инструмента, — у настоящих серверов наоборот.
      toolChars: JSON.stringify(body.tools ?? []).length,
      text: JSON.stringify(body.system ?? '') + JSON.stringify(body.messages ?? []),
      systemChars: JSON.stringify(body.system ?? '').length,
      totalChars: JSON.stringify(body).length,
      toolNames: (body.tools ?? []).map((item) => item.name),
    };
  };

  try {
    const plain = await runCase('plain');
    const everything = [...Object.keys(USER_SERVERS), ...Object.keys(PROJECT_SERVERS)];
    check(
      everything.every((id) => plain.tools.includes(id)),
      `без профиля модель видит все ${everything.length} сервера (проба меряет то, что надо): ${plain.tools.join(', ')}`,
    );

    const lean = await runCase('lean', { tasksText: 'PROJ-2 ручка экспорта в CSV', extra: [] });
    const keep = ['atlassian-full', 'gitlab-forge', 'sentry-unknown', 'jira-project'];
    const drop = ['telegram-inbox', 'agentdeck-atlassian', 'figma-desktop'];
    check(
      keep.every((id) => lean.tools.includes(id)),
      `группа без макета: трекер, код, незнакомый и проектный на месте — ${lean.tools.join(', ')}`,
    );
    check(
      drop.every((id) => !lean.tools.includes(id)),
      `группа без макета: мессенджер, дубль трекера и макеты сняты (${drop.join(', ')})`,
    );
    check(
      lean.text.includes('MCP servers in this run:'),
      'строка профиля доехала до системного промпта',
    );
    check(
      lean.toolChars < plain.toolChars,
      `список инструментов короче: ${plain.toolChars} → ${lean.toolChars} знаков`,
    );

    // Навыки (1.3): проба сперва доказывает, что без профиля метки видны.
    const listed = (run, mark) => run.text.includes(mark);
    check(
      listed(plain, MARK.keepSkill) && listed(plain, MARK.idleSkill),
      'без профиля описания обоих личных навыков в запросе (проба видит перечень)',
    );
    check(listed(lean, MARK.keepSkill), 'обязательный навык группы остался с описанием');
    check(
      !listed(lean, MARK.idleSkill) && listed(lean, 'gp-idle-skill'),
      'навык не по делу — только имя: описания нет, имя есть',
    );
    check(
      /- dataviz:/.test(plain.text) && !/- dataviz:/.test(lean.text),
      'встроенный навык не по делу (dataviz) — без описания',
    );
    check(listed(plain, MARK.pluginSkill), 'без профиля навык плагина-заглушки в запросе');
    check(!listed(lean, MARK.pluginSkill), 'плагин макетов без макета в задачах выключен');

    // Дописка панели (1.4): чат получает свою редакцию, группа — свою, короче.
    check(
      plain.text.includes('cards with buttons') && plain.text.includes('Ask the user once'),
      'не группа: дописка чата и вопрос о тестах на месте (проба видит дописку)',
    );
    check(
      lean.text.includes('as a split group') &&
        lean.text.includes('agentdeck:handoff') &&
        lean.text.includes('ONLY in the foreground'),
      'группа: дописка группы с правилом этапов и проверками на переднем плане',
    );
    check(
      !lean.text.includes('cards with buttons') &&
        !lean.text.includes('Ask the user once') &&
        !lean.text.includes('shows the human a card instead of this block'),
      'группа: без карточек человеку и вопроса на старте',
    );
    console.log(
      `      системный промпт: не группа ${plain.systemChars}, группа ${lean.systemChars} знаков`,
    );

    const design = await runCase('design', {
      tasksText: 'https://www.figma.com/design/abc',
      extra: [],
    });
    check(
      design.tools.includes('figma-desktop'),
      'группа со ссылкой на макет получила сервер макетов',
    );
    check(listed(design, MARK.pluginSkill), 'с макетом плагин макетов на месте');
    const deliver = await runCase('design-deliver', {
      tasksText: 'https://www.figma.com/design/abc',
      extra: [],
      stage: 'deliver',
    });
    check(!listed(deliver, MARK.pluginSkill), 'с макетом в доставке плагин макетов выключен');

    const asked = await runCase('asked', { tasksText: 'PROJ-2', extra: ['telegram-inbox'] });
    check(
      asked.tools.includes('telegram-inbox'),
      'попрошенный блоком `mcp` сервер едет следующим ходом',
    );

    // Лёгкий чат вопроса о ходе групп (5.1): ни одного сервера, ни описаний
    // навыков, ни инструментов правки — первый вызов меньше обычного чата.
    const status = await runCase('status', undefined, true);
    check(
      status.tools.length === 0,
      `лёгкий чат: MCP-серверов нет — ${status.tools.join(', ') || 'ни одного'}`,
    );
    check(
      ['Edit', 'Write', 'NotebookEdit', 'Bash'].every((name) => plain.toolNames.includes(name)),
      'без профиля инструменты правки в запросе (проба видит то, что меряет)',
    );
    check(
      !['Edit', 'Write', 'NotebookEdit', 'Bash'].some((name) => status.toolNames.includes(name)),
      `лёгкий чат: инструментов правки и оболочки нет — ${status.toolNames.join(', ')}`,
    );
    check(
      !listed(status, MARK.keepSkill) &&
        !listed(status, MARK.idleSkill) &&
        listed(status, 'gp-idle-skill'),
      'лёгкий чат: навыки только именами',
    );
    check(!listed(status, MARK.pluginSkill), 'лёгкий чат: плагины выключены');
    check(
      status.text.includes('no MCP servers, no edit tools and no shell'),
      'строка профиля лёгкого чата доехала до системного промпта',
    );
    check(
      status.totalChars < plain.totalChars,
      `первый вызов: обычный чат ${plain.totalChars}, лёгкий ${status.totalChars} знаков (≈${Math.round(plain.totalChars / 4)} → ≈${Math.round(status.totalChars / 4)} токенов)`,
    );
    console.log(
      `      инструменты: обычный чат ${plain.toolChars}, лёгкий ${status.toolChars} знаков; системный промпт ${plain.systemChars} → ${status.systemChars}`,
    );
  } finally {
    stub.close();
    await wait(500);
    for (const dir of dirs) removeDir(dir);
  }
  console.log(bad ? `\nПЛОХО: ${bad}` : '\nВсё ок');
  process.exit(bad ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
