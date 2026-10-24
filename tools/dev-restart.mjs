#!/usr/bin/env node
// `pnpm dev:restart` — перезапустить dev-сервер сейчас, не дожидаясь тишины после правок.
//
// Сторож (`apps/server/src/lib/dev-watch.mjs`) собирает правки пачкой: перезапуск после минуты без
// сохранений, но не позже пяти минут от первой правки. Эта команда кладёт тот же запрос, что и кнопка
// панели (`dev-restart.request`), и показывает, что сторож с ним сделал. Идущие ходы и проверки
// перезапуск по-прежнему ждёт — оборвать их можно только кнопкой в панели.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appDataDirOf } from '../apps/server/src/lib/brand.mjs';
import {
  DEV_RESTART_REQUEST,
  DEV_WATCH_LOG,
  requestRestart,
} from '../apps/server/src/lib/dev-restart.mjs';

// Сторож проверяет запрос раз в 2 с, посреди отсрочки — раз в 5 с.
const WAIT_MS = 8_000;

const configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const appData = appDataDirOf(configRoot);
const request = join(appData, DEV_RESTART_REQUEST);
const log = join(appData, DEV_WATCH_LOG);
const sizeOf = (file) => (existsSync(file) ? statSync(file).size : 0);

const from = sizeOf(log);
requestRestart(appData);
const until = Date.now() + WAIT_MS;
while (existsSync(request) && Date.now() < until) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (existsSync(request)) {
  rmSync(request, { force: true });
  console.error(
    'Сторож dev-сервера не забрал запрос за 8 с: он не запущен или запущен до 25.10 — перезапустите `pnpm dev`.',
  );
  process.exit(1);
}
// Строка о решении сторожа пишется сразу за взятием запроса.
await new Promise((resolve) => setTimeout(resolve, 300));
const added = sizeOf(log) > from ? readFileSync(log).subarray(from).toString('utf8').trim() : '';
console.log(
  added || 'Запрос принят: сторож перезапускает сервер, как только кончатся идущие ходы.',
);
