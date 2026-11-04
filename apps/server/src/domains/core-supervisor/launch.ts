import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHidden } from '../../lib/hidden-launch/hidden-launch.ts';
import { HOP_RECORD_ENV } from '../../lib/hop-recorder.mjs';
import type { SpawnedCore } from './core-supervisor.types.ts';

/**
 * Подъём ядра панелью (этап 10). Ядро — отдельный процесс и переживает панель:
 *
 * - POSIX: `detached` — своя сессия и группа процессов; вывод — в файлы дома ядра, а не в трубы
 *   панели: труба умершей панели отдала бы ядру EPIPE на первой же строке журнала;
 * - Windows: PowerShell `Start-Process -WindowStyle Hidden` (`lib/hidden-launch`). Прямой
 *   `detached` дал бы ядру DETACHED_PROCESS без консоли, и каждый git/CLI под ним открывал бы
 *   своё окно; внук панели выходит из её задания (SILENT_BREAKAWAY_OK) и переживает панель.
 *
 * Дом ядра — аргументом `--home` (так же его запускает автозапуск ОС): переменные окружения
 * Планировщик задач не несёт, а одна строка запуска на все пути проще сверять.
 */

export const CORE_ENTRY = fileURLToPath(new URL('../../../../core/src/index.ts', import.meta.url));
export const CORE_LOG_FILES = { out: 'core.out.log', err: 'core.err.log' } as const;
/** `0` — панель ядро не поднимает (стенды QA со своим ядром, тесты). */
export const CORE_SUPERVISE_ENV = 'AGENTDECK_CORE_SUPERVISE';

/** Переменные только панели: ядру они ни к чему, а порт панели в его окружении путал бы. */
const PANEL_ONLY = ['PORT', 'WEB_PORT', 'API_PORT', HOP_RECORD_ENV, CORE_SUPERVISE_ENV];

export function coreLaunchArgs(entry: string, home: string): string[] {
  return ['--experimental-strip-types', '--no-warnings', entry, '--home', home];
}

export function coreLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (PANEL_ONLY.some((name) => name.toUpperCase() === key.toUpperCase())) continue;
    out[key] = value;
  }
  return out;
}

export interface CoreLaunchSpec {
  home: string;
  entry?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
}

export async function launchCore(spec: CoreLaunchSpec): Promise<SpawnedCore> {
  const entry = spec.entry ?? CORE_ENTRY;
  const cwd = dirname(dirname(entry));
  const args = coreLaunchArgs(entry, spec.home);
  const env = coreLaunchEnv(spec.env ?? process.env);
  mkdirSync(spec.home, { recursive: true });
  const log = {
    out: join(spec.home, CORE_LOG_FILES.out),
    err: join(spec.home, CORE_LOG_FILES.err),
  };
  if ((spec.platform ?? process.platform) === 'win32') {
    return { pid: await launchHidden(process.execPath, args, env, log, cwd) };
  }
  const out = openSync(log.out, 'w');
  const err = openSync(log.err, 'w');
  try {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
      shell: false,
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
      child.once('exit', (code, signal) => done({ code, signal })),
    );
    const pid = await new Promise<number>((done, fail) => {
      child.once('error', fail);
      child.once('spawn', () =>
        child.pid ? done(child.pid) : fail(new Error('spawn returned no pid')),
      );
    });
    child.unref();
    return { pid, exited };
  } finally {
    closeSync(out);
    closeSync(err);
  }
}
