import { fileURLToPath } from 'node:url';

/**
 * `tools/tests-cli.mjs` панели — абсолютным путём: группа работает в своей копии чужого
 * проекта, и относительный путь вёл бы в её дерево, где такого файла нет. Этот файл
 * лежит пятью уровнями ниже корня репозитория панели.
 */
export const PANEL_TESTS_CLI = fileURLToPath(
  new URL('../../../../../tools/tests-cli.mjs', import.meta.url),
);

/**
 * Проверка доставки, которую звено доставки гоняет само ДО создания MR (g5 25.10, P5):
 * тот же код, что панель после хода (`tests-cli delivery`). Аргументы ответа и черновика
 * дописывает задание звена (`deliverStagePrompt`). Одна строка на звено доставки любого
 * CLI — задание собирает панель.
 */
export function deliveryCheckCommand(): string {
  return `node "${PANEL_TESTS_CLI}" delivery --project .`;
}

/**
 * Как сдать то, что группу держать не должно (решение владельца 23.10): та же
 * пара меток, что в задании сит (`NOTE_MARKS_LINE`), — промпт и панель
 * согласны, и группа не крутится на «стенда нет». Один текст у напоминания
 * доставки и у вводной перепроверки (аудит g5 27.10, M1: в вводной его не было —
 * лишний круг, 32 % перепроверки).
 */
export const NOTE_MARKS_HINT =
  'A live check you cannot run here (no stand with this branch, no browser, no network) is not ' +
  'a blocker: report its row as fail with evidence starting "not checked: <reason>". A ' +
  'run-proven live sieve counts only a Tests-block run of a case a human made or tagged live; ' +
  'when none covers the change, that is the reason («no human-made live case covers <what>»), ' +
  'not «no browser». A red ' +
  'check or case not caused by the branch (red on the target branch too, platform-only, a ' +
  'timeout in code the diff does not touch) — evidence starting "not caused by the branch: ' +
  '<why>". A Tests-block case that cannot run here (no stand, no browser) is recorded as ' +
  'blocked, not left unrun: an automated one through its run command (the run records it ' +
  'blocked), a manual one with `tests-cli record <group>:<case>=blocked --note "<why>"`. The ' +
  'panel records all of these as notes; name each in the MR description.';
