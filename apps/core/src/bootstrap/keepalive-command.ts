import { fileURLToPath } from 'node:url';
import { CORE_BUSY_EXIT_ENV, CORE_HOME_BUSY_EXIT } from '@agentdeck/contracts/core/supervisor';
import { defaultCoreHome } from '../platform/core-home.ts';
import {
  installKeepalive,
  keepalivePath,
  removeKeepalive,
  validateKeepalive,
  type KeepaliveDeps,
  type KeepaliveSpec,
} from '../platform/keepalive.ts';
import { currentOs, homeDir } from '../platform/os-kind.ts';

/**
 * Команда автозапуска ядра (09 §keepalive, P57): `node src/index.ts keepalive install|remove|status
 * [--name <имя>] [--home <дом ядра>] [--disabled]`. Ставит на ОС задачу входа (Планировщик,
 * юнит systemd, LaunchAgent), которая запускает ЭТО ядро: тот же node, тот же `index.ts`, дом —
 * аргументом `--home` (переменные окружения задачи Планировщика не несёт). Сама команда ядро не
 * загружает и в `procs.json` не пишется. Что требует прав человека (linger, crontab), только
 * названо в выводе.
 */

export const KEEPALIVE_COMMAND = 'keepalive';
export const DEFAULT_KEEPALIVE_NAME = 'agentdeck-core';
export const HOME_FLAG = '--home';

const ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));
const CORE_DIR = fileURLToPath(new URL('../../', import.meta.url));

export interface KeepaliveArgs {
  action: 'install' | 'remove' | 'status';
  name: string;
  home: string;
  enabled: boolean;
}

export function parseKeepaliveArgs(argv: readonly string[]): KeepaliveArgs | { error: string } {
  const [action, ...rest] = argv;
  if (action !== 'install' && action !== 'remove' && action !== 'status') {
    return { error: `usage: keepalive install|remove|status [--name N] [--home DIR] [--disabled]` };
  }
  let name = DEFAULT_KEEPALIVE_NAME;
  let home = defaultCoreHome();
  let enabled = true;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--disabled') enabled = false;
    else if (flag === '--name' || flag === HOME_FLAG) {
      const value = rest[i + 1];
      if (value === undefined || value === '') return { error: `${flag} needs a value` };
      if (flag === '--name') name = value;
      else home = value;
      i += 1;
    } else return { error: `unknown argument: ${flag}` };
  }
  return { action, name, home, enabled };
}

/** Запись автозапуска: абсолютный node (у фоновых процессов PATH урезан), вход ядра, дом. */
export function coreKeepaliveSpec(
  args: Pick<KeepaliveArgs, 'name' | 'home' | 'enabled'>,
): KeepaliveSpec {
  return {
    name: args.name,
    description: 'agentdeck core: task execution core, started at logon',
    command: process.execPath,
    args: ['--experimental-strip-types', '--no-warnings', ENTRY, HOME_FLAG, args.home],
    cwd: CORE_DIR,
    // Лишнее ядро при живом первом уходит с кодом 0: иначе systemd и launchd перезапускают его
    // без конца (Планировщик Windows окружения не несёт, но и не перезапускает).
    env: { [CORE_BUSY_EXIT_ENV]: '0' },
    enabled: args.enabled,
  };
}

/** Код выхода ядра из занятого дома: 0 под автозапуском ОС, иначе «дом занят» для надзора панели. */
export function busyExitCode(env: NodeJS.ProcessEnv): number {
  return env[CORE_BUSY_EXIT_ENV] === '0' ? 0 : CORE_HOME_BUSY_EXIT;
}

/** Код выхода: 0 — сделано, 1 — отказ (причина в `err`), 2 — неверные аргументы. */
export async function runKeepaliveCommand(
  argv: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void; deps?: KeepaliveDeps },
): Promise<number> {
  const args = parseKeepaliveArgs(argv);
  if ('error' in args) {
    io.err(args.error);
    return 2;
  }
  const deps = io.deps ?? {};
  if (args.action === 'install') {
    const got = await installKeepalive(coreKeepaliveSpec(args), deps);
    for (const note of got.notes) io.out(`note: ${note}`);
    if (!got.ok) {
      io.err(`keepalive install failed: ${got.reason}`);
      return 1;
    }
    io.out(`keepalive installed: ${got.path}`);
    return 0;
  }
  if (args.action === 'remove') {
    const got = await removeKeepalive(args.name, deps);
    for (const note of got.notes) io.out(`note: ${note}`);
    if (!got.ok) {
      io.err(`keepalive remove failed: ${got.reason}`);
      return 1;
    }
    io.out(`keepalive removed: ${got.path}`);
    return 0;
  }
  const os = deps.os ?? currentOs();
  const file = keepalivePath(args.name, os, deps.home ?? homeDir(process.env, os));
  const state = await validateKeepalive(file, os, deps.run);
  if (!('value' in state)) {
    io.err(
      `keepalive not registered or not valid: ${'unknown' in state ? state.unknown : 'absent'}`,
    );
    return 1;
  }
  io.out(`keepalive registered: ${file}`);
  return 0;
}

/** Дом ядра из `--home <dir>` в argv процесса ядра (так его запускает автозапуск). */
export function homeFromArgv(argv: readonly string[]): string | undefined {
  const at = argv.indexOf(HOME_FLAG);
  const value = at >= 0 ? argv[at + 1] : undefined;
  return value === undefined || value === '' ? undefined : value;
}
