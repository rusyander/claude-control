/**
 * Подменный `go` для кадров «Тесты бэкенда»: `go test -json …` печатает
 * записанный вывод НАСТОЯЩЕГО `go test -json` (фикстура сервера) и выходит с
 * кодом 1, как go с упавшим тестом. Остальное — команду из рецепта, перевод в
 * JUnit, кейсы и историю — делает настоящая панель. `go version` нужен рецепту
 * только как признак «go есть на машине».
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FIXTURE = resolve(
  import.meta.dirname,
  '../../apps/server/src/domains/project-tests/automation/__fixtures__/go-test.json',
);

const [command] = process.argv.slice(2);
if (command === 'version') {
  process.stdout.write('go version go1.24.0 fake\n');
  process.exit(0);
}
if (command === 'test') {
  process.stdout.write(readFileSync(FIXTURE));
  process.exit(1);
}
process.stderr.write(`fake go: ${command ?? ''} не подменён\n`);
process.exit(2);
