// Хук враждебного набора: отметка и отказ кодом 2 со строкой причины в stderr (форма отказа Claude, §Probe Q1).
// argv: <каталог отметок> <имя хука> <причина>.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [markers, name, ...reason] = process.argv.slice(2);
// Пустой или закрытый stdin — не повод упасть: отметка всё равно ложится.
const readInput = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};
const input = readInput();
mkdirSync(markers, { recursive: true });
writeFileSync(join(markers, `${name}-${process.pid}-${Date.now()}.json`), input || '{}');
process.stderr.write(`${reason.join(' ') || 'blocked by the user layer'}\n`);
process.exit(2);
