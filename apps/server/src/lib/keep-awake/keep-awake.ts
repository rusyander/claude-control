import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Не давать ОС уснуть, пока идёт локальный прогон (L4b).
 *
 * Зачем. Ночная задача на локальной модели — часы работы без человека. Ноутбук или
 * настольная машина по таймеру простоя усыпляют систему, процесс сервера моделей и CLI
 * замирают, а по пробуждении сеть и видеокарта в другом состоянии: прогон умирает «сам».
 * Пока прогон идёт, панель держит у ОС запрет на сон системы (экран гаснуть может).
 *
 * Как. Отдельный процесс-помощник, а не вызов из Node: у `SetThreadExecutionState` нет
 * привязки в стандартной библиотеке, а запрет принадлежит потоку, который его поставил.
 * Помощник живёт, пока нужен, и снимается убийством — запрет уходит вместе с ним. Помощник
 * следит за номером панели: упала панель — запрет снят, а не завис навсегда.
 *   - Windows: PowerShell зовёт `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`.
 *   - macOS: `caffeinate -i -w <pid панели>`.
 *   - Linux: `systemd-inhibit --what=sleep:idle … tail --pid=<pid панели> -f /dev/null`.
 * Чего нет в системе (контейнер, WSL без systemd) — честное «не поддерживается»: прогон идёт,
 * панель об этом молчит в журнале один раз и не пытается снова.
 */

/** Сколько ждём между перезапусками помощника, который сам вышел или не запустился. */
export const AWAKE_RETRY_MS = 60_000;
/** Помощник, вышедший быстрее этого, — не рабочий: считаем попытку неудачной. */
const AWAKE_MIN_LIFE_MS = 2_000;
/** После стольких быстрых выходов подряд помощника считаем недоступным до перезапуска панели. */
const AWAKE_MAX_FAST_EXITS = 3;

export interface AwakeCommand {
  command: string;
  args: string[];
}

/** Команда помощника под платформу; `undefined` — платформа не поддерживается. */
export function awakeCommand(
  platform: NodeJS.Platform,
  panelPid: number,
): AwakeCommand | undefined {
  if (platform === 'win32') {
    // 0x80000001 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED; в PowerShell шестнадцатеричный литерал —
    // знаковый Int32, поэтому число десятичное и приведено к uint32.
    const script = [
      '$sig = \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);\'',
      '$api = Add-Type -MemberDefinition $sig -Name Awake -Namespace AgentDeck -PassThru',
      'while ($true) {',
      '  [void]$api::SetThreadExecutionState([uint32]2147483649)',
      '  Start-Sleep -Seconds 15',
      `  if (-not (Get-Process -Id ${panelPid} -ErrorAction SilentlyContinue)) { break }`,
      '}',
    ].join('\n');
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
    };
  }
  if (platform === 'darwin') return { command: 'caffeinate', args: ['-i', '-w', String(panelPid)] };
  if (platform === 'linux') {
    return {
      command: 'systemd-inhibit',
      args: [
        '--what=sleep:idle',
        '--who=agentdeck',
        '--why=local model run',
        '--mode=block',
        'tail',
        `--pid=${panelPid}`,
        '-f',
        '/dev/null',
      ],
    };
  }
  return undefined;
}

export interface KeepAwakeDeps {
  platform?: NodeJS.Platform;
  /** Номер панели — помощник держит запрет, пока он жив. */
  pid?: number;
  /** Запуск помощника; проверки подставляют своё. */
  spawnHelper?: (command: string, args: string[]) => Pick<ChildProcess, 'kill' | 'on' | 'once'>;
  now?: () => number;
  log: (message: string, error?: unknown) => void;
}

export interface KeepAwakeStatus {
  /** Запрет на сон стоит прямо сейчас. */
  held: boolean;
  /** Платформа и система его умеют (пока не доказано обратное). */
  supported: boolean;
}

export interface KeepAwake {
  /** Нужен ли запрет сейчас; вызывается часто, ничего не делает, если состояние не менялось. */
  sync(wanted: boolean): void;
  status(): KeepAwakeStatus;
  /** Снять запрет и забыть желание (выход панели). */
  stop(): void;
}

export function createKeepAwake(deps: KeepAwakeDeps): KeepAwake {
  const platform = deps.platform ?? process.platform;
  const pid = deps.pid ?? process.pid;
  const now = deps.now ?? Date.now;
  const launch =
    deps.spawnHelper ??
    ((command: string, args: string[]) =>
      spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: false }));
  const command = awakeCommand(platform, pid);

  let helper: Pick<ChildProcess, 'kill' | 'on' | 'once'> | undefined;
  let startedAt = 0;
  let wanted = false;
  let fastExits = 0;
  let retryAt = 0;
  let unsupported = command === undefined;
  let warned = false;

  const warnOnce = (message: string, error?: unknown): void => {
    if (warned) return;
    warned = true;
    deps.log(message, error);
  };

  function release(): void {
    const current = helper;
    helper = undefined;
    if (!current) return;
    // Помощник отработал как следует — ранние выходы прошлого к делу не относятся.
    if (now() - startedAt >= AWAKE_MIN_LIFE_MS) fastExits = 0;
    try {
      current.kill();
    } catch {
      // Уже вышел: запрета нет, чего и добивались.
    }
  }

  function acquire(): void {
    if (!command || unsupported || helper || now() < retryAt) return;
    let child: Pick<ChildProcess, 'kill' | 'on' | 'once'>;
    try {
      child = launch(command.command, command.args);
    } catch (error) {
      unsupported = true;
      warnOnce('keep-awake: helper did not start', error);
      return;
    }
    helper = child;
    startedAt = now();
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (helper !== child) return;
      helper = undefined;
      // Нет самой команды — навсегда; прочее — повторим позже.
      if (error.code === 'ENOENT') unsupported = true;
      else retryAt = now() + AWAKE_RETRY_MS;
      warnOnce('keep-awake: helper failed', error);
    });
    child.once('exit', () => {
      if (helper !== child) return;
      helper = undefined;
      // Вышел сам, пока запрет был нужен: слишком быстро — не рабочий помощник.
      if (now() - startedAt >= AWAKE_MIN_LIFE_MS) fastExits = 0;
      else {
        fastExits += 1;
        retryAt = now() + AWAKE_RETRY_MS;
        if (fastExits >= AWAKE_MAX_FAST_EXITS) {
          unsupported = true;
          warnOnce('keep-awake: helper keeps exiting at once, giving up');
        }
      }
    });
  }

  return {
    sync(next) {
      wanted = next;
      if (wanted) acquire();
      else release();
    },
    status: () => ({ held: Boolean(helper) && wanted, supported: !unsupported }),
    stop() {
      wanted = false;
      release();
    },
  };
}
