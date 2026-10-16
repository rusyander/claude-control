import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, win32 } from 'node:path';
import type {
  PowerAction,
  PowerOption,
  PowerStatus,
  PowerUnavailableReason,
} from '@agentdeck/contracts';

/**
 * Гибернация и сон машины с панелью — по просьбе с телефона.
 *
 * Что есть на какой системе и что делаем:
 *   - Windows: гибернация `shutdown /h`. Сна не предлагаем: при включённой
 *     гибернации `SetSuspendState` сам уходит в неё, а без неё сон — это память
 *     под питанием, которую разряд батареи у ноутбука сотрёт. Включена ли
 *     гибернация — по реестру (`HibernateEnabled`, иначе `HibernateEnabledDefault`),
 *     а не по выводу `powercfg /a`: тот переведён на язык системы.
 *   - macOS: `pmset sleepnow` без пароля. Насколько это «гибернация», решает
 *     `hibernatemode` (его показываем): 25 — память на диск и питание снято, 3 —
 *     сон с копией памяти на диске (у ноутбуков по умолчанию), 0 — обычный сон.
 *     Сменить режим может только человек (`sudo pmset -a hibernatemode 25`).
 *   - Linux: `systemctl hibernate`, если logind отвечает CanHibernate = yes
 *     (нужны swap и настроенное resume — есть не везде), иначе `systemctl suspend`.
 *     «challenge» — система спросит пароль, которого с телефона не ввести:
 *     считаем недоступным. `--no-ask-password` — не ждать пароля, даже если
 *     ответ logind устарел; запретов (`systemd-inhibit --mode=block`: обновление
 *     пакетов, запись диска) НЕ обходим — `-i` нет намеренно, решает система.
 * Выключения нет: включить машину обратно телефон не может.
 *
 * Утилиты Windows и macOS — полным путём: Windows ищет exe по имени сначала в
 * текущем каталоге процесса, и подложенный туда `shutdown.exe` запустился бы
 * вместо системного; `/usr/bin/pmset` на macOS под SIP. На Linux — по PATH:
 * у NixOS и ей подобных `/usr/bin` нет, а текущий каталог execvp не смотрит.
 */

export interface CommandResult {
  code: number;
  stdout: string;
}

/** Запуск утилиты без оболочки; `code` −1 — утилиты нет или она не запустилась. */
export type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

export interface PowerProbe {
  platform: NodeJS.Platform;
  run: RunCommand;
  exists: (path: string) => boolean;
  /** Системный диск Windows (`C:`) — там лежит hiberfil.sys. */
  systemDrive: string;
  /** Каталог Windows (`C:\Windows`) — оттуда, и только оттуда, берём reg.exe и shutdown.exe. */
  systemRoot: string;
}

/** `C:\Windows\System32\<name>` — системная утилита Windows полным путём. */
export function windowsTool(systemRoot: string, name: string): string {
  return win32.join(systemRoot, 'System32', name);
}

const PMSET = '/usr/bin/pmset';

const POWER_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power';

/** `    HibernateEnabled    REG_DWORD    0x1` → 1; значения нет — undefined. */
export function parseRegDword(stdout: string, name: string): number | undefined {
  const line = stdout.split(/\r?\n/).find((row) => row.trim().startsWith(`${name} `));
  const match = line?.match(/REG_DWORD\s+0x([0-9a-f]+)/i);
  return match?.[1] ? Number.parseInt(match[1], 16) : undefined;
}

/** Строка ` hibernatemode        3` из `pmset -g` → 3. */
export function parsePmsetHibernateMode(stdout: string): number | undefined {
  const match = stdout.match(/^\s*hibernatemode\s+(\d+)/m);
  return match ? Number(match[1]) : undefined;
}

/** Ответ `busctl call … CanHibernate`: `s "yes"` → `yes`. */
export function parseLogindAnswer(stdout: string): string | undefined {
  return stdout.match(/^s\s+"([a-z-]+)"/m)?.[1];
}

const available = (action: PowerAction): PowerOption => ({ action, available: true });
const missing = (action: PowerAction, reason: PowerUnavailableReason): PowerOption => ({
  action,
  available: false,
  reason,
});

async function windowsOptions(probe: PowerProbe): Promise<PowerOption[]> {
  const read = async (name: string): Promise<number | undefined> => {
    const result = await probe.run(windowsTool(probe.systemRoot, 'reg.exe'), [
      'query',
      POWER_KEY,
      '/v',
      name,
    ]);
    return result.code === 0 ? parseRegDword(result.stdout, name) : undefined;
  };
  const explicit = await read('HibernateEnabled');
  const flag = explicit ?? (await read('HibernateEnabledDefault'));
  // Реестр промолчал совсем (урезанная сборка) — судим по файлу гибернации.
  const enabled =
    flag === undefined ? probe.exists(join(`${probe.systemDrive}\\`, 'hiberfil.sys')) : flag === 1;
  return [enabled ? available('hibernate') : missing('hibernate', 'disabled')];
}

async function macOptions(probe: PowerProbe): Promise<{ options: PowerOption[]; mode?: number }> {
  const result = await probe.run(PMSET, ['-g']);
  if (result.code !== 0) return { options: [missing('sleep', 'no-tool')] };
  return { options: [available('sleep')], mode: parsePmsetHibernateMode(result.stdout) };
}

async function linuxOptions(probe: PowerProbe): Promise<PowerOption[]> {
  const ask = async (method: string): Promise<string | undefined> => {
    const result = await probe.run('busctl', [
      'call',
      'org.freedesktop.login1',
      '/org/freedesktop/login1',
      'org.freedesktop.login1.Manager',
      method,
    ]);
    return result.code === 0 ? parseLogindAnswer(result.stdout) : undefined;
  };
  const hibernate = await ask('CanHibernate');
  if (hibernate === undefined) {
    // Нет logind (контейнер, WSL без systemd) — спрашивать систему нечем.
    return [missing('hibernate', 'no-tool'), missing('sleep', 'no-tool')];
  }
  const suspend = await ask('CanSuspend');
  return [
    hibernate === 'yes' ? available('hibernate') : missing('hibernate', 'not-allowed'),
    suspend === 'yes' ? available('sleep') : missing('sleep', 'not-allowed'),
  ];
}

/** Что умеет эта машина. Ничего не меняет — только спрашивает систему. */
export async function probePower(
  probe: PowerProbe,
): Promise<Pick<PowerStatus, 'platform' | 'options' | 'macHibernateMode'>> {
  if (probe.platform === 'win32') {
    return { platform: 'win32', options: await windowsOptions(probe) };
  }
  if (probe.platform === 'darwin') {
    const mac = await macOptions(probe);
    return { platform: 'darwin', options: mac.options, macHibernateMode: mac.mode };
  }
  if (probe.platform === 'linux') {
    return { platform: 'linux', options: await linuxOptions(probe) };
  }
  return {
    platform: 'other',
    options: [missing('hibernate', 'unsupported'), missing('sleep', 'unsupported')],
  };
}

/** Команда действия; `undefined` — на этой платформе такого действия нет. */
export function powerCommand(
  probe: Pick<PowerProbe, 'platform' | 'systemRoot'>,
  action: PowerAction,
): { command: string; args: string[] } | undefined {
  if (probe.platform === 'win32' && action === 'hibernate')
    return { command: windowsTool(probe.systemRoot, 'shutdown.exe'), args: ['/h'] };
  if (probe.platform === 'darwin' && action === 'sleep')
    return { command: PMSET, args: ['sleepnow'] };
  if (probe.platform === 'linux') {
    const verb = action === 'hibernate' ? 'hibernate' : 'suspend';
    return { command: 'systemctl', args: ['--no-ask-password', verb] };
  }
  return undefined;
}

/** Настоящий запуск: без оболочки, с таймаутом — зависшая утилита не держит запрос. */
export const runCommand: RunCommand = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout) });
      const code = typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

/** Пробник этой машины. */
export function systemPowerProbe(): PowerProbe {
  return {
    platform: process.platform,
    run: runCommand,
    exists: existsSync,
    systemDrive: process.env.SystemDrive ?? 'C:',
    systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
  };
}

/**
 * Выполнить действие. Итог — код выхода и вывод ошибки: гибернация на Windows и
 * сон на macOS возвращаются уже после пробуждения, отказ — сразу.
 */
export function executePower(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stderr = '';
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => resolve({ code: -1, stdout: error.message }));
    child.once('exit', (code) => resolve({ code: code ?? -1, stdout: stderr.trim() }));
  });
}
