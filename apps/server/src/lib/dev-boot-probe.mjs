/**
 * Проба сборки сервера для dev-сторожа (`dev-watch.mjs`): поднимается ли новый
 * код, — до того, как сторож погасит работающий сервер.
 *
 * Зачем. Сторож перезапускал сервер на каждую правку, и недописанный файл
 * (агент правит панель посреди хода) валил новый сервер при загрузке: старого
 * уже нет, нового не будет, панель пустая, пока кто-нибудь не допишет файл.
 *
 * Почему не «второй сервер на другом порту». Сервер при старте подхватывает
 * живые сессии чатов из журнала прогонов, а посредник сессии держит ОДНО
 * подключение и отдаёт его последнему пришедшему: пробный сервер увёл бы у
 * работающего все идущие разговоры. Поэтому проба грузит весь граф модулей
 * точки входа — синтаксис, пути, имена импортов, код верхнего уровня, — но не
 * исполняет тело `index.ts`: ни порта, ни журнала, ни подхвата.
 *
 * argv: <точка входа>. Выход 0 — граф загрузился, 1 — нет (причина в stderr).
 */
/* global process, console, URL */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Статические импорты модуля: `import … from '…'` и `import '…'`, в том числе
 * многострочные; `import type` — только для проверки типов, в исполнении его нет.
 */
export function importSpecifiers(source) {
  const found = [];
  // Список имён — без кавычек и `;`: иначе ленивый захват перешагивал конец
  // инструкции, и `import './x'` перед обычным импортом терялся (F-198).
  const pattern = /^import\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) {
    if (!match[1]) found.push(match[2]);
  }
  return found;
}

async function main() {
  const entry = resolve(process.argv[2] ?? 'src/index.ts');
  const entryUrl = pathToFileURL(entry);
  for (const specifier of importSpecifiers(readFileSync(entry, 'utf8'))) {
    const target = specifier.startsWith('.') ? new URL(specifier, entryUrl).href : specifier;
    await import(target);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? String(error));
      process.exit(1);
    },
  );
}
