import { existsSync, readFileSync } from 'node:fs';
import { projectInstructionTarget } from '../../lib/instruction-files.ts';
import { writeTextFile } from '../../lib/safe-io.ts';
import { TESTS_DIR } from './store.ts';
import { LEGACY_BRAND_SLUG } from '../../lib/brand.mjs';

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
const MARKER = '<!-- agentdeck:tests -->';
/** Маркер блока, вписанного до переименования продукта: повтор его не продублирует. */
const LEGACY_MARKER = `<!-- ${LEGACY_BRAND_SLUG}:tests -->`;

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
      "type": "case | checklist",
      "title": "коротко, что проверяем",
      "purpose": "зачем этот тест нужен",
      "area": "зона приложения",
      "section": "путь в дереве: Чат/Вложения",
      "precondition": "с какого состояния начинать",
      "steps": [{ "action": "что нажать", "data": "что ввести", "expected": "что видно" }],
      "expected": "что должно получиться",
      "oracle": "чем доказывается результат",
      "priority": "blocker | high | medium | low",
      "tags": ["smoke"],
      "parameters": [{ "name": "role", "values": ["админ", "гость"] }],
      "codePaths": ["src/pages/Chat"],
      "automation": { "status": "manual | toAutomate | automated", "file": "…", "testName": "…" },
      "status": "unknown | passed | failed | skipped | blocked",
      "note": "что увидел на самом деле",
      "attachments": ["${TESTS_DIR}/attachments/gui-001/скриншот.png"],
      "lastRunAt": "ISO-время прогона",
      "source": "agent | human"
    }
  ]
}
\`\`\`

Рядом лежат \`_shared.steps.json\` (общие шаги, ссылка из кейса — \`{"ref": "login"}\`),
\`environments.json\`, \`schema.json\`, \`views.json\`, \`plans/\` и \`runs/\` — их ведёт панель.

Правила:

- проверил что-то в интерфейсе — заведи или обнови кейс; результат пиши сразу
  после КАЖДОГО кейса (\`status\`, \`note\`, \`lastRunAt\`), а не пачкой в конце;
- \`id\` не меняй: по нему панель сводит правки;
- кейсы с \`"source": "human"\` дополняй, но не удаляй и не переписывай;
- пиши границы и негативные проверки, а не только счастливый путь; повторяющиеся
  шаги выноси в общий шаг, почти одинаковые кейсы — в \`parameters\` (в тексте шага
  параметр пишется как \`%role\`);
- \`blocked\` — до проверки не дойти из-за чужой поломки, \`skipped\` — проверять нечем;
- функции в приложении не стало — пометь её кейсы \`"readiness": "obsolete"\` или убери;
- найденный баг — это \`status: "failed"\` и причина в \`note\`, а не повод чинить код
  без отдельной просьбы.
`;

/**
 * В КАКОЙ файл инструкций проекта пишется соглашение.
 *
 * Спрашивается общий резолвер имени (П2.7), а не `CLAUDE.md` строкой: проект,
 * живущий на `AGENTS.md`, получил бы от панели второй файл инструкций — и CLI
 * стал бы читать его вместо прежнего, потому что `CLAUDE.md` рядом гасит
 * `AGENTS.md` молча. Имя файла инструкций — решение человека, а не панели.
 */
export function conventionFile(root: string, userSettingsPath?: string): string {
  return projectInstructionTarget(root, userSettingsPath).filePath;
}

/** Вписано ли соглашение в файл инструкций проекта. */
export function hasConvention(root: string, userSettingsPath?: string): boolean {
  const path = conventionFile(root, userSettingsPath);
  if (!existsSync(path)) return false;
  try {
    const text = readFileSync(path, 'utf8');
    return text.includes(MARKER) || text.includes(LEGACY_MARKER);
  } catch {
    return false;
  }
}

/**
 * Дописать соглашение в конец файла инструкций проекта. Повторный вызов ничего
 * не делает — значит, кнопку можно нажать дважды без последствий.
 */
export function installConvention(
  root: string,
  backupDir?: string,
  backupName?: string,
  userSettingsPath?: string,
): boolean {
  if (hasConvention(root, userSettingsPath)) return false;
  const path = conventionFile(root, userSettingsPath);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const separator = current.length === 0 || current.endsWith('\n\n') ? '' : '\n';
  // Тот же файл правит вкладка «Правила» — с резервной копией и под ИМЕНЕМ
  // проектной копии (`project-<id>-CLAUDE.md`), а не пользовательской; дописывать
  // без копии значило бы, что одна кнопка бережёт файл, а другая нет.
  writeTextFile(
    path,
    `${current}${separator}\n${BLOCK}`,
    backupDir ? { backupDir, backupName } : {},
  );
  return true;
}
