/**
 * Живое доказательство локального слоя проекта (`domains/local-layer`): чат,
 * запущенный на слое, видит ровно то же, что видел бы на командном слое, — и
 * получает это от слоя, а не от командных файлов.
 *
 * Юнит-тесты слоя проверяют, что СОБРАНО; вопрос же в том, что делает с
 * собранным настоящий CLI: снимает ли `--setting-sources user,local` командный
 * слой целиком (иначе всё приехало бы дважды), читает ли он навыки плагина,
 * вкладывает ли вывод нашего хука правило по путям после Read, исполняет ли
 * перенесённую копию заменённого хука. Ответ виден только в теле запроса,
 * ушедшего наверх, и в журнале, который пишет сам хук.
 *
 * Не подменяется ничего, кроме модели: стаб отвечает по сценарию (Read одного
 * файла, Read второго, конец), прогон стартует настоящим реестром панели с
 * настоящим резолвером слоя. Каталог конфигурации — одноразовый, через
 * окружение маршрута: при `configDir` в параметрах прогона панель слой не
 * подключает (так запускается песочница), и проверка мерила бы не тот путь.
 *
 * Случаи:
 *   команда   — `layer.json` нет: командный слой как есть, эталон меток
 *   слой      — режим «вкл»: те же метки, хук сработал столько же раз
 *   замена    — режим «авто» с заменой хука из коммита: в журнале только
 *               голос заменённой версии, записанный в корень ОРИГИНАЛА
 *   контроль  — маршрут уже без `project`: меток команды нет — значит, в
 *               случаях выше их принёс слой, а не сам CLI
 *
 * Запуск: `node tools/qa/check-local-layer.mjs` (нужен `claude`; `CLAUDE_CLI`
 * задаёт путь). Стенд человека не трогается.
 */
import { createServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
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
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

const MCP_SERVER = fileURLToPath(new URL('./mcp-marker.mjs', import.meta.url));
const PREFIX = 'cc-local-layer-qa-';

const MARK = {
  user: 'LLUSERMARK',
  team: 'LLTEAMMARK',
  always: 'LLALWAYSMARK',
  scoped: 'LLSCOPEDMARK',
  nested: 'LLNESTEDMARK',
  skill: 'll-team-skill-mark',
  mcp: 'mcp__llteam__marker',
};

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

class NotChecked extends Error {}

function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (error) {
    console.warn(`временная папка не удалена (${error.code ?? error.message}): ${dir}`);
  }
}

/** Папки прошлых прогонов, которые Windows тогда не отпустил, — свои и старше часа. */
function sweepStale() {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = join(tmpdir(), name);
    try {
      if (statSync(dir).mtimeMs < hourAgo) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Всё ещё занята — уберёт следующий запуск.
    }
  }
}

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};

/**
 * Стаб API. Основной цикл (запрос с инструментами) идёт по сценарию: каждый
 * шаг — вызов Read, после сценария — конец хода. Служебные запросы CLI
 * (заголовок, сжатие) получают пустой текст и в улики не попадают.
 */
function startStub() {
  const state = { seen: [], script: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      if (!req.url?.includes('/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.url?.includes('count_tokens') ? '{"input_tokens":10}' : '{}');
        return;
      }
      const main = Array.isArray(body.tools) && body.tools.length > 5;
      if (main) state.seen.push(body);
      const step = main ? state.script[state.seen.length - 1] : undefined;
      const block = step
        ? { type: 'tool_use', id: `tu_${state.seen.length}`, name: 'Read', input: {} }
        : { type: 'text', text: '' };
      const delta = step
        ? { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: step }) }
        : { type: 'text_delta', text: 'ок' };
      const events = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'msg_ll',
              type: 'message',
              role: 'assistant',
              model: body.model ?? 'stub',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          },
        ],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: step ? 'tool_use' : 'end_turn' },
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
        state,
        close: () => server.close(),
      }),
    );
  });
}

/** Хук команды: пишет свой голос в журнал корня, найденного от СВОЕГО места. */
const guard = (voice) =>
  [
    "import { appendFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    'const ROOT = dirname(dirname(import.meta.filename));',
    `appendFileSync(join(ROOT, 'hook-log.txt'), '${voice}\\n');`,
    '',
  ].join('\n');

/** Проект с командным слоем: в каждом месте своя метка; ref — коммит с быстрым хуком. */
function buildProject() {
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), `${PREFIX}work-`)));
  const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'ignore' });
  write(join(work, '.gitignore'), '.agent/\nhook-log.txt\n');
  write(join(work, 'CLAUDE.md'), `# Team\n\n${MARK.team}\n`);
  write(join(work, '.claude', 'rules', 'always.md'), `# Always\n\n${MARK.always}\n`);
  write(
    join(work, '.claude', 'rules', 'scoped.md'),
    `---\npaths:\n  - "sub/**"\n---\n# Scoped\n\n${MARK.scoped}\n`,
  );
  write(join(work, 'sub', 'CLAUDE.md'), `# Sub\n\n${MARK.nested}\n`);
  write(join(work, 'sub', 'a.ts'), 'export const a = 1;\n');
  write(join(work, 'sub', 'b.ts'), 'export const b = 2;\n');
  write(
    join(work, '.claude', 'skills', MARK.skill, 'SKILL.md'),
    `---\nname: ${MARK.skill}\ndescription: team skill marker\n---\nx\n`,
  );
  write(
    join(work, '.mcp.json'),
    JSON.stringify({ mcpServers: { llteam: { command: process.execPath, args: [MCP_SERVER] } } }),
  );
  write(
    join(work, '.claude', 'settings.json'),
    JSON.stringify({
      enableAllProjectMcpServers: true,
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/guard.mjs"' }],
          },
        ],
      },
    }),
  );
  write(join(work, 'scripts', 'guard.mjs'), guard('TEAM'));
  git('init', '-q');
  git('config', 'user.email', 'qa@example.com');
  git('config', 'user.name', 'qa');
  git('add', '-A');
  git('commit', '-qm', 'team');
  git('checkout', '-qb', 'fast');
  write(join(work, 'scripts', 'guard.mjs'), guard('FAST'));
  git('commit', '-qam', 'fast guard');
  const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  git('checkout', '-q', '-');
  return { work, ref };
}

function buildConfigDir(work) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `${PREFIX}home-`)));
  write(join(home, 'CLAUDE.md'), `# User\n\n${MARK.user}\n`);
  write(join(home, 'settings.json'), '{}');
  write(
    join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [work.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } },
    }),
  );
  return home;
}

const count = (text, mark) => text.split(mark).length - 1;

async function main() {
  const { ChatRunRegistry } =
    await import('../../apps/server/src/domains/chat/ChatRunRegistry/ChatRunRegistry.ts');
  const { localLayerRun } =
    await import('../../apps/server/src/domains/local-layer/local-layer.ts');

  const stub = await startStub();
  console.log(`Стаб: ${stub.url}\n`);

  /**
   * Один ход настоящего CLI. `layer` — содержимое `layer.json` (нет — слоя нет),
   * `route` — флаги маршрута (контроль снимает `project` сам).
   */
  const runCase = async (label, layer, routeArgs) => {
    const { work, ref } = buildProject();
    const home = buildConfigDir(work);
    if (layer) write(join(work, '.agent', 'local-layer', 'layer.json'), JSON.stringify(layer(ref)));
    const place = { home: homedir(), configDir: home, caseless: process.platform === 'win32' };

    const runs = new ChatRunRegistry();
    runs.setPlatformRouting(() => ({
      env: {
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_BASE_URL: stub.url,
        ANTHROPIC_AUTH_TOKEN: 'll-stub-token',
        ANTHROPIC_API_KEY: 'll-stub-token',
        ANTHROPIC_MODEL: 'stub-ll',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      ...(routeArgs ? { layers: { args: routeArgs, systemPrompt: true, dropped: [] } } : {}),
    }));
    // Тот же резолвер, что у сервера, — только место конфигурации своё.
    let status;
    runs.setLocalLayerResolver((cwd) => {
      const extras = localLayerRun(cwd, place);
      status = extras?.status;
      return extras;
    });

    stub.state.seen = [];
    stub.state.script = [join(work, 'sub', 'a.ts'), join(work, 'sub', 'b.ts')];
    runs.start(
      `ll-${label}`,
      {
        prompt: 'прочитай файлы',
        cwd: work,
        ...(process.env.CLAUDE_CLI ? { command: process.env.CLAUDE_CLI } : {}),
        permissionMode: 'bypassPermissions',
      },
      { origin: 'chat' },
    );
    for (let i = 0; i < 4 * 180 && stub.state.seen.length < 3; i += 1) await wait(250);
    await wait(1500);
    const args = runs.describe(`ll-${label}`)?.options.platformArgs ?? [];
    runs.stopAll?.();
    await wait(300);

    const bodies = stub.state.seen.map(
      (body) => JSON.stringify(body.system ?? '') + JSON.stringify(body.messages ?? []),
    );
    const log = existsSync(join(work, 'hook-log.txt'))
      ? readFileSync(join(work, 'hook-log.txt'), 'utf8').trim().split('\n')
      : [];
    const first = bodies[0] ?? '';
    const last = bodies.at(-1) ?? '';
    const facts = {
      requests: bodies.length,
      user: first.includes(MARK.user),
      team: count(first, MARK.team),
      always: count(first, MARK.always),
      skill: first.includes(MARK.skill),
      mcp: (stub.state.seen[0]?.tools ?? []).some((tool) => tool.name === MARK.mcp),
      scopedAtStart: first.includes(MARK.scoped),
      nestedAtStart: first.includes(MARK.nested),
      scoped: count(last, MARK.scoped),
      nested: count(last, MARK.nested),
      log,
      args,
      status,
    };
    removeDir(work);
    removeDir(home);
    return facts;
  };

  try {
    const team = await runCase('team');
    console.log('команда:', JSON.stringify({ ...team, status: undefined }));
    if (team.requests < 3)
      throw new NotChecked(
        `стаб получил ${team.requests} запроса вместо 3 — CLI не дошёл до сценария`,
      );
    check(
      team.user && team.team === 1 && team.always === 1,
      'команда: личные и командные инструкции в начале сессии',
    );
    check(team.skill && team.mcp, 'команда: навык и MCP-сервер репозитория');
    check(
      !team.scopedAtStart && team.scoped === 1 && team.nested === 1,
      'команда: правило по путям и вложенный CLAUDE.md — после Read, по разу',
    );
    check(team.log.join(',') === 'TEAM,TEAM', 'команда: хук сработал на каждый Read');

    const on = await runCase('on', () => ({ mode: 'on', overrides: [] }));
    console.log('слой:', JSON.stringify({ ...on, status: undefined }));
    check(
      on.status?.used === true && on.args.includes('--plugin-dir'),
      'слой: подключён, флаги плагина и MCP на месте',
    );
    check(
      on.args.join(' ').includes('--setting-sources user,local'),
      'слой: источник project снят',
    );
    check(
      on.user && on.team === 1 && on.always === 1,
      'слой: инструкции те же и РОВНО по разу (не дважды)',
    );
    check(on.skill && on.mcp, 'слой: навык (плагином) и MCP-сервер (флагом)');
    check(!on.scopedAtStart && !on.nestedAtStart, 'слой: правило по путям не в начале сессии');
    check(
      on.scoped === 1 && on.nested === 1,
      'слой: правило по путям и вложенный CLAUDE.md пришли после Read, по разу',
    );
    check(
      on.log.join(',') === 'TEAM,TEAM',
      'слой: командный хук сработал столько же раз, не дважды',
    );

    const swap = await runCase('override', (ref) => ({
      mode: 'auto',
      overrides: [{ ref, entries: ['scripts/guard.mjs'], why: 'qa' }],
    }));
    console.log('замена:', JSON.stringify({ ...swap, status: undefined }));
    check(
      swap.status?.reason === 'gain' && swap.status?.overrides[0]?.state === 'active',
      'замена: «авто» видит выгоду, замена действует',
    );
    check(
      swap.log.join(',') === 'FAST,FAST',
      'замена: исполнена копия из коммита, журнал в корне оригинала',
    );
    check(swap.team === 1 && swap.scoped === 1, 'замена: остальной слой на месте');

    const control = await runCase('control', () => ({ mode: 'on', overrides: [] }), [
      '--setting-sources',
      'user,local',
    ]);
    console.log('контроль:', JSON.stringify({ ...control, status: undefined }));
    check(control.status === undefined, 'контроль: маршрут без project — резолвер слоя не звался');
    check(control.user, 'контроль: личный слой на месте');
    check(
      control.team === 0 && control.always === 0 && !control.skill && !control.mcp,
      'контроль: командных меток нет — их приносил слой',
    );
    check(
      control.scoped === 0 && control.nested === 0 && control.log.length === 0,
      'контроль: ни правил по путям, ни командного хука',
    );
  } finally {
    stub.close();
  }

  console.log(
    bad === 0
      ? '\nЛокальный слой доставляет командный слой целиком и ровно по разу.'
      : `\nПроблем: ${bad}`,
  );
  process.exit(bad === 0 ? 0 : 1);
}

sweepStale();
if (!process.features.typescript && !process.env.CC_LL_RETRY) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, CC_LL_RETRY: '1' } },
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
