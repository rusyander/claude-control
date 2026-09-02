import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTextFile } from '../../lib/safe-io.ts';
import { TESTS_DIR } from './store.ts';

/**
 * Соглашение о тест-кейсах в `CLAUDE.md` проекта.
 *
 * Кнопки модалки отдают формат файлов агенту сами — в задании. Но человек
 * говорит «прогони тесты» и в ОБЫЧНОМ разговоре, а тот прогон про `.agent/tests`
 * ничего не знает: проверит, что попросили, и ничего не запишет.
 *
 * Единственное, что читает КАЖДЫЙ прогон в этом проекте, — его `CLAUDE.md`.
 * Поэтому соглашение вписывается туда, и после этого кейсы ведутся независимо от
 * того, откуда пришла просьба.
 *
 * Файл пользовательский, поэтому: только по явному нажатию, только дописыванием
 * в конец, и ровно один раз — блок помечен маркером, повтор ничего не добавляет.
 */

/** По нему блок опознаётся при повторном нажатии и при чтении состояния. */
const MARKER = '<!-- claude-control:tests -->';

const BLOCK = `${MARKER}
## Тест-кейсы проекта

Кейсы по интерфейсу лежат в \`${TESTS_DIR}/\` — по файлу на группу
(\`gui.tests.json\`, \`e2e.tests.json\`). Панель показывает их списком и по ним же
гоняет прогоны, поэтому веди их и когда просьба пришла из обычного разговора.

Формат файла:

\`\`\`json
{
  "version": 1,
  "title": "GUI",
  "description": "о чём эта группа",
  "cases": [
    {
      "id": "gui-001",
      "title": "коротко, что проверяем",
      "purpose": "зачем этот тест нужен",
      "area": "зона приложения",
      "steps": ["что нажать", "что ввести"],
      "expected": "что должно получиться",
      "status": "unknown | passed | failed | skipped",
      "note": "что увидел на самом деле",
      "lastRunAt": "ISO-время прогона",
      "source": "agent | human"
    }
  ]
}
\`\`\`

Правила:

- проверил что-то в интерфейсе — заведи или обнови кейс; результат пиши сразу
  после КАЖДОГО кейса (\`status\`, \`note\`, \`lastRunAt\`), а не пачкой в конце;
- \`id\` не меняй: по нему панель сводит правки;
- кейсы с \`"source": "human"\` дополняй, но не удаляй и не переписывай;
- функции в приложении не стало — убери её кейсы;
- найденный баг — это \`status: "failed"\` и причина в \`note\`, а не повод чинить код
  без отдельной просьбы.
`;

/** Вписано ли соглашение в CLAUDE.md проекта. */
export function hasConvention(root: string): boolean {
  const path = join(root, 'CLAUDE.md');
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
}

/**
 * Дописать соглашение в конец `CLAUDE.md`. Повторный вызов ничего не делает —
 * значит, кнопку можно нажать дважды без последствий.
 */
export function installConvention(root: string, backupDir?: string, backupName?: string): boolean {
  if (hasConvention(root)) return false;
  const path = join(root, 'CLAUDE.md');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const separator = current.length === 0 || current.endsWith('\n\n') ? '' : '\n';
  // Тот же CLAUDE.md правит вкладка «Правила» — с резервной копией и под ИМЕНЕМ
  // проектной копии (`project-<id>-CLAUDE.md`), а не пользовательской; дописывать
  // без копии значило бы, что одна кнопка бережёт файл, а другая нет.
  writeTextFile(
    path,
    `${current}${separator}\n${BLOCK}`,
    backupDir ? { backupDir, backupName } : {},
  );
  return true;
}
