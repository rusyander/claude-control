import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

/**
 * Где панель видна снаружи — вопрос к Tailscale, а не к панели.
 *
 * Сервер как слушал петлю, так и слушает: `tailscale serve` живёт на той же
 * машине и проксирует на `127.0.0.1`, поэтому привязку менять не нужно вовсе, а
 * порт наружу не публикуется. Здесь мы только СПРАШИВАЕМ Tailscale, как машина
 * называется в сети и включён ли serve, — чтобы человеку не пришлось искать своё
 * имя руками и переписывать его в телефон.
 */

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;

/** Ставится в PATH не всегда — на Windows чаще лежит в Program Files. */
const WINDOWS_PATHS = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
];

function binary(): string {
  if (process.platform === 'win32') {
    const found = WINDOWS_PATHS.find((path) => existsSync(path));
    if (found) return found;
  }
  return 'tailscale';
}

async function run(args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(binary(), args, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  } catch {
    // Не установлен, не запущен, не залогинен — для нас это одно и то же:
    // адреса нет, и предлагать его нечего.
    return undefined;
  }
}

export interface TailscaleInfo {
  /** `https://<машина>.<tailnet>.ts.net` или пусто, если имени нет. */
  url: string;
  /** Проксирование включено прямо сейчас. */
  serveActive: boolean;
}

/**
 * Имя этой машины в tailnet и состояние serve.
 *
 * `Self.DNSName` приходит с точкой на конце (это полное имя в терминах DNS) —
 * её убираем, иначе адрес в QR-коде будет с лишним символом.
 */
export async function detectTailscale(): Promise<TailscaleInfo> {
  const status = await run(['status', '--json']);
  if (!status) return { url: '', serveActive: false };

  let dnsName: string;
  try {
    const parsed = JSON.parse(status) as { Self?: { DNSName?: string } };
    dnsName = (parsed.Self?.DNSName ?? '').replace(/\.$/, '');
  } catch {
    return { url: '', serveActive: false };
  }

  const serve = await run(['serve', 'status', '--json']);
  // Пустая конфигурация приходит как `{}` или literal null — и то и другое
  // означает «ничего не проксируется».
  const serveActive = Boolean(serve && serve.trim() && !/^\s*(null|\{\s*\})\s*$/.test(serve));

  return { url: dnsName ? `https://${dnsName}` : '', serveActive };
}
