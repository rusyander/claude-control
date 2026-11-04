import { execFile } from 'node:child_process';
import type { CoreSupervisorStatus } from '@agentdeck/contracts/core/supervisor';
import { CORE_ENTRY } from './launch.ts';

/**
 * Автозапуск ядра при входе в систему — тумблер приложения над командой ядра
 * `index.ts keepalive install|remove|status --home <дом>` (P57: Планировщик Windows, юнит
 * systemd, LaunchAgent macOS). Панель кода ядра не тянет (граница depcruise) — только
 * запускает его вход отдельным процессом и читает код выхода.
 *
 * Код выхода команды: 0 — сделано / запись есть, 1 — нет записи или отказ ОС, 2 — неверные
 * аргументы. Не запустилась вовсе (нет node, ОС без механизма) — `unsupported`.
 */

export type AutostartAction = 'install' | 'remove' | 'status';

export interface AutostartRun {
  code: number | null;
  out: string;
}

export type AutostartRunner = (args: readonly string[]) => Promise<AutostartRun>;

export const runCoreCommand: AutostartRunner = (args) =>
  new Promise((done) => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', CORE_ENTRY, ...args],
      { timeout: 60_000, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        done({ code, out: `${stdout}${stderr}`.trim() });
      },
    );
  });

/**
 * Имя записи автозапуска в ОС. Без переменной — имя ядра по умолчанию (`agentdeck-core`); проверка
 * на одноразовом стенде задаёт своё, чтобы не тронуть запись человека в Планировщике.
 */
export const CORE_AUTOSTART_NAME_ENV = 'AGENTDECK_CORE_AUTOSTART_NAME';

export function autostartArgs(action: AutostartAction, home: string, name?: string): string[] {
  return ['keepalive', action, '--home', home, ...(name ? ['--name', name] : [])];
}

export interface CoreAutostart {
  /** Последнее известное состояние; до первой сверки — `off`. */
  state(): CoreSupervisorStatus['autostart'];
  refresh(): Promise<CoreSupervisorStatus['autostart']>;
  set(on: boolean): Promise<{ ok: boolean; state: CoreSupervisorStatus['autostart']; out: string }>;
}

export function createCoreAutostart(
  home: () => string,
  run: AutostartRunner = runCoreCommand,
  name?: string,
): CoreAutostart {
  let known: CoreSupervisorStatus['autostart'] = 'off';
  const refresh = async (): Promise<CoreSupervisorStatus['autostart']> => {
    const got = await run(autostartArgs('status', home(), name));
    known = got.code === 0 ? 'on' : got.code === 1 ? 'off' : 'unsupported';
    return known;
  };
  return {
    state: () => known,
    refresh,
    set: async (on) => {
      const got = await run(autostartArgs(on ? 'install' : 'remove', home(), name));
      const state = await refresh();
      return { ok: got.code === 0, state, out: got.out };
    },
  };
}
