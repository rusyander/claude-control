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
## Project test cases

UI test cases live in \`${TESTS_DIR}/\` — one file per group
(\`gui.tests.json\`, \`e2e.tests.json\`). The panel lists them and runs them, so keep
them up to date also when the request came from an ordinary conversation.

File format:

\`\`\`json
{
  "version": 1,
  "title": "GUI",
  "description": "what this group is about",
  "cases": [
    {
      "id": "gui-001",
      "type": "case | checklist",
      "title": "briefly, what is checked",
      "purpose": "why this test is needed",
      "area": "area of the app",
      "section": "path in the tree: Chat/Attachments",
      "precondition": "which state to start from",
      "steps": [{ "action": "what to press", "data": "what to enter", "expected": "what is visible" }],
      "expected": "what should come out",
      "oracle": "what proves the result",
      "priority": "blocker | high | medium | low",
      "tags": ["smoke"],
      "parameters": [{ "name": "role", "values": ["admin", "guest"] }],
      "codePaths": ["src/pages/Chat"],
      "automation": { "status": "manual | toAutomate | automated", "file": "…", "testName": "…" },
      "status": "unknown | passed | failed | skipped | blocked",
      "note": "what was actually seen",
      "attachments": ["${TESTS_DIR}/attachments/gui-001/screenshot.png"],
      "lastRunAt": "ISO time of the run",
      "source": "agent | human"
    }
  ]
}
\`\`\`

Next to them lie \`_shared.steps.json\` (shared steps, referenced from a case as \`{"ref": "login"}\`),
\`environments.json\`, \`schema.json\`, \`views.json\`, \`plans/\` and \`runs/\` — the panel keeps those.

Rules:

- checked something in the UI — create or update a case; write the result right
  after EACH case (\`status\`, \`note\`, \`lastRunAt\`), not in a batch at the end;
- do not change \`id\`: the panel merges edits by it;
- cases with \`"source": "human"\` may be extended, but not deleted or rewritten;
- write boundaries and negative checks, not only the happy path; move repeated
  steps into a shared step and nearly identical cases into \`parameters\` (in a step's
  text a parameter is written as \`%role\`);
- \`blocked\` — the check cannot be reached because of someone else's breakage,
  \`skipped\` — nothing to check with;
- a feature is gone from the app — mark its cases \`"readiness": "obsolete"\` or remove them;
- a bug found is \`status: "failed"\` with the reason in \`note\`, not a reason to fix the
  code without a separate request;
- write the case texts in the language of the existing cases; with none yet — in the
  language the human uses.
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

/**
 * Где в тексте лежит вписанный блок. Любая его версия устроена одинаково:
 * маркер, заголовок, формат в блоке кода и список правил последним — блок
 * кончается с последним пунктом этого списка. Всё, что человек дописал после
 * (текст, заголовок), в блок не входит и при замене остаётся на месте.
 */
function blockSpan(text: string): { start: number; end: number } | undefined {
  const start = [MARKER, LEGACY_MARKER]
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (start === undefined) return undefined;
  let offset = start;
  let fences = 0;
  let inList = false;
  for (const line of text.slice(start).split('\n')) {
    if (line.startsWith('```')) fences += 1;
    else if (fences >= 2 && line.startsWith('- ')) inList = true;
    else if (inList && !line.startsWith('  ')) return { start, end: offset };
    offset += line.length + 1;
  }
  return { start, end: text.length };
}

/** Заголовок нынешнего блока — по нему версия блока и опознаётся. */
const HEADING = BLOCK.split('\n')[1]!;

/**
 * Блок под нынешним маркером и с нынешним заголовком. Правку человека внутри
 * блока это не отменяет — заменяется только блок прежней версии.
 */
function isCurrentBlock(text: string): boolean {
  const span = blockSpan(text);
  if (!span) return false;
  const [marker, heading] = text.slice(span.start, span.end).split('\n');
  return marker === MARKER && heading === HEADING;
}

/**
 * Вписано ли НЫНЕШНЕЕ соглашение. Блок прежней версии (русский, до перевода
 * агентских текстов на английский) — не вписано: кнопка снова доступна и
 * заменяет его на месте, иначе старый текст оставался в файле навсегда.
 */
export function hasConvention(root: string, userSettingsPath?: string): boolean {
  const path = conventionFile(root, userSettingsPath);
  if (!existsSync(path)) return false;
  try {
    const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    return isCurrentBlock(text);
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
  const current = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : '';
  const span = blockSpan(current);
  if (span) {
    // Блок прежней версии — заменить на месте, сохранив всё до и после него.
    const after = current.slice(span.end);
    writeTextFile(
      path,
      `${current.slice(0, span.start)}${BLOCK}${after ? `\n${after}` : ''}`,
      backupDir ? { backupDir, backupName } : {},
    );
    return true;
  }
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
