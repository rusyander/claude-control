// Подставной сборщик APK: печатает строки с кодами цвета, как Gradle, кладёт
// файл в корень и выходит. Файл `fail` в корне — сборка падает; `slow` — сборка
// висит, а внук (как демон Gradle) живёт своим процессом: отмена должна снять обоих.
// Внук отвязан: java, запущенная через gradlew.bat, не входит в задание (job) Node и
// не гаснет со смертью сборщика — неотвязанный внук ушёл бы и при снятии одного корня.
/* global process, setTimeout */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

process.stdout.write('\u001b[32m> Task :app:assembleRelease\u001b[0m\n');
process.stderr.write('warning: deprecated\n');
if (existsSync('slow')) {
  const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  writeFileSync('pids.json', JSON.stringify({ build: process.pid, daemon: daemon.pid }));
  setTimeout(() => {}, 60_000);
} else if (existsSync('fail')) {
  process.stdout.write('BUILD FAILED\n');
  process.exitCode = 1;
} else {
  writeFileSync('agentdeck.apk', 'apk');
  process.stdout.write('BUILD SUCCESSFUL\n');
}
