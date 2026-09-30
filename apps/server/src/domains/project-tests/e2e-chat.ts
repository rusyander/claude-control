import type { ProjectTestAutomationCommand, ProjectTestE2eFolder } from '@agentdeck/contracts';
import { AUTOMATION_FILE } from './automation.ts';
import { TESTS_DIR } from './files.ts';

/**
 * Что агент чата знает о тестах проекта — одной строкой к системному промпту.
 *
 * Без неё обычный разговор «напиши тесты на вход» кладёт тест куда попало, а
 * раздел «Тесты» о нём не узнаёт никогда: кейсы ведут только прогоны из самого
 * раздела. Строка называет ТРИ вещи, без которых совместной работы нет: где
 * папка e2e, как тест стать кейсом (метка `[id]` + команда сверки) и как его
 * прогнать, чтобы результат лёг на кейс.
 *
 * Вопрос человеку — один и в начале задачи, и только его: адрес стенда, где
 * доступы, какие сценарии важны. Остальное агент находит сам. У проекта без
 * папки e2e в тот же вопрос входит «вести ли тесты в блоке «Тесты»»: папку
 * заводит человек или его «да», не агент молча (то же решение владельца, что
 * запрещает старту чата писать на диск, — `tests-chat-wiring.ts`).
 *
 * Чужой CLI работает с правами, выставленными ему в разделе «Права», и может
 * не уметь запускать команды вовсе. Тогда агент говорит об этом и отдаёт
 * человеку команду — «прогнал» без прогона хуже, чем честное «не могу».
 *
 * Проект, назвавший свою команду (`automation.json`), а папки с тестами не
 * имеющий, получает другую строку: его проверки — свои скрипты, и совет «заведи
 * e2e/ с Playwright» уводил агента писать чужой проекту каркас. Ему названа его
 * же команда и то, как проверку привязать к кейсу (`automation.file`).
 *
 * Блок участвует в работе над продуктом, а не только в задачах «про тесты»
 * (решение владельца 30.09): правя поведение продукта, агент сам заводит или
 * обновляет кейс на изменённое (`tests-cli case`) и записывает проверенное
 * (`tests-cli record` или `run`) — «проверено» становится записью в истории,
 * которую видят раздел и проверка доставки группы.
 *
 * По-английски: это текст для модели. Одна строка — таково правило склейки
 * дописки (`domains/chat/initiative.ts`): на Windows перевод строки рвёт аргумент.
 */
export function e2eChatLine(input: {
  root: string;
  /**
   * Каталог, где своя команда проекта гоняет КОД: у копии ветки — сама копия,
   * даже когда папка e2e — ссылка на оригинал (иначе тесты шли по оригиналу, а
   * не по правкам копии). Нет — `root`.
   */
  commandRoot?: string;
  folder: ProjectTestE2eFolder;
  cliPath: string;
  /** Есть ли у окружений проекта адрес стенда — тогда о нём не спрашивают. */
  hasStandUrl: boolean;
  /** Своя команда прогона проекта; нет — только папка e2e. */
  automation?: ProjectTestAutomationCommand;
}): string {
  const { root, folder, cliPath, automation } = input;
  const cli = `node "${cliPath}"`;
  const folderReady =
    folder.state !== 'missing' && folder.framework !== 'unknown' && folder.specs > 0;
  if (automation && !folderReady) {
    return ownCommandLine({ ...input, root: input.commandRoot ?? root }, automation, cli);
  }
  const where =
    folder.dir && folder.state !== 'missing'
      ? `e2e folder "${folder.dir}" (${folder.framework}, ${folder.specs} spec files` +
        `${folder.state === 'created' ? ', created by the panel and hidden from git' : ''})`
      : 'no e2e folder yet — do not create one on your own: when the task needs tests, ask' +
        ' the user (in the one question below) whether to keep them in this Tests section' +
        ' ("e2e/" with a Playwright config) or only in the checks the project already has';
  return [
    `QA workspace of this project (AgentDeck Tests section): ${where};`,
    `test cases live in ${TESTS_DIR}/<group>.tests.json and the panel shows them as groups.`,
    'When the task involves testing, write REAL e2e tests into that folder in its existing style:',
    // У pytest имя кейса — первая строка docstring: без этой подсказки тест
    // `test_rename` без docstring становился кейсом «rename».
    folder.framework === 'pytest'
      ? 'one test_<group>.py file per user flow, each test with a docstring whose first line is' +
        ' "[<group>-NNN] <what it proves>" (it becomes the case title — the user\'s language)' +
        ' and "# Given", "# When", "# Then" comments, marked @pytest.mark.smoke (critical path)' +
        ' or @pytest.mark.regression;'
      : 'one spec file per user flow (a group, e.g. auth.spec.ts), each test titled' +
        ' "[<group>-NNN] <what it proves>" (the rest of the title becomes the case title — the' +
        ' user\'s language) with "// Given", "// When", "// Then" comments and an @smoke' +
        ' (critical path) or @regression tag;',
    'cover equivalence classes, boundaries, negative',
    'paths and state transitions, not only the happy path; keep lower-level checks in unit or',
    'integration tests.',
    `Register them: ${cli} sync --project "${root}"; run them:`,
    `${cli} run --project "${root}" --group <group>`,
    "(it starts the folder's own runner from the right directory and imports only the report of",
    'THIS run, so results land on the cases; a runner is never installed on the fly — if it is',
    'missing, pass on the install command it prints). A red test is a finding to report, never a',
    'reason to weaken it.',
    ownWorkLine(root, cli),
    `Ask the user once, at task start and in one question, only what is theirs: ${askOf(input)}.`,
  ].join(' ');
}

/**
 * Кейсы и записи на любой задаче, меняющей поведение продукта: агент ведёт блок
 * сам, а кейс человека правит только предложением (черновиком на приёмку).
 */
function ownWorkLine(root: string, cli: string): string {
  return [
    'Beyond test tasks: whenever you change how the product behaves, keep this Tests section in',
    'step on your own — add or update the case that covers the change',
    `(${cli} case --project "${root}" --group <group> --json`,
    '\'{"title":"…","steps":["…"],"expected":"…","codePaths":["<changed path>"]}\';',
    'pass "id" to update; a case a human wrote becomes a draft they accept) and record what you',
    `actually verified (${cli} record --project "${root}" <group>:<case>=passed|failed|blocked`,
    '--note "<how you checked>") or run the automated ones as above. Never call the work tested',
    'without a recorded run. If your tools here cannot run commands or write files, say so and',
    'hand the user the exact command instead of reporting a run that did not happen.',
  ].join(' ');
}

/** Что спросить у человека — одним вопросом в начале задачи. */
function askOf(input: { hasStandUrl: boolean; folder?: ProjectTestE2eFolder }): string {
  return [
    input.folder?.state === 'missing' ? 'whether tests belong in this Tests section' : '',
    input.hasStandUrl ? '' : 'the stand URL',
    'where credentials live (variable names, never values)',
    'which flows matter most',
  ]
    .filter(Boolean)
    .join(', ');
}

/** Строка для проекта со своей командой прогона и без папки с тестами. */
function ownCommandLine(
  input: { root: string; hasStandUrl: boolean },
  automation: ProjectTestAutomationCommand,
  cli: string,
): string {
  const { root } = input;
  return [
    'QA workspace of this project (AgentDeck Tests section): the project runs its checks with',
    `its own command from ${TESTS_DIR}/${AUTOMATION_FILE}: "${automation.command}"`,
    '({files} = the files of the selected cases, or of every automated case; {report} and AGENTDECK_JUNIT_REPORT = the junit',
    `report path); test cases live in ${TESTS_DIR}/<group>.tests.json.`,
    'When the task involves testing, write checks the way this project already writes them —',
    'do NOT add a Playwright/Cypress folder of your own. Link every new or existing check to a',
    'case in the SAME pass: the case gets "automation": {"status": "automated", "file": "<path',
    'from the project root>"} (plus "testName": the exact test name, for unit or integration',
    'tests), and the test or its junit testcase is named "[<group>-NNN] <what it proves>" so',
    'the report lands on that case; cover negative paths and boundaries, not only the happy path.',
    `Run them: ${cli} run --project "${root}" [--group <group>]`,
    '(no --cmd: it runs the command above with the files of those cases and imports only the',
    'report of THIS run). A red check is a finding to report, never a reason to weaken it.',
    ownWorkLine(root, cli),
    `Ask the user once, at task start and in one question, only what is theirs: ${askOf(input)}.`,
  ].join(' ');
}
