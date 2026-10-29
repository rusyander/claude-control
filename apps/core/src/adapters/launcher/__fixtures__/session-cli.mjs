#!/usr/bin/env node
// Поддельный CLI для запускающего: первой строкой — JSON того, что дошло до процесса (номер,
// argv, окружение, cwd, метка preload). Дальше по MODE:
//   exit  — выйти через EXIT_AFTER_MS (по умолчанию сразу: быстрый выход — тоже случай,
//           хост обязан записать exit.json, даже если CLI ушёл до чтения своей личности);
//   wait  — эхо строк stdin, выход по концу stdin;
//   tree  — поднять внука (спит), напечатать его номер, stdin не слушать, жить до снятия;
//   flood — напечатать FLOOD_BYTES байт строками и выйти.
// Голый node, без типов; на диск ничего не пишет.
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';

const line = (value) => writeSync(1, `${JSON.stringify(value)}\n`);
line({
  pid: process.pid,
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  preloaded: globalThis.__preloaded ?? null,
});
const mode = process.env.MODE ?? 'exit';
// Забытый тест не оставляет процесс жить часами.
setTimeout(() => process.exit(0), Number(process.env.CLI_MAX_MS ?? 120_000)).unref();
if (mode === 'wait') {
  createInterface({ input: process.stdin })
    .on('line', (text) => line({ echo: text }))
    .on('close', () => process.exit(0));
} else if (mode === 'tree') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  line({ grandchild: child.pid });
  setInterval(() => {}, 1000);
} else if (mode === 'flood') {
  const total = Number(process.env.FLOOD_BYTES ?? 100_000);
  let sent = 0;
  let n = 0;
  while (sent < total) {
    const text = `row ${String(n).padStart(8, '0')}\n`;
    writeSync(1, text);
    sent += text.length;
    n += 1;
  }
  setTimeout(() => process.exit(0), Number(process.env.EXIT_AFTER_MS ?? 0));
} else {
  setTimeout(() => process.exit(0), Number(process.env.EXIT_AFTER_MS ?? 0));
}
