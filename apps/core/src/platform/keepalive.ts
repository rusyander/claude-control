import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { currentOs, homeDir, type Fact, type OsKind } from './os-kind.ts';
import { quoteWindowsArg } from './spawn.ts';
import { runTool, system32, type ToolRun } from './run-tool.ts';

/**
 * Автозапуск ядра при входе (09 §keepalive, P57): файл на ОС — задача Планировщика
 * (Windows), пользовательский юнит systemd (Linux), LaunchAgent (macOS). Ядро пишет файл и
 * регистрирует его; то, что требует прав или решения человека, только НАЗЫВАЕТ:
 * `loginctl enable-linger` (без него юнит умирает при выходе из сеанса) и строку `@reboot`
 * для crontab, когда systemd нет. Здесь нет имён CLI: команда приходит целиком снаружи.
 */

export interface KeepaliveSpec {
  /** Имя задачи / юнита / метки: латиница, цифры, `.`, `_`, `-`. */
  name: string;
  description: string;
  /** Абсолютный путь программы — у фоновых процессов PATH урезан. */
  command: string;
  args: string[];
  cwd: string;
  /** Только несекретное: файл автозапуска читают все программы пользователя. */
  env?: Record<string, string>;
  /** `false` — заведено, но не срабатывает (проверка на живой машине). */
  enabled?: boolean;
}

export interface KeepaliveFile {
  path: string;
  /** Байты на диск: XML задачи Windows — UTF-16LE с BOM, иначе UTF-8. */
  bytes: Buffer;
  text: string;
}

export interface KeepaliveDeps {
  os?: OsKind;
  home?: string;
  /** Windows: `ДОМЕН\имя` — триггер входа со своим UserId заводится без UAC. */
  user?: string;
  uid?: number;
  run?: (file: string, args: readonly string[]) => Promise<ToolRun>;
  /** Куда класть временный XML задачи Windows. */
  scratchDir?: string;
}

export type KeepaliveOutcome =
  { ok: true; path: string; notes: string[] } | { ok: false; reason: string; notes: string[] };

const NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Задача на вход текущего пользователя (схема Task Scheduler 1.2). */
export function taskSchedulerXml(spec: KeepaliveSpec, user: string): string {
  const enabled = spec.enabled === false ? 'false' : 'true';
  const args = spec.args.map(quoteWindowsArg).join(' ');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>${xmlEscape(spec.description)}</Description></RegistrationInfo>`,
    '  <Triggers>',
    '    <LogonTrigger>',
    `      <Enabled>${enabled}</Enabled>`,
    `      <UserId>${xmlEscape(user)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xmlEscape(user)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    // PT0S — без предела: ядро живёт весь сеанс, а не час по умолчанию.
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    `    <Enabled>${enabled}</Enabled>`,
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlEscape(spec.command)}</Command>`,
    ...(args ? [`      <Arguments>${xmlEscape(args)}</Arguments>`] : []),
    `      <WorkingDirectory>${xmlEscape(spec.cwd)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** Слово systemd в двойных кавычках: `\` и `"` экранируются, `%` и `$` удваиваются. */
export function systemdQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$$$');
  return `"${escaped}"`;
}

/**
 * Значение `Environment=` (F-111): `$` там не раскрывается, и удвоенный `$$` дошёл бы до
 * процесса как два знака — поэтому только `\`, `"`, перевод строки и `%`.
 */
export function systemdEnvQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/%/g, '%%');
  return `"${escaped}"`;
}

// eslint-disable-next-line no-control-regex -- управляющие знаки и есть то, что ищется
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * `WorkingDirectory=` кавычек не знает (F-111): перевод строки дописал бы в юнит свою строку
 * (`ExecStartPre=…`), хвостовой `\` склеил бы следующую. Такой путь — отказ, не экранирование.
 */
function systemdPath(value: string): string {
  if (CONTROL.test(value) || value.endsWith('\\'))
    throw new Error(
      `WorkingDirectory not representable in a systemd unit: ${JSON.stringify(value)}`,
    );
  return value.replace(/%/g, '%%');
}

/** Описание — одна строка: управляющие знаки → пробел, хвостовой `\` (склейка строк) снят. */
function systemdLine(value: string): string {
  return value
    .replace(new RegExp(CONTROL.source, 'g'), ' ')
    .replace(/\\+$/, '')
    .replace(/%/g, '%%');
}

export function systemdUnit(spec: KeepaliveSpec): string {
  const cwd = systemdPath(spec.cwd);
  const env = Object.entries(spec.env ?? {}).map(
    ([key, value]) => `Environment=${systemdEnvQuote(`${key}=${value}`)}`,
  );
  return [
    '[Unit]',
    `Description=${systemdLine(spec.description)}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${[spec.command, ...spec.args].map(systemdQuote).join(' ')}`,
    `WorkingDirectory=${cwd}`,
    ...env,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Слово sh в одинарных кавычках. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Строка `@reboot` для crontab, когда systemd нет: ядро её называет, само не ставит. */
export function cronLine(spec: KeepaliveSpec): string {
  const env = Object.entries(spec.env ?? {}).map(([key, value]) => `${key}=${shQuote(value)}`);
  const command = [spec.command, ...spec.args].map(shQuote).join(' ');
  // `%` в crontab — перевод строки; экранируется обратной чертой.
  return `@reboot cd ${shQuote(spec.cwd)} && ${[...env, command].join(' ')}`.replace(/%/g, '\\%');
}

export function launchdPlist(spec: KeepaliveSpec): string {
  const string = (value: string) => `<string>${xmlEscape(value)}</string>`;
  const env = Object.entries(spec.env ?? {});
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${string(spec.name)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[spec.command, ...spec.args].map((arg) => `    ${string(arg)}`),
    '  </array>',
    `  <key>WorkingDirectory</key>${string(spec.cwd)}`,
    ...(env.length
      ? [
          '  <key>EnvironmentVariables</key>',
          '  <dict>',
          ...env.map(([key, value]) => `    <key>${xmlEscape(key)}</key>${string(value)}`),
          '  </dict>',
        ]
      : []),
    `  <key>RunAtLoad</key><${spec.enabled === false ? 'false' : 'true'}/>`,
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function keepalivePath(name: string, os: OsKind, home: string): string {
  if (os === 'darwin') return path.posix.join(home, 'Library', 'LaunchAgents', `${name}.plist`);
  if (os === 'linux') return path.posix.join(home, '.config', 'systemd', 'user', `${name}.service`);
  // Задача живёт в Планировщике; путь — её имя в корне библиотеки.
  return `\\${name}`;
}

export function renderKeepalive(
  spec: KeepaliveSpec,
  os: OsKind,
  context: { home: string; user: string },
): KeepaliveFile {
  if (!NAME.test(spec.name)) throw new Error(`keepalive name not allowed: ${spec.name}`);
  const file = keepalivePath(spec.name, os, context.home);
  if (os === 'win32') {
    const text = taskSchedulerXml(spec, context.user);
    // schtasks читает XML задачи только в UTF-16 с меткой порядка байт.
    const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
    return {
      path: file,
      text,
      bytes: Buffer.concat([UTF16LE_BOM, Buffer.from(text, 'utf16le')]),
    };
  }
  const text = os === 'darwin' ? launchdPlist(spec) : systemdUnit(spec);
  return { path: file, text, bytes: Buffer.from(text, 'utf8') };
}

/** `loginctl show-user <u> --property=Linger --value` → `yes` / `no`. */
export function parseLinger(stdout: string): boolean | undefined {
  const value = stdout.trim().toLowerCase();
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return undefined;
}

export async function lingerState(
  user: string,
  run: KeepaliveDeps['run'] = runTool,
): Promise<Fact<boolean>> {
  const result = await run('loginctl', ['show-user', user, '--property=Linger', '--value']);
  if (!result.ok) return { unknown: `loginctl: ${result.stderr?.trim() || result.reason}` };
  const linger = parseLinger(result.stdout);
  return linger === undefined
    ? { unknown: `loginctl: «${result.stdout.trim()}»` }
    : { value: linger };
}

export function lingerNote(user: string): string {
  return `linger off: the unit stops at logout — run \`loginctl enable-linger ${user}\` (needs the user's decision)`;
}

/** Проверка файла средством ОС; средства нет — `unknown`, не «годен». */
export async function validateKeepalive(
  file: string,
  os: OsKind,
  run: KeepaliveDeps['run'] = runTool,
): Promise<Fact<true>> {
  const [tool, args] =
    os === 'darwin'
      ? ['plutil', ['-lint', file]]
      : os === 'linux'
        ? ['systemd-analyze', ['--user', 'verify', file]]
        : [system32('schtasks.exe'), ['/Query', '/TN', file.replace(/^\\/, ''), '/XML']];
  const result = await run(tool, args as string[]);
  if (!result.ok)
    return { unknown: `${path.basename(tool)}: ${result.stderr?.trim() || result.reason}` };
  return { value: true };
}

function resolveDeps(deps: KeepaliveDeps): Required<Omit<KeepaliveDeps, 'uid'>> & { uid?: number } {
  const os = deps.os ?? currentOs();
  const env = process.env;
  const user =
    deps.user ??
    (os === 'win32'
      ? env.USERDOMAIN
        ? `${env.USERDOMAIN}\\${env.USERNAME ?? ''}`
        : (env.USERNAME ?? '')
      : (env.USER ?? env.LOGNAME ?? ''));
  return {
    os,
    home: deps.home ?? homeDir(env, os),
    user,
    run: deps.run ?? runTool,
    scratchDir: deps.scratchDir ?? tmpdir(),
    ...(deps.uid !== undefined
      ? { uid: deps.uid }
      : typeof process.getuid === 'function'
        ? { uid: process.getuid() }
        : {}),
  };
}

const failed = (step: string, result: ToolRun): string =>
  `${step}: ${result.ok ? '' : result.stderr?.trim() || result.reason}`;

export async function installKeepalive(
  spec: KeepaliveSpec,
  options: KeepaliveDeps = {},
): Promise<KeepaliveOutcome> {
  const deps = resolveDeps(options);
  const file = renderKeepalive(spec, deps.os, deps);
  const notes: string[] = [];
  if (deps.os === 'win32') {
    if (!deps.user) return { ok: false, reason: 'no user name for the logon trigger', notes };
    const xml = path.join(deps.scratchDir, `${spec.name}.task.xml`);
    writeFileSync(xml, file.bytes);
    try {
      const result = await deps.run(system32('schtasks.exe'), [
        '/Create',
        '/TN',
        spec.name,
        '/XML',
        xml,
        '/F',
      ]);
      return result.ok
        ? { ok: true, path: file.path, notes }
        : { ok: false, reason: failed('schtasks /Create', result), notes };
    } finally {
      rmSync(xml, { force: true });
    }
  }
  if (deps.os === 'linux') {
    const probe = await deps.run('systemctl', ['--user', 'show-environment']);
    if (!probe.ok) {
      notes.push(`no systemd user instance — add to crontab: ${cronLine(spec)}`);
      return { ok: false, reason: failed('systemctl --user', probe), notes };
    }
    mkdirSync(path.posix.dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.bytes, { mode: 0o644 });
    for (const args of [
      ['daemon-reload'],
      ['enable', ...(spec.enabled === false ? [] : ['--now']), `${spec.name}.service`],
    ]) {
      const result = await deps.run('systemctl', ['--user', ...args]);
      if (!result.ok)
        return { ok: false, reason: failed(`systemctl --user ${args[0]}`, result), notes };
    }
    const linger = await lingerState(deps.user, deps.run);
    if (!('value' in linger) || !linger.value) notes.push(lingerNote(deps.user));
    return { ok: true, path: file.path, notes };
  }
  if (deps.uid === undefined) return { ok: false, reason: 'no uid for launchctl', notes };
  mkdirSync(path.posix.dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.bytes, { mode: 0o644 });
  // Переустановка (F-111): загруженная задача отвергает bootstrap (ошибка 5) — сначала bootout;
  // «не загружена» — не отказ.
  await deps.run('launchctl', ['bootout', `gui/${deps.uid}/${spec.name}`]);
  const result = await deps.run('launchctl', ['bootstrap', `gui/${deps.uid}`, file.path]);
  return result.ok
    ? { ok: true, path: file.path, notes }
    : { ok: false, reason: failed('launchctl bootstrap', result), notes };
}

/** Снять регистрацию и файл; «уже нет» — не ошибка. */
export async function removeKeepalive(
  name: string,
  options: KeepaliveDeps = {},
): Promise<KeepaliveOutcome> {
  if (!NAME.test(name))
    return { ok: false, reason: `keepalive name not allowed: ${name}`, notes: [] };
  const deps = resolveDeps(options);
  const file = keepalivePath(name, deps.os, deps.home);
  if (deps.os === 'win32') {
    const result = await deps.run(system32('schtasks.exe'), ['/Delete', '/TN', name, '/F']);
    return result.ok
      ? { ok: true, path: file, notes: [] }
      : { ok: false, reason: failed('schtasks /Delete', result), notes: [] };
  }
  const result =
    deps.os === 'linux'
      ? await deps.run('systemctl', ['--user', 'disable', '--now', `${name}.service`])
      : await deps.run('launchctl', ['bootout', `gui/${deps.uid ?? ''}/${name}`]);
  rmSync(file, { force: true });
  if (deps.os === 'linux') await deps.run('systemctl', ['--user', 'daemon-reload']);
  return { ok: true, path: file, notes: result.ok ? [] : [failed('unregister', result)] };
}
