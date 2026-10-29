import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachSession, readLines } from '../client.ts';
import { launchSession } from '../launch.ts';

/**
 * «Ядро» для краш-теста P89 — отдельный процесс, который тест убивает посреди потока.
 * argv: <каталог сессии> <журнал>. Поднимает сессию через хост (numbered-cli), подключается,
 * читает вывод от смещения и пишет в журнал КАЖДУЮ строку вместе с `next` одной записью
 * (как журнал ядра), отправляет ввод c1 и пишет `c1.acked`. Дальше читает, пока не убьют.
 */
const [dir = '', journal = ''] = process.argv.slice(2);
const cli = fileURLToPath(new URL('./numbered-cli.mjs', import.meta.url));

const launched = await launchSession({
  dir,
  sessionId: `p89-${process.pid}`,
  command: process.execPath,
  args: [cli],
  cwd: dir,
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
    COUNT: process.env.COUNT ?? '300',
    PACE_MS: process.env.PACE_MS ?? '10',
  },
});
if (!launched.ok) {
  writeFileSync(join(dir, 'fake-core.err'), launched.reason);
  process.exit(3);
}
const attached = await attachSession(dir);
if (attached.state !== 'live') {
  writeFileSync(join(dir, 'fake-core.err'), JSON.stringify(attached));
  process.exit(4);
}
let offset = 0;
let sent = false;
for (;;) {
  const { lines, ends, next } = readLines(dir, 'stdout', offset);
  // Строки по одной, каждая со своим `next`: смерть между записями не даёт ни пропуска, ни дубля.
  lines.forEach((line, index) => {
    appendFileSync(journal, `${JSON.stringify({ line, next: ends[index] })}\n`);
  });
  offset = next;
  if (!sent && offset > 0) {
    sent = true;
    const ack = await attached.session.send('c1', 'hello-1\n');
    writeFileSync(join(dir, 'c1.acked'), JSON.stringify(ack));
  }
  await new Promise((done) => setTimeout(done, 15));
}
