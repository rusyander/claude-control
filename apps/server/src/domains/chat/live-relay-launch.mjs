#!/usr/bin/env node
/**
 * Пусковой процесс посредника: поднимает `live-relay.mjs` и сразу выходит.
 *
 * Зачем. `detached` отвязывает посредника от консоли и группы сервера, но не
 * от дерева: на Windows родителем посредника оставался сервер, и `taskkill /T`
 * сторожа (`tools/keepalive.mjs`), снимающий зависший сервер деревом, снимал
 * заодно всех посредников с их CLI — ровно то, ради чего посредник заведён.
 * Дерево `taskkill` строит по номеру родителя, а родитель посредника теперь —
 * этот процесс, умерший через миллисекунды: от сервера до посредника ветки нет.
 *
 * Задание libuv сервера (оно гасит неотвязанных детей, когда сервер умирает)
 * посредника не держит: он отвязан, а задание это — с тихим выходом для
 * потомков. Внешнее задание — того, кто запустил сервер, — посредник наследует,
 * если оно выхода не разрешает, а вырваться из него node не умеет
 * (CREATE_BREAKAWAY_FROM_JOB libuv не ставит). Поэтому на Windows посредника
 * заводит служба WMI (`Win32_Process.Create`): его родитель — `WmiPrvSE`, и
 * задания запустившего его нет вовсе. Не вышло (WMI закрыт политикой, нет
 * PowerShell) — обычный отвязанный запуск, как раньше. `AGENTDECK_RELAY_BREAKAWAY=0`
 * выключает WMI: тесты заводят посредников десятками, и секунда PowerShell на
 * каждого им ни к чему.
 *
 * argv: <relay script> <spec file>. В stdout — одна строка: pid посредника.
 */
/* global process */
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';

const [script, spec] = process.argv.slice(2);

/** Строка для PowerShell в одинарных кавычках: кавычка удваивается. */
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Посредник через WMI; pid или 0, если служба не завела процесс. */
function viaWmi() {
  const commandLine = [process.execPath, script ?? '', spec ?? '']
    .map((part) => `"${part}"`)
    .join(' ');
  const command = [
    '$ErrorActionPreference = "Stop"',
    '$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)}; CurrentDirectory = ${psQuote(process.cwd())}; ProcessStartupInformation = $s }`,
    '"$($r.ReturnValue) $($r.ProcessId)"',
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  const [code, pid] = (result.stdout ?? '').trim().split(/\s+/).map(Number);
  return code === 0 && pid > 0 ? pid : 0;
}

const wmiPid =
  process.platform === 'win32' && process.env.AGENTDECK_RELAY_BREAKAWAY !== '0' ? viaWmi() : 0;
if (wmiPid) {
  process.stdout.write(`${wmiPid}\n`, () => process.exit(0));
} else {
  const relay = spawn(process.execPath, [script ?? '', spec ?? ''], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  relay.on('error', () => process.exit(1));
  relay.unref();
  process.stdout.write(`${relay.pid ?? 0}\n`, () => process.exit(0));
}
