#!/usr/bin/env node
// Поддельный CLI для P25/P54: печатает одной строкой JSON того, что реально дошло до процесса —
// argv после скрипта, всё окружение, cwd и метку preload (`globalThis.__preloaded`), если
// NODE_OPTIONS подгрузил файл. Ничего не пишет на диск. Запись в fd 1 синхронная: строка
// целиком уходит до выхода, даже когда stdout — канал.
import { writeSync } from 'node:fs';

writeSync(
  1,
  JSON.stringify({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    execArgv: process.execArgv,
    preloaded: globalThis.__preloaded ?? null,
  }),
);
