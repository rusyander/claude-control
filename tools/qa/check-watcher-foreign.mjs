/**
 * Разбор фонового наблюдателя самим чужим CLI (X9) — настоящий сервер, настоящий
 * маршрут и настоящий запуск через PATH. Подменена только модель: на PATH лежит
 * фальшивый `qwen` в форме обёртки npm (`qwen.cmd` → `node <скрипт> %*`, как у
 * настоящей установки на Windows; многострочное задание через cmd.exe не прошло
 * бы), который пишет свой argv, рабочий каталог и задание в файл и отвечает
 * находкой в формате разборщика. Настоящего `claude` на PATH нет вовсе.
 *
 * Своя одноразовая панель (домашний каталог и отчёт в temp), без браузера:
 * поведение здесь серверное, страница наблюдателя показывает то же состояние.
 *
 *   1. активен Qwen Code, Claude Code нет — наблюдатель включается без
 *      `cli_missing`: разбор поведёт сам Qwen;
 *   2. сбой → запущен `qwen --approval-mode default -p <задание>` в корне
 *      приложения, в задании правила разбора и сам сбой; раздел отчёта получает
 *      вердикт и место в коде;
 *   3. выключили наблюдателя посреди разбора — процесс Qwen снят;
 *   4. негативы на своих панелях: активен Cursor (запуска без правок нет) →
 *      `route_refused` с его именем; Qwen не на PATH → `route_refused`
 *      «не найден в PATH»; процесса нет ни там, ни там.
 *
 * Запуск: `node tools/qa/check-watcher-foreign.mjs` (порты WATCH_FOREIGN_PORT,
 * по умолчанию 5281, и два следующих).
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.WATCH_FOREIGN_PORT ?? 5281);
const PORTS = [PORT, PORT + 1, PORT + 2];
const IS_WIN = process.platform === 'win32';

class NotChecked extends Error {}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

async function until(probe, seconds, step = 200) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await wait(step);
  }
}

async function waitFor(url, seconds) {
  return until(
    async () => {
      try {
        const res = await fetch(url);
        return res.status < 500 ? res : undefined;
      } catch {
        return undefined;
      }
    },
    seconds,
    250,
  );
}

function apiAt(port) {
  return async (path, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    try {
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    } catch {
      return { status: res.status, body: text };
    }
  };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Фальшивый Qwen: выгрузка argv/cwd/задания в `CC_WATCH_FOREIGN_DUMP`, ответ находкой. */
const FAKE_QWEN = `
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.25.0\\n');
  process.exit(0);
}
const dump = process.env.CC_WATCH_FOREIGN_DUMP;
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
fs.writeFileSync(
  path.join(dump, process.pid + '.json'),
  JSON.stringify({ argv, cwd: process.cwd(), prompt, pid: process.pid }),
);
const sleepFile = path.join(dump, '..', 'sleep-ms');
const sleep = fs.existsSync(sleepFile) ? Number(fs.readFileSync(sleepFile, 'utf8')) : 0;
setTimeout(() => {
  const ids = [...prompt.matchAll(/^id: ([0-9a-f]+)$/gm)].map((m) => m[1]);
  const items = ids.map((id) => ({
    id,
    title: 'Сбой маршрута чатов',
    happened: 'Запрос списка чатов упал.',
    rootCause: 'Нет проверки на пустой ответ.',
    steps: 'Открыть раздел чатов.',
    verdict: 'confirmed',
    severity: 'medium',
    location: 'apps/server/src/routes/chat/chat-routes.ts:1',
    fix: 'Проверить ответ.',
    sameAs: '',
  }));
  process.stdout.write('\`\`\`agentdeck-watch\\n' + JSON.stringify(items) + '\\n\`\`\`\\n');
}, sleep);
`;

function writeFakeQwen(bin) {
  const script = join(bin, 'fake-qwen.cjs');
  writeFileSync(script, FAKE_QWEN, 'utf8');
  if (IS_WIN) writeFileSync(join(bin, 'qwen.cmd'), '@node "%~dp0\\fake-qwen.cjs" %*\r\n');
  else {
    writeFileSync(join(bin, 'qwen'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
      mode: 0o755,
    });
  }
}

function makeEnv(root, extra) {
  const home = join(root, 'home');
  const cfg = join(home, '.claude');
  for (const dir of [cfg, join(home, 'AppData/Roaming'), join(home, 'AppData/Local')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(cfg, 'settings.json'), '{}\n', 'utf8');
  const homeEnv = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: cfg,
    APPDATA: join(home, 'AppData/Roaming'),
    LOCALAPPDATA: join(home, 'AppData/Local'),
  };
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !['PATH', ...Object.keys(homeEnv)].includes(key.toUpperCase()),
    ),
  );
  return { ...base, ...homeEnv, ...extra };
}

/** PATH без настоящих CLI: системный каталог и (по желанию) подмена. */
function isolatedPath(bin) {
  const system = IS_WIN
    ? [
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
        process.env.SystemRoot ?? 'C:\\Windows',
      ]
    : ['/usr/bin', '/bin'];
  return [...(bin ? [bin] : []), ...system].join(IS_WIN ? ';' : ':');
}

function startPanel(port, env) {
  return spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/index.ts'], {
    cwd: join(REPO, 'apps/server'),
    env: { ...env, PORT: String(port) },
    stdio: 'ignore',
    shell: false,
  });
}

function dumps(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
}

const signal = {
  kind: 'window-error',
  message: 'qa foreign watcher: chats list crashed',
  route: '/chat',
};

async function main() {
  for (const port of PORTS) {
    if (await waitFor(`http://127.0.0.1:${port}/`, 1))
      throw new NotChecked(`порт ${port} занят чужим процессом — задайте WATCH_FOREIGN_PORT.`);
  }
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-watch-foreign-qa-')));
  const bin = join(root, 'bin');
  const dump = join(root, 'dump');
  mkdirSync(bin, { recursive: true });
  mkdirSync(dump, { recursive: true });
  writeFakeQwen(bin);
  const report = join(root, 'report', 'WATCH-REPORT.md');
  const children = [];
  try {
    const panel = (port, name, path, extra = {}) => {
      const child = startPanel(
        port,
        makeEnv(join(root, name), {
          PATH: path,
          AGENTDECK_WATCH_DEBOUNCE_MS: '200',
          AGENTDECK_WATCH_RUNS_PER_HOUR: '50',
          CC_WATCH_FOREIGN_DUMP: dump,
          ...extra,
        }),
      );
      children.push(child);
      return child;
    };
    panel(PORTS[0], 'main', isolatedPath(bin), { AGENTDECK_WATCH_REPORT: report });
    panel(PORTS[1], 'cursor', isolatedPath(bin), {
      AGENTDECK_WATCH_REPORT: join(root, 'cursor', 'R.md'),
    });
    panel(PORTS[2], 'nocli', isolatedPath(), {
      AGENTDECK_WATCH_REPORT: join(root, 'nocli', 'R.md'),
    });
    for (const port of PORTS) {
      if (!(await waitFor(`http://127.0.0.1:${port}/api/system`, 60)))
        throw new NotChecked(`панель :${port} не поднялась.`);
    }

    // 1–2. Qwen ведёт разбор сам.
    const api = apiAt(PORTS[0]);
    const switched = await api('/settings', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'qwen' }),
    });
    check('активный CLI — Qwen Code', switched.status === 200, JSON.stringify(switched.body));
    const on = (await api('/watcher', { method: 'POST', body: JSON.stringify({ enabled: true }) }))
      .body;
    check(
      'Claude Code нет на PATH, а наблюдатель включён без cli_missing',
      on?.enabled === true && on.problem === undefined,
      JSON.stringify(on?.problem),
    );
    await api('/watcher/events', { method: 'POST', body: JSON.stringify(signal) });
    const run = await until(() => dumps(dump)[0], 30);
    check('процесс Qwen запущен', Boolean(run));
    if (run) {
      check(
        'режим без правок: --approval-mode default -p',
        run.argv[0] === '--approval-mode' && run.argv[1] === 'default' && run.argv[2] === '-p',
        JSON.stringify(run.argv.slice(0, 3)),
      );
      check(
        'рабочий каталог — корень приложения',
        resolve(run.cwd).toLowerCase() === resolve(REPO).toLowerCase(),
        run.cwd,
      );
      check(
        'в задании правила разбора и сам сбой',
        run.prompt.includes('You are the background watcher of the AgentDeck panel') &&
          run.prompt.includes(signal.message),
      );
    }
    const analysed = await until(() => {
      const text = existsSync(report) ? readFileSync(report, 'utf8') : '';
      return /verdict=confirmed/.test(text) ? text : undefined;
    }, 30);
    check(
      'раздел отчёта: вердикт и место в коде из ответа Qwen',
      Boolean(analysed?.includes('apps/server/src/routes/chat/chat-routes.ts:1')),
    );
    const after = (await api('/watcher')).body;
    check(
      'после разбора проблем нет',
      after?.problem === undefined,
      JSON.stringify(after?.problem),
    );

    // 3. Выключили посреди разбора — процесс снят.
    writeFileSync(join(root, 'sleep-ms'), '60000');
    for (const name of readdirSync(dump)) rmSync(join(dump, name));
    await api('/watcher/events', {
      method: 'POST',
      body: JSON.stringify({ ...signal, message: 'qa foreign watcher: second crash' }),
    });
    const long = await until(() => dumps(dump)[0], 30);
    check('второй разбор запущен', Boolean(long));
    if (long) {
      await api('/watcher', { method: 'POST', body: JSON.stringify({ enabled: false }) });
      const gone = await until(() => !alive(long.pid), 10);
      check('выключили — процесс Qwen снят', gone === true, `pid ${long.pid}`);
    }
    rmSync(join(root, 'sleep-ms'));
    for (const name of readdirSync(dump)) rmSync(join(dump, name));

    // 4. Негативы.
    const refused = async (port, provider, expected, name) => {
      const at = apiAt(port);
      await at('/settings', { method: 'PATCH', body: JSON.stringify({ provider }) });
      await at('/watcher', { method: 'POST', body: JSON.stringify({ enabled: true }) });
      await at('/watcher/events', { method: 'POST', body: JSON.stringify(signal) });
      const status = await until(async () => {
        const body = (await at('/watcher')).body;
        return body?.problem?.problemCode === 'route_refused' ? body : undefined;
      }, 15);
      check(
        name,
        Boolean(status?.problem?.detail?.includes(expected)) && dumps(dump).length === 0,
        JSON.stringify(status?.problem ?? null),
      );
      await at('/watcher', { method: 'POST', body: JSON.stringify({ enabled: false }) });
    };
    await refused(PORTS[1], 'cursor', 'Cursor', 'Cursor: отказ кодом с его именем, процесса нет');
    await refused(PORTS[2], 'qwen', 'не найден в PATH', 'Qwen не на PATH: отказ, процесса нет');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await wait(500);
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(failures === 0 ? 'ВСЁ ЗЕЛЁНОЕ' : `ПРОВАЛОВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  if (error instanceof NotChecked) {
    console.log(`НЕ ПРОВЕРЕНО: ${error.message}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
