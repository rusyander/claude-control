/**
 * Проверка окружения перед запуском: `pnpm doctor`.
 *
 * Одна команда на любой системе отвечает на вопрос «почему не работает».
 * Ничего не чинит и ничего не пишет на диск — только смотрит и объясняет.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { join, dirname } from 'node:path';

const OS_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[platform()] ?? platform();

const results = [];
const add = (status, title, detail) => results.push({ status, title, detail });

const ok = (title, detail) => add('ok', title, detail);
const warn = (title, detail) => add('warn', title, detail);
const fail = (title, detail) => add('fail', title, detail);

// === Node ===
const [major, minor] = process.versions.node.split('.').map(Number);
const nodeOk = major > 22 || (major === 22 && minor >= 6);
(nodeOk ? ok : fail)(
  `Node.js ${process.versions.node}`,
  nodeOk
    ? undefined
    : 'Нужен 22.6 или новее: сервер запускается с --experimental-strip-types. Поставьте через nvm (в проекте есть .nvmrc).',
);

// === Claude Code в PATH ===
const claudeBinary = platform() === 'win32' ? 'claude.cmd' : 'claude';
let claudeVersion;
try {
  // На Windows `.cmd` запускается только через оболочку, а передавать при этом
  // отдельный массив аргументов Node не даёт (DEP0190) — поэтому одной строкой.
  claudeVersion =
    platform() === 'win32'
      ? execFileSync(`${claudeBinary} --version`, {
          encoding: 'utf8',
          timeout: 20_000,
          shell: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      : execFileSync(claudeBinary, ['--version'], {
          encoding: 'utf8',
          timeout: 20_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();

  ok(`Claude Code найден: ${claudeVersion}`);
} catch {
  fail(
    'Claude Code не найден в PATH',
    `Панель запускает его командой «${claudeBinary}». Установите Claude Code и убедитесь, что команда работает в терминале.`,
  );
}

// === Каталог конфигурации ===
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const configSource = process.env.CLAUDE_CONFIG_DIR
  ? 'из CLAUDE_CONFIG_DIR'
  : 'по домашнему каталогу';

if (existsSync(configDir)) {
  ok(`Каталог конфигурации найден ${configSource}`, configDir);
} else {
  fail(
    `Каталог конфигурации не найден: ${configDir}`,
    'Запустите Claude Code хотя бы раз — каталог создаётся при первом запуске. Если он в нестандартном месте, задайте CLAUDE_CONFIG_DIR.',
  );
}

// === Файлы конфигурации ===
for (const [name, path] of [
  ['settings.json', join(configDir, 'settings.json')],
  ['CLAUDE.md', join(configDir, 'CLAUDE.md')],
  ['.claude.json', join(dirname(configDir), '.claude.json')],
]) {
  if (existsSync(path)) ok(`${name} на месте`);
  else warn(`${name} отсутствует`, `Появится сам, когда вы что-нибудь настроите. Путь: ${path}`);
}

// === Доступ к аккаунту: главное различие между системами ===
const credentialsFile = join(configDir, '.credentials.json');
const panelFile = join(homedir(), '.claude-control', 'credentials.json');

if (existsSync(panelFile)) {
  // Заданное вручную идёт первым и в самой панели — ради этого оно и есть.
  ok('Доступ: задан вручную', `${panelFile} — перебивает автоматический источник`);
} else if (existsSync(credentialsFile)) {
  ok('Доступ: файл .credentials.json');
} else if (platform() === 'darwin') {
  const services = [
    process.env.CLAUDE_CONTROL_KEYCHAIN_SERVICE,
    'Claude Code-credentials',
    'Claude Code',
  ].filter(Boolean);

  const found = services.find((service) => {
    try {
      const value = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return value.startsWith('{');
    } catch {
      return false;
    }
  });

  if (found) {
    ok(`Доступ: связка ключей macOS («${found}»)`);
  } else {
    warn(
      'Доступ не найден ни файлом, ни в связке ключей',
      'Обычный чат и все разделы работают — не заработает только песочница. Три пути: войти командой «claude» в терминале; задать имя записи в CLAUDE_CONTROL_KEYCHAIN_SERVICE; либо ввести доступ вручную в Настройках панели. Подробности в docs/SETUP.ru.md → Различия между системами.',
    );
  }
} else {
  warn(
    'Доступ не найден',
    `Ожидался в ${credentialsFile}. Войдите командой «claude» в терминале либо задайте доступ вручную в Настройках панели — без него не заработает только песочница.`,
  );
}

// === Порты ===
const ports = [
  ['API', Number(process.env.PORT ?? 5178)],
  ['интерфейс', Number(process.env.WEB_PORT ?? 8888)],
];

for (const [label, port] of ports) {
  const busy = await isPortBusy(port);
  if (busy) {
    warn(
      `Порт ${port} (${label}) занят`,
      `Освободите его или задайте другой: ${label === 'API' ? 'PORT' : 'WEB_PORT'}=<номер>.`,
    );
  } else {
    ok(`Порт ${port} (${label}) свободен`);
  }
}

// === Зависимости ===
if (existsSync(join(process.cwd(), 'node_modules'))) ok('Зависимости установлены');
else fail('Зависимости не установлены', 'Выполните: pnpm install');

// === Длинные пути Windows: без них параллельные копии показывают ложные удаления ===
//
// Замерено 2 сентября 2026 на живом прогоне в gorgona: агент внутри копии
// получал «could not open directory …: Filename too long» и видел настоящие
// файлы УДАЛЁННЫМИ, а `git add -A` в такой копии записал бы эти удаления.
// Панель включает ключ в конфиге каждого репозитория, где заводит копию, но
// защищает это только те репозитории и только после первой копии — общесистемная
// настройка шире и делается один раз, поэтому о ней и говорим.
if (platform() === 'win32') {
  const registryOn = (() => {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'],
        { encoding: 'latin1', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return /LongPathsEnabled\s+REG_DWORD\s+0x1/i.test(out);
    } catch {
      return false;
    }
  })();

  const gitOn = (() => {
    try {
      return (
        execFileSync('git', ['config', '--get', 'core.longpaths'], {
          encoding: 'utf8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() === 'true'
      );
    } catch {
      return false;
    }
  })();

  if (registryOn || gitOn) {
    ok(
      'Длинные пути разрешены',
      [registryOn && 'настройкой Windows', gitOn && 'ключом git core.longpaths']
        .filter(Boolean)
        .join(' и '),
    );
  } else {
    warn(
      'Длинные пути не разрешены — параллельные копии будут показывать ложные удаления',
      'Выполните: git config --global core.longpaths true. Надёжнее — включить и в самой Windows: «Редактор локальной групповой политики» → Конфигурация компьютера → Административные шаблоны → Система → Файловая система → «Включить длинные пути Win32» (или HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\\LongPathsEnabled = 1, нужны права администратора). Подробности в docs/SETUP.ru.md → Параллельные копии показывают удалённые файлы.',
    );
  }
}

// === Место под телефонное приложение ===
// Нативная сборка оставляет объектные файлы внутри node_modules — гигабайты,
// которых нет ни в APK, ни в репозитории. Сборка убирает их за собой, но
// прерванная сборка или `--keep-build` могут их оставить.
if (existsSync(join(process.cwd(), 'apps', 'mobile', 'android'))) {
  const { mobileBuildFootprint, formatGb } = await import('./clean-mobile-build.mjs');
  const bytes = mobileBuildFootprint();
  if (bytes > 2 * 1024 ** 3) {
    warn(
      `Промежуточные файлы сборки телефона: ${formatGb(bytes)}`,
      'Это мусор нативной сборки внутри node_modules. Уберите: pnpm mobile:clean',
    );
  } else if (bytes > 0) {
    ok(`Промежуточные файлы сборки телефона: ${formatGb(bytes)}`);
  }
}

// === Вывод ===
const MARK = { ok: '✓', warn: '!', fail: '✗' };

console.log(`\nClaude Control — проверка окружения\n${OS_NAME} ${release()}\n`);

for (const { status, title, detail } of results) {
  console.log(`${MARK[status]} ${title}`);
  if (detail) console.log(`   ${detail}`);
}

const failed = results.filter((r) => r.status === 'fail').length;
const warned = results.filter((r) => r.status === 'warn').length;

console.log(
  failed > 0
    ? `\nЗапустить не получится: ${failed} блокирующих. Исправьте отмеченное знаком ✗.`
    : warned > 0
      ? `\nЗапустится. Замечаний: ${warned} — они не мешают старту.`
      : '\nВсё готово: pnpm dev',
);

process.exit(failed > 0 ? 1 : 0);

/** Занят ли порт: пытаемся встать на него сами. */
async function isPortBusy(port) {
  const net = await import('node:net');

  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '127.0.0.1');
  });
}
