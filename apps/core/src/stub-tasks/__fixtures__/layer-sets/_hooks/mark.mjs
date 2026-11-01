// Хук набора слоя: отметка «хук сработал» (файл в каталоге отметок) и пропуск — код 0.
// argv: <каталог отметок> <имя хука>. Вход хука (stdin JSON) ложится в отметку: тест видит событие и инструмент.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [markers, name] = process.argv.slice(2);
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
process.exit(0);
