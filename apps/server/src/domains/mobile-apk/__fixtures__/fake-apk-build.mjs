// Подставной сборщик APK: печатает строки с кодами цвета, как Gradle, кладёт
// файл в корень и выходит. Файл `fail` в корне — сборка падает.
/* global process */
import { existsSync, writeFileSync } from 'node:fs';

process.stdout.write('\u001b[32m> Task :app:assembleRelease\u001b[0m\n');
process.stderr.write('warning: deprecated\n');
if (existsSync('fail')) {
  process.stdout.write('BUILD FAILED\n');
  process.exitCode = 1;
} else {
  writeFileSync('agentdeck.apk', 'apk');
  process.stdout.write('BUILD SUCCESSFUL\n');
}
