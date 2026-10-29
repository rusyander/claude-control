// Поддельный CLI для P89/P112: печатает `line <n>` (n = 1..COUNT) с паузой PACE_MS, на каждую
// строку stdin отвечает `echo <строка>`, в начале — есть ли ключ в окружении (`key:yes|no`,
// без значения). После COUNT строк ждёт конца stdin и выходит 0. Голый node, без типов.
import { createInterface } from 'node:readline';

const count = Number(process.env.COUNT ?? 300);
const pace = Number(process.env.PACE_MS ?? 10);
process.stdout.write(`key:${process.env.AGENTDECK_PLANTED_KEY ? 'yes' : 'no'}\n`);
let n = 0;
let stdinDone = false;
// Убитый посреди прогона тест не оставляет поддельный CLI жить часами (COUNT 100000 × 50 мс).
setTimeout(() => process.exit(0), Number(process.env.CLI_MAX_MS ?? 180_000)).unref();
const timer = setInterval(() => {
  if (n < count) {
    n += 1;
    process.stdout.write(`line ${n}\n`);
  } else if (stdinDone) {
    clearInterval(timer);
    process.exit(0);
  }
}, pace);
createInterface({ input: process.stdin })
  .on('line', (line) => process.stdout.write(`echo ${line}\n`))
  .on('close', () => {
    stdinDone = true;
  });
