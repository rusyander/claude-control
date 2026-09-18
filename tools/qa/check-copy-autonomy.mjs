/**
 * Автономность параллельной копии: доказательство, а не чтение кода.
 *
 * Копия репозитория обязана быть для агента ровно тем же, чем был оригинал.
 * Проверяется это не по исходникам панели, а по следам на диске и по телу
 * запроса, ушедшего наверх:
 *
 *  1. запись копии в `.claude.json` — доверие и согласие на серверы `.mcp.json`
 *     приезжают из оригинала, а следы его работы (`last*`, `history`) нет;
 *  2. `POST /api/chat/send` в СЛОМАННУЮ копию (файла нет, записи нет) чинит её
 *     молча и не отказывает — человек уже сказал, чего хочет, нажав «отправить»;
 *  3. дыра, которую добрать нельзя, действительно отказывает 422 `copy_not_ready`;
 *  4. уборка копии забирает её запись — иначе доверие к мёртвому пути однажды
 *     достанется другой ветке с тем же именем;
 *  5. САМОЕ сильное: настоящий `claude`, запущенный В КОПИИ против стаба вместо
 *     API, приносит наверх метки проектного слоя — скилл из `.claude/skills`
 *     (в копии это ссылка) и сервер из `.mcp.json`. Это и значит «копия так же
 *     способна, как оригинал»: ни один вопрос о доверии и о серверах её не
 *     остановил, иначе меток в запросе не было бы.
 *
 * Своего окружения проверка не требует и стенд человека не трогает: своя панель
 * на свободном порту, одноразовый HOME и каталог конфигурации, свой репозиторий
 * во временной папке. Пункт 5 требует установленного `claude` (путь можно задать
 * `CLAUDE_CLI`); без него он честно помечается НЕ ПРОВЕРЕНО и выход 2, а не
 * зелёный.
 *
 * Запуск: `node tools/qa/check-copy-autonomy.mjs`
 */
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PANEL_PORT = Number(process.env.COPY_PANEL_PORT ?? 5266);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const BRANCH = 'feature/qa-autonomy';

/** Метки: каждая отвечает за свой источник проектного слоя в копии. */
const MARK = {
  /** Имя скилла из `.claude/skills` — в копии этот каталог ссылка. */
  skill: 'cc-copy-skill-marker',
  /** Инструмент сервера из `.mcp.json` — он неотслеживаемый и не игнорируемый. */
  mcp: 'mcp__cpmarker__marker',
  /** `CLAUDE.md` репозитория — приезжает самим чекаутом. */
  project: 'CCCOPYPROJMARKER',
  /** `CLAUDE.local.md` — неотслеживаемый и не игнорируемый, только зеркалом. */
  local: 'CCCOPYLOCALMARKER',
};

const MCP_SERVER = fileURLToPath(new URL('./mcp-marker.mjs', import.meta.url));

let failures = 0;
const check = (ok, what, detail) => {
  console.log(`${ok ? '✓' : '✕'} ${what}${ok || !detail ? '' : `\n    ${detail}`}`);
  if (!ok) failures += 1;
};

class NotChecked extends Error {}

const key = (path) => path.replace(/\\/g, '/').replace(/\/+$/, '');

/** Ссылка ли путь. Отсутствие — не исключение проверки, а её ответ «нет». */
const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Чтение файла, которого может не быть: пусто вместо падения всей проверки. */
const readOr = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 4; i += 1) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // ещё не поднялась
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function api(path, init = {}) {
  const res = await fetch(`${PANEL}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/**
 * Отправка сообщения: ответ — поток, поэтому берём только заголовок. При отказе
 * тело обычное, JSON.
 */
async function send(cwd, chatId) {
  const controller = new AbortController();
  const res = await fetch(`${PANEL}/api/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, prompt: 'скажи ок', projectPath: cwd }),
    signal: controller.signal,
  });
  if (res.status !== 200) {
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }
  controller.abort();
  return { status: res.status, body: undefined };
}

/** Репозиторий с проектным слоем: три источника зеркала плюс отслеживаемый файл. */
function makeRepo() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-qa-auto-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'qa@example.invalid');
  git('config', 'user.name', 'QA');
  git('config', 'commit.gpgsign', 'false');
  // `.claude/` игнорируется, а `.mcp.json` и `CLAUDE.local.md` — НЕТ: ровно тот
  // проект, где неотслеживаемое и не игнорируемое видит только третий источник.
  writeFileSync(join(dir, '.gitignore'), '.claude/\nnode_modules/\n');
  writeFileSync(join(dir, 'CLAUDE.md'), `# Проект\n\n${MARK.project}\n`);
  git('add', '-A');
  git('commit', '-m', 'первый');

  writeFileSync(join(dir, 'CLAUDE.local.md'), `${MARK.local}\n`);
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { cpmarker: { command: process.execPath, args: [MCP_SERVER] } } }),
  );
  const skillDir = join(dir, '.claude', 'skills', MARK.skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${MARK.skill}\ndescription: скилл репозитория для проверки автономности копии\n---\n\nНичего не делает.\n`,
  );
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({ permissions: {} }, null, 2),
  );
  return dir;
}

/** Заглушка вместо `claude` в PATH панели: прогон нам не нужен, нужен вердикт ворот. */
function makeStubCli() {
  const bin = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-qa-bin-')));
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nexit /b 0\r\n');
  } else {
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'claude'), 0o755);
  }
  return bin;
}

/** Путь до настоящего CLI — тем же правилом, что и в `check-run-layers.mjs`. */
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

/** Стаб вместо API Anthropic: записывает каждый запрос и отвечает одним словом. */
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
              id: 'msg_copy',
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

/**
 * Настоящий CLI В КОПИИ против стаба. Подменяется только модель: каталог
 * конфигурации тот же, что у панели, рабочая папка — копия, и ничего из
 * проектного слоя руками туда не кладётся.
 */
async function runRealCli(exe, cwd, configDir, stub) {
  const from = stub.seen.length;
  const cli = spawn(exe, ['-p', 'скажи ок', '--permission-mode', 'default'], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_AUTH_TOKEN: 'copy-stub-token',
      ANTHROPIC_API_KEY: 'copy-stub-token',
      ANTHROPIC_MODEL: 'stub-copy',
      DISABLE_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
  });
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
  const body = stub.seen[from];
  if (!body) return undefined;
  return {
    text: JSON.stringify(body.system ?? '') + JSON.stringify(body.messages ?? []),
    tools: (body.tools ?? []).map((tool) => tool.name),
  };
}

function drop(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp и уйдёт с ОС — на результат это не влияет.
  }
}

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-qa-home-')));
const configDir = join(home, '.claude');
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, 'settings.json'), '{}\n');
const claudeJson = join(home, '.claude.json');
const repo = makeRepo();
const copies = join(dirname(repo), `${basename(repo)}-worktrees`);
const stubBin = makeStubCli();

/** Запись оригинала: доверие, согласие на сервер из `.mcp.json` и следы работы. */
writeFileSync(
  claudeJson,
  JSON.stringify(
    {
      hasCompletedOnboarding: true,
      projects: {
        [key(repo)]: {
          hasTrustDialogAccepted: true,
          enabledMcpjsonServers: ['cpmarker'],
          disabledMcpjsonServers: [],
          allowedTools: ['Bash(git status:*)'],
          lastCost: 42,
          lastAPIDuration: 7,
          lastSessionId: 'должно остаться у оригинала',
          history: [{ display: 'старое' }],
        },
      },
    },
    null,
    2,
  ),
);

const readProjects = () => JSON.parse(readFileSync(claudeJson, 'utf8')).projects ?? {};

const panel = spawn(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
  {
    env: {
      ...process.env,
      PATH: `${stubBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      CLAUDE_CONFIG_DIR: configDir,
      USERPROFILE: home,
      HOME: home,
      PORT: String(PANEL_PORT),
    },
    stdio: 'ignore',
    shell: false,
  },
);

const stub = await startStub();
let copy;
let notChecked = '';

try {
  if (!(await waitFor(`${PANEL}/api/system`, 40))) {
    throw new NotChecked('одноразовая панель не поднялась.');
  }
  // Порт мог оказаться занят ЧУЖОЙ панелью — тогда своя тихо умерла, а проверка
  // пошла бы писать в чужой `.claude.json` и позеленела бы на чужих файлах.
  // Спрашиваем ответившую панель, с каким каталогом конфигурации она работает.
  const where = await api('/location');
  if (key(where.body?.paths?.root ?? '') !== key(configDir)) {
    throw new NotChecked(
      `на ${PANEL} отвечает чужая панель (каталог ${where.body?.paths?.root}) — ` +
        'освободите порт или задайте свой через COPY_PANEL_PORT.',
    );
  }
  console.log(`Панель: ${PANEL}\nРепозиторий: ${repo}\nКаталог конфигурации: ${configDir}\n`);

  // --- 1. Копия заводится панелью, как её заводит человек ---------------------
  const created = await api('/project-git/worktrees/add', {
    method: 'POST',
    body: JSON.stringify({ path: repo, name: BRANCH }),
  });
  check(
    created.status === 200,
    `копия заведена через API (${created.status})`,
    created.body?.message,
  );
  copy = created.body?.createdPath ?? join(copies, 'feature-qa-autonomy');
  check(existsSync(copy), `каталог копии на месте (${copy})`);

  const entry = readProjects()[key(copy)];
  check(Boolean(entry), 'у копии появилась своя запись в .claude.json');
  check(entry?.hasTrustDialogAccepted === true, 'запись копии несёт доверие оригинала');
  check(
    JSON.stringify(entry?.enabledMcpjsonServers) === JSON.stringify(['cpmarker']),
    'запись копии несёт согласие на серверы .mcp.json',
    JSON.stringify(entry?.enabledMcpjsonServers),
  );
  check(
    JSON.stringify(entry?.allowedTools) === JSON.stringify(['Bash(git status:*)']),
    'запись копии несёт разрешённые инструменты',
  );
  const traces = Object.keys(entry ?? {}).filter(
    (field) => field.startsWith('last') || field === 'history',
  );
  check(
    traces.length === 0,
    'следы работы оригинала (last*/history) в запись копии не попали',
    traces.join(', '),
  );
  check(readProjects()[key(repo)]?.lastCost === 42, 'запись самого оригинала не тронута');

  // Локальный слой на месте — без него метки пункта 5 не с чего взяться.
  check(
    readOr(join(copy, '.mcp.json')).includes('cpmarker'),
    'копия получила .mcp.json (неотслеживаемый и не игнорируемый)',
  );
  check(
    readOr(join(copy, 'CLAUDE.local.md')).includes(MARK.local),
    'копия получила CLAUDE.local.md',
  );
  check(isLink(join(copy, '.claude', 'skills')), '.claude/skills в копии — ссылка, а не копия');

  // --- 5. Настоящий CLI в копии: проектный слой в теле запроса ---------------
  const exe = resolveClaude();
  if (!exe) {
    notChecked = 'настоящий `claude` не найден — задайте путь через CLAUDE_CLI';
    console.log(`НЕ ПРОВЕРЕНО: ${notChecked}`);
  } else {
    const facts = await runRealCli(exe, copy, configDir, stub);
    check(Boolean(facts), 'настоящий CLI в копии дошёл до запроса наверх — доверие не спросили');
    if (facts) {
      check(facts.text.includes(MARK.project), 'в запросе из копии есть CLAUDE.md репозитория');
      check(
        facts.text.includes(MARK.skill),
        'в запросе из копии есть скилл проекта — ссылка .claude/skills работает',
      );
      check(
        facts.tools.includes(MARK.mcp),
        'в запросе из копии есть сервер из .mcp.json — согласие приехало записью доступа',
        facts.tools.join(', '),
      );
    }
  }

  // --- 2. Сломанная копия чинится молча --------------------------------------
  rmSync(join(copy, '.mcp.json'), { force: true });
  const withoutCopy = JSON.parse(readFileSync(claudeJson, 'utf8'));
  delete withoutCopy.projects[key(copy)];
  writeFileSync(claudeJson, JSON.stringify(withoutCopy, null, 2));

  const repaired = await send(copy, 'qa-copy-repair');
  check(
    repaired.status === 200,
    `отправка в сломанную копию не отказала (${repaired.status})`,
    JSON.stringify(repaired.body),
  );
  check(existsSync(join(copy, '.mcp.json')), 'панель вернула .mcp.json в копию сама');
  check(Boolean(readProjects()[key(copy)]), 'панель вернула запись доступа копии сама');

  // --- 3. Дыра, которую добрать нельзя, — честный отказ -----------------------
  // Ломаем так, чтобы починить было НЕЧЕМ: на месте `.claude` копии лежит файл,
  // значит ни `settings.json` туда не записать, ни ссылку на скиллы не положить.
  drop(join(copy, '.claude'));
  writeFileSync(join(copy, '.claude'), 'не каталог\n');
  const refused = await send(copy, 'qa-copy-refuse');
  check(refused.status === 422, `отправка в неисправимую копию отказана 422 (${refused.status})`);
  check(refused.body?.code === 'copy_not_ready', `код отказа copy_not_ready`, refused.body?.code);
  check(
    Array.isArray(refused.body?.gaps) && refused.body.gaps.length > 0,
    'отказ называет дыры',
    JSON.stringify(refused.body?.gaps),
  );

  // --- 4. Уборка копии забирает её запись ------------------------------------
  rmSync(join(copy, '.claude'), { force: true });
  const removed = await api('/project-git/worktrees/remove', {
    method: 'POST',
    body: JSON.stringify({ path: repo, worktreePath: copy, force: true }),
  });
  check(
    removed.status === 200,
    `копия убрана через API (${removed.status})`,
    removed.body?.message,
  );
  check(
    readProjects()[key(copy)] === undefined,
    'запись копии из .claude.json убрана вместе с ней',
  );
  check(Boolean(readProjects()[key(repo)]), 'запись оригинала при уборке копии осталась');
} finally {
  panel.kill();
  stub.close();
  drop(copies);
  drop(repo);
  drop(home);
  drop(stubBin);
}

if (failures > 0) {
  console.log(`\nПровалено: ${failures}`);
  process.exit(1);
}
if (notChecked) {
  console.log(`\nНЕ ПРОВЕРЕНО: ${notChecked}`);
  process.exit(2);
}
console.log('\nКопия автономна: слой, доступ, добор, отказ и уборка сошлись.');
process.exit(0);
