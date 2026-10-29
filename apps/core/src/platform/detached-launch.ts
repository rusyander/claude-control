import { spawn } from 'node:child_process';
import { currentOs, reasonOf, type OsKind } from './os-kind.ts';
import { pinEnv, quoteWindowsArg } from './spawn.ts';
import { encodePowerShell, psQuote } from './hidden-launch.ts';
import { powershellExe, runTool } from './run-tool.ts';

/**
 * Запуск процесса, который переживает своего запустившего (хост сессии — 01 §Sessions at
 * core death). POSIX: `detached` — своя сессия и группа, смерть ядра его не касается.
 *
 * Windows: `detached` отвязывает от консоли, но не от ЗАДАНИЯ: ядро, запущенное сторожем
 * или терминалом в задании без разрешения выхода, передаёт его потомку, и закрытие
 * задания уносит хост с CLI. libuv не ставит CREATE_BREAKAWAY_FROM_JOB, поэтому
 * `breakaway` — запуск службой WMI (`Win32_Process.Create`): родитель — `WmiPrvSE`,
 * задания ядра нет вовсе (перенос `live-relay-launch.mjs` сервера). Окружение такого
 * процесса — пользовательское окружение службы, а не переданное: хост берёт всё нужное
 * CLI из файла описания, своё окружение ему не служит. WMI закрыт политикой — отказ с
 * причиной; вызывающий решает, запускать ли обычным отвязанным способом.
 */

export interface DetachedSpec {
  /** Абсолютный путь исполняемого файла (node для хоста). */
  file: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Windows: вырваться из задания ядра через WMI. */
  breakaway?: boolean;
  os?: OsKind;
}

export type DetachedOutcome =
  { ok: true; pid: number; via: 'spawn' | 'wmi' } | { ok: false; reason: string };

/**
 * Окружение служебного процесса ядра (хост сессии, помощники): только системные переменные,
 * без которых node и temp работают. Ключи и переменные панели сюда не попадают — CLI
 * получает своё окружение из описания, а не от хоста.
 */
const HELPER_KEYS = [
  'PATH',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'LANG',
  'LC_ALL',
];

export function helperEnv(
  env: NodeJS.ProcessEnv = process.env,
  os: OsKind = currentOs(),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const wanted = HELPER_KEYS.some((name) =>
      os === 'win32' ? name.toLowerCase() === key.toLowerCase() : name === key,
    );
    if (wanted) out[key] = value;
  }
  return out;
}

export function wmiCreateScript(commandLine: string, cwd: string): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    '$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)}; CurrentDirectory = ${psQuote(cwd)}; ProcessStartupInformation = $s }`,
    '[Console]::Out.WriteLine("$($r.ReturnValue) $($r.ProcessId)")',
  ].join('; ');
}

export function parseWmiCreate(stdout: string): number | undefined {
  const [code, pid] = stdout.trim().split(/\s+/).map(Number);
  return code === 0 && pid !== undefined && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export async function launchDetached(spec: DetachedSpec): Promise<DetachedOutcome> {
  const os = spec.os ?? currentOs();
  if (os === 'win32' && spec.breakaway) {
    const commandLine = [spec.file, ...spec.args].map((part) => quoteWindowsArg(part)).join(' ');
    const run = await runTool(
      powershellExe(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodePowerShell(wmiCreateScript(commandLine, spec.cwd)),
      ],
      { timeoutMs: 30_000 },
    );
    if (!run.ok) return { ok: false, reason: `wmi: ${run.reason}` };
    const pid = parseWmiCreate(run.stdout);
    return pid
      ? { ok: true, pid, via: 'wmi' }
      : { ok: false, reason: `wmi refused: ${run.stdout.trim()}` };
  }
  try {
    const child = spawn(spec.file, [...spec.args], {
      cwd: spec.cwd,
      env: pinEnv(spec.env, os),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    const pid = await new Promise<number | string>((done) => {
      child.once('error', (error) => done(reasonOf(error)));
      child.once('spawn', () => done(child.pid ?? 'spawn returned no pid'));
    });
    child.unref();
    return typeof pid === 'number' ? { ok: true, pid, via: 'spawn' } : { ok: false, reason: pid };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}
