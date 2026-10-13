#!/usr/bin/env node
// Отвязанный от панели запуск сборки APK. Сборка идёт ~10 минут, а dev-панель
// перезапускается на каждую правку сервера — дочерний процесс панели умер бы
// вместе с ней. Этот процесс живёт сам: пишет вывод сборки в лог, а итог —
// в файл состояния, который панель читает при каждом опросе.
//
// Аргументы: --script <сборщик> --cwd <корень репозитория> --log <файл> --state <файл>
/* global process */
import { spawn } from 'node:child_process';
import { createWriteStream, writeFileSync } from 'node:fs';

function arg(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : '';
}

const script = arg('--script');
const cwd = arg('--cwd');
const logPath = arg('--log');
const statePath = arg('--state');
const startedAt = new Date().toISOString();

const writeState = (state) => writeFileSync(statePath, JSON.stringify(state), 'utf8');

writeState({ state: 'building', startedAt, pid: process.pid });
const log = createWriteStream(logPath, { flags: 'w' });
const child = spawn(process.execPath, [script], { cwd, windowsHide: true });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });

const finish = (code) => {
  writeState({
    state: code === 0 ? 'succeeded' : 'failed',
    startedAt,
    finishedAt: new Date().toISOString(),
    code,
    // Pid остаётся и в итоге: ждущему (тесту) видно, когда этот процесс отпустит каталог.
    pid: process.pid,
  });
  log.end();
};
child.on('error', (error) => {
  log.write(`\n${error.message}\n`);
  finish(-1);
});
child.on('close', (code) => finish(code ?? -1));
