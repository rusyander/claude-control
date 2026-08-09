/**
 * Вывести панель в приватную сеть Tailscale: `pnpm remote` / `pnpm remote:off`.
 *
 * Почему именно так, а не «слушать 0.0.0.0». Сервер как слушал петлю, так и
 * слушает: `tailscale serve` работает НА ЭТОЙ ЖЕ машине и проксирует на
 * `127.0.0.1`, поэтому порт в локальную сеть не публикуется вовсе, а снаружи
 * панель видна только устройствам того же tailnet — и только по HTTPS с
 * сертификатом от самой Tailscale.
 *
 * Скрипт ничего не выдумывает и ничего не чинит молча: он проверяет по шагам
 * (бинарь → вход в сеть → HTTPS-сертификаты → работает ли панель) и на каждом
 * несделанном шаге печатает ровно ту команду, которую человеку надо выполнить
 * самому. Установка Tailscale и включение сертификатов требуют прав
 * администратора и живого аккаунта — за пользователя это сделать нельзя.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

const PORT = Number(process.env.PORT ?? 5178);
const OFF = process.argv.includes('--off');

/** На Windows бинарь чаще лежит в Program Files, а не в PATH. */
const WINDOWS_PATHS = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
];

function binary() {
  if (platform() === 'win32') {
    const found = WINDOWS_PATHS.find((path) => existsSync(path));
    if (found) return found;
  }
  return 'tailscale';
}

function run(args, { quiet = false } = {}) {
  try {
    return execFileSync(binary(), args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return { failed: true, message: error.stderr?.toString().trim() || error.message };
  }
}

function die(message, hint) {
  console.error(`\n✕ ${message}`);
  if (hint) console.error(`  ${hint}\n`);
  process.exit(1);
}

// === Шаг 1: бинарь на месте ===
const version = run(['version'], { quiet: true });
if (version.failed) {
  die(
    'Tailscale не найден.',
    platform() === 'win32'
      ? 'Поставьте с https://tailscale.com/download/windows и войдите в свою сеть. Установка требует прав администратора.'
      : 'Поставьте с https://tailscale.com/download и войдите: sudo tailscale up',
  );
}

// === Шаг 2: машина в сети и у неё есть имя ===
const statusRaw = run(['status', '--json'], { quiet: true });
if (statusRaw.failed)
  die('Tailscale установлен, но не отвечает.', 'Запустите клиент и войдите в свою сеть.');

let dnsName = '';
try {
  dnsName = (JSON.parse(statusRaw).Self?.DNSName ?? '').replace(/\.$/, '');
} catch {
  die('Не удалось разобрать ответ tailscale status.');
}
if (!dnsName) die('У машины нет имени в tailnet.', 'Войдите в свою сеть: tailscale up');

const url = `https://${dnsName}`;

// === Выключение ===
if (OFF) {
  const off = run(['serve', '--https=443', 'off']);
  if (off.failed) die('Не удалось выключить проксирование.', off.message);
  console.log(`\n✓ Проксирование выключено. ${url} больше не ведёт на панель.\n`);
  process.exit(0);
}

// === Шаг 3: панель действительно запущена ===
// Проверяем ДО serve: проксировать на мёртвый порт бессмысленно, а телефон
// получил бы вместо панели пустую ошибку шлюза и повод искать причину не там.
let panelAlive = false;
try {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/system`, {
    signal: AbortSignal.timeout(3_000),
  });
  // 401 — это тоже живая панель: гейт токена включён, и без токена она отвечает
  // именно так. Считать это «не запущена» значило бы пугать зря.
  panelAlive = response.ok || response.status === 401;
} catch {
  // Не ответила — оставляем false и говорим об этом ниже.
}
if (!panelAlive) {
  console.warn(
    `\n! Панель на 127.0.0.1:${PORT} не отвечает. Проксирование включим, но сначала запустите её: pnpm dev`,
  );
}

// === Шаг 4: собственно проксирование ===
const serve = run(['serve', '--bg', '--https=443', `http://127.0.0.1:${PORT}`]);
if (serve.failed) {
  die(
    'Не удалось включить проксирование.',
    /cert|HTTPS/i.test(serve.message)
      ? 'В админке tailnet включите HTTPS Certificates: https://login.tailscale.com/admin/dns — без них у машины нет сертификата, и serve на 443 не поднимется.'
      : serve.message,
  );
}

console.log(`
✓ Панель доступна в вашей сети Tailscale:

    ${url}

  Дальше — в панели: Настройки → Удалённый доступ → включить «Пускать по токену»
  и показать код спаривания. В приложении на телефоне: Настройки → Спарить.

  Порт наружу НЕ открыт: проксирование работает на этой же машине и ходит на
  127.0.0.1:${PORT}. Видят адрес только устройства вашего tailnet.

  Выключить: pnpm remote:off
`);
