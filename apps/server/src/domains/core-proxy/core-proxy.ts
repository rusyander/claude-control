import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Где ядро и чем к нему стучаться (07 §Phases, фаза 2: минимальная прокладка панели). Ядро —
 * отдельный процесс: панель находит его по `<дом ядра>/procs.json` и говорит токеном ядра
 * `<дом ядра>/token` по HTTP на 127.0.0.1. Ни строки не пишет: перезапуск панели — это только
 * новое чтение этих двух файлов, журнал задач и сессии его не замечают (P23, F12).
 *
 * Читается на каждом запросе, а не при старте: ядро могло перезапуститься на другом порте.
 * Кода ядра здесь нет — граница панель/ядро держится правилом depcruise.
 */

export const CORE_HOME_ENV = 'AGENTDECK_CORE_HOME';

export function coreHomeOf(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CORE_HOME_ENV];
  if (override && override.trim() !== '') return resolve(override);
  return join(homedir(), '.agentdeck', 'core');
}

export interface CoreLocation {
  url: string;
  token: string;
  pid: number;
  build: string;
}

interface ProcRow {
  url?: unknown;
  pid?: unknown;
  build?: unknown;
  startedAt?: unknown;
}

export function locateCore(home: string): CoreLocation | { missing: string } {
  let procs: { cores?: ProcRow[] };
  let token: string;
  try {
    procs = JSON.parse(readFileSync(join(home, 'procs.json'), 'utf8')) as { cores?: ProcRow[] };
  } catch (error) {
    return { missing: `procs.json: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    token = readFileSync(join(home, 'token'), 'utf8').trim();
  } catch (error) {
    return { missing: `token: ${error instanceof Error ? error.message : String(error)}` };
  }
  // Несколько сборок разом (P83) — берём последнюю запущенную; выбор сборки — дело надзора.
  const newest = (procs.cores ?? [])
    .filter((c): c is ProcRow & { url: string; pid: number; startedAt: number } => {
      return (
        typeof c.url === 'string' && typeof c.pid === 'number' && typeof c.startedAt === 'number'
      );
    })
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!newest) return { missing: 'no core in procs.json' };
  if (!token) return { missing: 'token: empty' };
  return {
    url: newest.url.replace(/\/+$/, ''),
    token,
    pid: newest.pid,
    build: typeof newest.build === 'string' ? newest.build : '',
  };
}

export const FORWARDED_PEER_HEADER = 'x-agentdeck-peer-pid';

export interface CoreForward {
  method: 'GET' | 'POST';
  /** Путь API ядра с запросом (`/v1/nonce?page=…`). */
  path: string;
  body?: unknown;
  /**
   * pid процесса, приславшего запрос панели. Ставится ТОЛЬКО прокладкой, по таблице TCP;
   * заголовок клиента с тем же именем не пробрасывается никогда. 0 — пира узнать не вышло:
   * ядро сочтёт пересылку непроверенной и примет только подпись устройства.
   */
  peerPid?: number;
}

export async function forwardToCore(
  core: CoreLocation,
  call: CoreForward,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { authorization: `Bearer ${core.token}` };
  if (call.body !== undefined) headers['content-type'] = 'application/json';
  if (call.peerPid !== undefined) headers[FORWARDED_PEER_HEADER] = String(call.peerPid);
  const res = await fetch(`${core.url}${call.path}`, {
    method: call.method,
    headers,
    ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Не JSON — отдаём как есть.
  }
  return { status: res.status, body };
}
