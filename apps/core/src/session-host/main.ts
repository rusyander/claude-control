import { appendFileSync } from 'node:fs';
import { runHost } from './host.ts';
import { sessionFile } from './protocol.ts';

/**
 * Точка входа процесса хоста сессии: `node --experimental-strip-types main.ts <каталог сессии>`.
 * Всё поведение — в `host.ts`. Хост запущен отвязанным, без stderr: поломка пишется в
 * `host.err` каталога сессии — иначе причина «хост не поднялся» терялась бы.
 */
const dir = process.argv[2];
if (!dir) {
  process.exitCode = 2;
} else {
  runHost(dir).catch((error: unknown) => {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    appendFileSync(sessionFile(dir, 'hostErr'), `${new Date().toISOString()} ${text}\n`);
    process.exitCode = 1;
  });
}
