import type {
  ProjectTestEnvironment,
  ProjectTestGenerateMaterial,
  ProjectTestGroup,
  ProjectTestRunRequest,
  ProjectTestSharedStep,
} from '@agentdeck/contracts';
import type { StepShape } from '@agentdeck/contracts/test-format';
import { TESTS_DIR } from '../files.ts';
import { groupFile } from '../store/store.ts';

/**
 * Задание агенту: написать кейсы, пройти их, поискать неизвестное или
 * превратить стабильные кейсы в код.
 *
 * Прогон идёт без человека за спиной, поэтому в задании важнее всего не «что
 * проверить», а ГРАНИЦЫ: единственное, что агенту позволено менять, — файлы в
 * `.agent/tests/` (режим `automate` добавляет к этому файлы автотестов).
 * Иначе прогон, наткнувшись на баг, чинит код — и вместо отчёта о состоянии
 * приложения человек получает неожиданный дифф.
 *
 * Второе по важности — МЕТОДИКА. Раньше здесь была только просьба «опиши
 * проверки», и агент писал счастливые пути по подписям кнопок: ни границ, ни
 * негативных, ни приоритетов. Приёмы тест-дизайна перечислены дословно, потому
 * что это единственное место, где они вообще формулируются.
 *
 * Статусы велено писать ПОСЛЕ КАЖДОГО кейса, а не пачкой в конце: панель
 * перечитывает файлы, пока прогон идёт, и именно так галочки капают по ходу.
 * Записанное в конце означало бы полчаса пустого экрана и потерю всего
 * результата, если прогон оборвётся.
 *
 * Задание модели — по-английски (решение владельца D-E, 27.09.2026), а тексты
 * кейсов читает человек: их язык — язык уже написанных кейсов библиотеки.
 */

/**
 * Язык текстов кейсов. Прежде задание говорило «пиши по-русски»; английское
 * задание без этой строки получило бы английские кейсы в русской библиотеке.
 */
const CASE_LANGUAGE_LINE =
  '- write every human-readable text of the cases (title, purpose, steps, expectations, note, ' +
  'reason) in the language the existing cases and group descriptions are written in; with ' +
  "none yet — in the language of the human's wish; not in the language of these instructions.";

const REGRESSION_TAGS = ['регресс', 'regression'];

/**
 * Метка регресса — на языке библиотеки, а не задания: планы и наборы отбирают
 * кейсы по метке, и «regression» в русской библиотеке молча выпадал из фильтра
 * «регресс». Уже принятая в библиотеке метка решает; без неё — язык кейса,
 * из-за провала которого пишется регресс.
 */
function regressionTag(groups: ProjectTestGroup[], sourceTitle: string): string {
  for (const group of groups) {
    for (const testCase of group.cases) {
      const found = testCase.tags?.find((tag) => REGRESSION_TAGS.includes(tag.toLowerCase()));
      if (found) return found;
    }
  }
  return /\p{Script=Cyrillic}/u.test(sourceTitle) ? 'регресс' : 'regression';
}

/** Шаг одной строкой — по-английски, как всё задание (общий `stepText` пишет подписи по-русски). */
function stepLine(step: StepShape): string {
  const parts = [step.action];
  if (step.data) parts.push(`data: ${step.data}`);
  if (step.expected) parts.push(`expected: ${step.expected}`);
  return parts.join(' · ');
}

/** Схема файла — агент пишет его руками, поэтому форма описана дословно. */
function schemaBlock(): string {
  return [
    'Group file format (JSON, UTF-8):',
    '{',
    '  "version": 1,',
    '  "title": "GUI",',
    '  "description": "what this group is about",',
    '  "cases": [',
    '    {',
    '      "id": "gui-001",',
    '      "type": "case | checklist",',
    '      "title": "briefly, what is checked",',
    '      "purpose": "why this test is needed",',
    '      "area": "area of the app: chat, analytics, settings…",',
    '      "section": "path in the tree: Chat/Attachments",',
    '      "precondition": "which state to start from",',
    '      "steps": [',
    '        { "action": "what to press", "data": "what to enter", "expected": "what is visible at this step" },',
    '        { "ref": "login", "action": "Sign in as the test user" }',
    '      ],',
    '      "expected": "the outcome of the whole scenario",',
    '      "postcondition": "what to restore after the check",',
    '      "oracle": "what proves the result: text on the screen, a record in the database, a network response",',
    '      "priority": "blocker | high | medium | low",',
    '      "readiness": "draft | ready | obsolete",',
    '      "duration": 5,',
    '      "tags": ["smoke"],',
    '      "links": [{ "type": "requirement | issue | mr | doc", "url": "…" }],',
    '      "parameters": [{ "name": "role", "values": ["admin", "guest"] }],',
    '      "codePaths": ["apps/web/src/pages/Chat"],',
    '      "automation": { "status": "manual | toAutomate | automated", "file": "…", "testName": "…" },',
    '      "status": "unknown | passed | failed | skipped | blocked",',
    '      "note": "what was actually seen — filled in by the run",',
    '      "failure": { "step": 3, "expected": "what should have been at this step", "actual": "what came out", "retry": "confirmed | flaky", "retryNote": "what came out the second time" },',
    '      "lastRunAt": "ISO time of the run",',
    '      "source": "agent | human"',
    '    }',
    '  ]',
    '}',
    'The old form (steps as strings) is still read, but write the new one.',
    '`id` must not change: the panel merges edits by it. `source: "human"` — the case',
    'was written by a human: it may be extended, but it may NOT be deleted and its',
    'meaning may not be rewritten.',
  ].join('\n');
}

/**
 * Общие границы прогона — одни и те же для всех режимов.
 *
 * Те же границы теперь ПРОВЕРЯЕТ панель (`run-permissions.ts`): попытка
 * записать файл вне разрешённого возвращается отказом. Слова всё равно нужны —
 * правило, о котором модель знает, она соблюдает сама, а отказ посреди работы
 * стоит ей целого хода и выглядит как поломка инструмента.
 */
function rulesBlock(mode: ProjectTestRunRequest['mode']): string {
  const extra =
    mode === 'automate'
      ? "- in this mode you MAY create and edit the project's TEST FILES (where they already live); still do not touch the application code;"
      : mode === 'generate'
        ? `- write ONLY into ${TESTS_DIR}/drafts/. Do not touch group files, application code or configs: the panel changes the library by applying your draft;`
        : `- change ONLY files in ${TESTS_DIR}/. Do not touch application code, configs or migrations under any pretext;`;
  return [
    'Boundaries (must not be broken):',
    extra,
    '- a bug found is a test result (status: "failed" and what exactly is wrong in note), not a reason to fix it;',
    '- commit nothing, push nothing, run no git commands that change the repository;',
    '- do not delete or rewrite cases with "source": "human";',
    CASE_LANGUAGE_LINE,
    'The boundaries are not held by conscience alone: the panel refuses writes outside what is',
    'allowed, and such a refusal is its rule, not a broken tool. There is nobody to ask for',
    'permission: the run goes without a human, an agent question will be refused — decide',
    'yourself and write the doubt into the case note.',
  ].join('\n');
}

/** Приёмы тест-дизайна: то, без чего получается набор счастливых путей. */
function methodBlock(): string {
  return [
    'Method (apply it deliberately, not for show):',
    '- equivalence classes: one value per class, not ten that mean the same;',
    '- boundaries: 0, 1, maximum, maximum+1, empty, spaces only, a very long value;',
    '- negative checks: for each critical form — what happens on invalid input, a network failure, missing permissions;',
    '- decision tables where the result depends on a combination of conditions (role × state × flag);',
    '- state transitions for wizards, sessions, queues: not only "went through to the end" but also "went back", "interrupted", "repeated";',
    '- parameters instead of case copies: one case with `parameters` instead of five nearly identical ones.',
    "  In a step's text a parameter is written as `%name` (Latin letters), its values are listed in `parameters`;",
    '- priority by risk: `blocker` — unusable without it, `high` — an everyday scenario, `medium` — ordinary, `low` — cosmetics;',
    '- `oracle` is mandatory: what exactly proves the result. "Looks right" is not an oracle;',
    "- a case is atomic and independent: it does not rely on order or on a neighbour's data, it prepares and cleans its own state;",
    '- move steps repeated 3+ times into a shared step (`_shared.steps.json`) and refer to it with `ref`;',
    '- `codePaths` — files or folders the case concerns: the panel uses them to pick what to re-check after edits;',
    '- a checklist (`type: "checklist"`) — when breadth and speed matter; a case — when reproducibility matters.',
  ].join('\n');
}

/** Текущее состояние группы — чтобы агент дополнял, а не начинал с нуля. */
function groupBlock(group: ProjectTestGroup, caseIds?: string[]): string {
  const cases = caseIds?.length
    ? group.cases.filter((item) => caseIds.includes(item.id))
    : group.cases;
  const head = `Group "${group.title}" — file ${group.file}${
    group.description ? `. ${group.description}` : ''
  }`;
  if (cases.length === 0) return `${head}\nNo cases yet.`;
  const list = cases
    .map(
      (item) =>
        `- ${item.id} [${item.status}]${item.priority ? ` (${item.priority})` : ''} ${item.title}` +
        (item.area ? ` — area ${item.area}` : '') +
        (item.precondition ? `\n    precondition: ${item.precondition}` : '') +
        (item.steps.length
          ? `\n    steps: ${item.steps.map((step) => stepLine(step)).join(' → ')}`
          : '') +
        (item.expected ? `\n    expected: ${item.expected}` : '') +
        (item.oracle ? `\n    oracle: ${item.oracle}` : ''),
    )
    .join('\n');
  return `${head}\nCases (${cases.length}):\n${list}`;
}

/** Общие шаги — чтобы агент ссылался, а не переписывал их в каждый кейс. */
function sharedBlock(shared: ProjectTestSharedStep[]): string {
  if (shared.length === 0) return '';
  const list = shared
    .map((item) => `- ${item.id}: ${item.title} (${item.steps.length} steps)`)
    .join('\n');
  return `Shared steps you can refer to with {"ref": "<id>"}:\n${list}`;
}

/** Окружение прогона: где поднимать и куда смотреть. */
function environmentBlock(environment?: ProjectTestEnvironment): string {
  if (!environment) return '';
  // Доступы называются ИМЕНАМИ переменных, и только ими: значения уже лежат в
  // окружении процесса, а в задании они превратились бы в текст, который уедет
  // в транскрипт сессии и останется там навсегда.
  const secrets = (environment.secrets ?? []).map((item) => item.name);
  const parts = [
    `Environment "${environment.title}"`,
    environment.baseUrl ? `address: ${environment.baseUrl}` : '',
    environment.browser ? `browser: ${environment.browser}` : '',
    environment.os ? `system: ${environment.os}` : '',
    environment.start ? `started with the command: ${environment.start}` : '',
    secrets.length > 0
      ? `the stand credentials are in the environment variables ${secrets.join(', ')} — take the ` +
        'values from there and do NOT print them in a case note or in the output'
      : '',
    environment.notes ?? '',
  ].filter(Boolean);
  return parts.join('. ');
}

/** Что передаётся в задание кроме самого запроса. */
export interface PromptContext {
  shared: ProjectTestSharedStep[];
  environment?: ProjectTestEnvironment;
  /** Кейсы, задетые правками рабочей копии, — для отбора «только изменённое». */
  impact?: { caseId: string; title: string; reason: string }[];
  /**
   * Файл черновика от корня проекта — единственное, что генерация пишет.
   * Имя содержит идентификатор прогона, поэтому его называет задание: сам себе
   * агент его не выдумает, а две генерации не должны попасть в один файл.
   */
  draftFile?: string;
  /**
   * Материал источника генерации: требование, дифф или провал.
   *
   * Собран панелью ДО старта. Агент не ходит за ним сам: панель уже умеет и в
   * трекер, и в git, а лишний поход стоил бы окна — того самого, в котором
   * должна поместиться библиотека.
   */
  material?: ProjectTestGenerateMaterial;
  /**
   * Папка e2e, когда генерация пишет ещё и НАСТОЯЩИЕ тесты (`e2e: true`): кейсы
   * по-прежнему черновиком, код тестов — файлами в эту папку. `command` —
   * готовая строка прогона для bash: каталог, переменные отчёта, раннер.
   */
  e2e?: { dir: string; framework: string; junit: string; command?: string };
}

/**
 * Источник генерации: чем задание отличается от «осмотри приложение».
 *
 * Каждый источник ставит СВОЮ задачу и требует своих полей у получившихся
 * кейсов — ссылку на требование, `codePaths` из диффа, ссылку на дефект. Без
 * этого «покрыть требование» неотличимо от обычной генерации, а строка в
 * матрице покрытия так и остаётся непокрытой.
 */
function sourceBlock(
  material?: ProjectTestGenerateMaterial,
  groups: ProjectTestGroup[] = [],
): string {
  if (!material) return '';

  if (material.requirement) {
    const item = material.requirement;
    return [
      `Source — REQUIREMENT ${item.key}: ${item.title}`,
      item.url ? `Link: ${item.url}` : '',
      item.description ? `Task text:\n${item.description}` : '',
      '',
      'Write cases that check exactly this requirement: acceptance scenarios,',
      'boundaries, failures. Give each case',
      `links: [{ "type": "requirement", "url": "${item.url}", "title": "${item.key}" }] —`,
      'by this link the row in the coverage matrix stops being uncovered.',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  if (material.diff) {
    const item = material.diff;
    return [
      `Source — CHANGES ${item.range}.`,
      item.summary ? `Summary: ${item.summary}` : '',
      'Files touched:',
      ...item.files.slice(0, 60).map((file) => `- ${file}`),
      item.files.length > 60 ? `…and ${item.files.length - 60} more` : '',
      '',
      'Look at these files and write cases for what changed: new behaviour, touched',
      'neighbours, failures. Give each case `codePaths` from this list — the "run what was',
      'touched" selection works by them later.',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  if (material.defect) {
    const item = material.defect;
    return [
      `Source — FAILURE of the case ${item.groupId}/${item.caseId}: ${item.title}`,
      item.note ? `What the tester saw: ${item.note}` : '',
      item.attachments.length > 0 ? `Attachments: ${item.attachments.join(', ')}` : '',
      item.url ? `Defect: ${item.url}` : '',
      'Steps of the original case:',
      ...item.steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      'Write ONE regression case that pins the fix: the steps reproducing the breakage',
      'and the expected correct behaviour. Do not touch the original case — it',
      `describes the normal scenario. Give the new case tags: ["${regressionTag(groups, item.title)}"]`,
      item.url ? `and links: [{ "type": "issue", "url": "${item.url}" }].` : '.',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  return '';
}

/**
 * Форма черновика генерации.
 *
 * Пишется дословно по той же причине, что и схема группы: файл заполняет
 * агент руками, и любое расхождение в имени поля означает потерянное
 * предложение. Удаления в форме нет намеренно — убрать кейс решает человек.
 */
function draftBlock(file: string, source = 'code'): string {
  return [
    `The result of the work is ONE file ${file} (JSON, UTF-8):`,
    '{',
    '  "version": 1,',
    '  "runId": "<from the file name>",',
    `  "source": "${source}",`,
    '  "createdAt": "ISO time",',
    '  "items": [',
    '    {',
    '      "op": "add | update",',
    '      "groupId": "gui",',
    '      "caseId": "gui-001",',
    '      "case": { … the whole case by the schema below … },',
    '      "reason": "why this case is needed and why it does not exist yet",',
    '      "similarTo": [{ "groupId": "gui", "caseId": "gui-014", "score": 0.82 }]',
    '    }',
    '  ]',
    '}',
    '`op: "update"` — if a case with this `caseId` ALREADY EXISTS in the group and you extend it;',
    'otherwise `add`. There is no deletion in the draft: a human removes cases.',
    'Fill in `similarTo` when you found a similar case in the library — the panel shows',
    'it to the human next to the proposal. Write the file IN FULL and once, at the end of the work:',
    'the panel applies it itself.',
  ].join('\n');
}

/**
 * Что покрывать, когда пожелания нет. Раздел всегда шлёт выбранную группу, и
 * «покрывай приложение целиком» сваливало весь проект в одну группу, какой бы
 * узкой она ни была; без группы (API, терминал) — по-прежнему всё приложение.
 */
function noWishLine(groups: ProjectTestGroup[], request: ProjectTestRunRequest): string {
  const group = request.groupId ? groups.find((item) => item.id === request.groupId) : undefined;
  if (!request.groupId) {
    return 'No wishes — cover the whole application, starting with what is used every day.';
  }
  const title = group?.title || request.groupId;
  const about = group?.description ? ` (${group.description})` : '';
  return (
    `No wishes — cover the topic of the group "${title}"${about}: its name, description and the ` +
    'cases already written set the boundaries. Leave the rest of the application alone — its cases do not belong in this group.'
  );
}

/**
 * Как выглядит тест в папке этого каркаса. У pytest имя кейса — первая строка
 * docstring (`e2e-parse-pytest.ts`): без этой строки в задании агент писал
 * `def test_rename()` без docstring, и кейс назывался «rename» — английским
 * именем функции среди русских кейсов.
 */
function e2eShape(framework: string, dir: string): string[] {
  if (framework === 'pytest') {
    return [
      `  (${dir}/test_<groupId>.py, every "-" of the groupId written as "_": group user-profile →`,
      `  ${dir}/test_user_profile.py), and its cases go into the draft under that groupId;`,
      '- every test gets a docstring whose FIRST line starts with the case id in brackets:',
      '  """[<caseId>] <what it proves>""" — the same caseId as in the draft; that is how the panel',
      '  links test and case, and that line becomes the case title, so write it in the language of',
      '  the case texts;',
      '- a module docstring names the group (its first line becomes the group title, in the same language);',
      '- inside each test write "# Given", "# When", "# Then" comments: they become the case steps;',
      '- mark the test @pytest.mark.smoke (critical path, the whole smoke set runs in under',
      '  10 minutes) or @pytest.mark.regression; e2e only for user-visible flows — name lower-level',
      '  checks as unit or',
    ];
  }
  return [
    `  (${dir}/<groupId>.spec.ts), and its cases go into the draft under that groupId;`,
    '- every test title starts with the case id in brackets: test("[<caseId>] <what it proves>")',
    '  — the same caseId as in the draft; that is how the panel links test and case; the rest of',
    '  the title becomes the case title, so write it in the language of the case texts;',
    '- inside each test write "// Given", "// When", "// Then" comments: they become the case steps;',
    '- tag the title @smoke (critical path, the whole smoke set runs in under 10 minutes) or',
    '  @regression; e2e only for user-visible flows — name lower-level checks as unit or',
  ];
}

/**
 * Генерация с кодом тестов: сверх черновика кейсов агент пишет спеки в папку e2e
 * и сам их гоняет, чтобы результаты легли на кейсы через junit.
 *
 * Группа = файл спеки, метка `[id]` в имени теста — ровно то, по чему панель
 * потом сводит и сверку папки (`e2e-sync.ts`), и результаты
 * (`import-results.ts`). Разойдись метка с `caseId` черновика — кейс и тест
 * жили бы порознь.
 */
function e2eBlock(
  e2e: NonNullable<PromptContext['e2e']>,
  environment: string,
  root: string,
): string {
  const report = `${e2e.dir}/${e2e.junit}`;
  // Без готовой команды путь отдаётся абсолютным: относительный Playwright
  // разрешает от каталога конфига и пишет мимо панели (F-358).
  const absolute = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/${report}`;
  return [
    `E2E TESTS — in addition to the draft, write real ${e2e.framework} tests into ${e2e.dir}/:`,
    '- propose about three user-flow groups (e.g. auth, navigation, the main form) unless the',
    '  groups above already cover them; each group is ONE test file named after the groupId',
    ...e2eShape(e2e.framework, e2e.dir),
    '  integration candidates in the case note instead of writing them as e2e;',
    '- follow the folder style: existing config, fixtures, page objects; prefer role and label',
    '  locators over CSS; no fixed sleeps; each test prepares and cleans its own state;',
    '- the panel-made folder reads the stand address from E2E_BASE_URL (set it for the run);',
    e2e.command
      ? `- run them once with exactly this command (it writes the junit report to ${report}): ${e2e.command}`
      : `- run them once with the junit reporter writing ${absolute} (an absolute path);`,
    '  the panel reads that report and puts the results on the cases; the runner is never',
    '  installed on the fly (npx --no-install) — if it is missing, say so instead of installing;',
    '- a test that passes only on retry is flaky: keep it and say so in the case note; a red test',
    '  is a finding, never a reason to weaken the assertion or delete the test;',
    '- no stand URL and nothing starts locally — still write the specs, skip the run, and say why',
    '  in the final line.',
    environment ? `Stand: ${environment}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Задание на генерацию: изучить приложение и написать кейсы. */
function generatePrompt(
  groups: ProjectTestGroup[],
  request: ProjectTestRunRequest,
  context: PromptContext,
): string {
  const targets = groups.map((group) => groupBlock(group)).join('\n\n');
  const draft = context.draftFile ?? `${TESTS_DIR}/drafts/<runId>.draft.json`;
  return [
    'You are putting together a set of test cases for THIS project. You work in its directory.',
    '',
    'What to do:',
    '1. Understand what application this is: screens, sections, roles, main scenarios.',
    '   Look at the UI code, routes, label dictionaries, data schemas — nothing needs to be started.',
    '2. Describe the checks by the method below. Use the real screens and the real labels.',
    '3. Sort them by area (`area`) and section (`section`), set the priority and `codePaths`.',
    '4. Compare with what is already written: extend a similar case (`op: "update"`) instead of a duplicate',
    '   and name it in `similarTo`. Start a new group by naming its `groupId` in the edit —',
    '   the panel creates the group file.',
    // Группа — выбор человека на старте, и панель всё равно переложит новые кейсы
    // в неё; сказать агенту заранее дешевле, чем переименовывать id после.
    ...(request.groupId
      ? [
          `   Put new cases (\`op: "add"\`) into the group \`${request.groupId}\` — the human chose it;`,
          '   an edit of an existing case stays in its group.',
        ]
      : []),
    `5. Write ONE draft file ${draft}. Do not touch group files: the panel changes the library`,
    '   by applying the draft. This is not a wish — the run has no rights to them.',
    '',
    // Источник стоит ПЕРЕД пожеланием: он меняет саму задачу, а пожелание
    // только сужает её. Пусто — обычная генерация по коду.
    sourceBlock(context.material, groups),
    '',
    request.scope ? `The human's wish: ${request.scope}` : noWishLine(groups, request),
    '',
    targets || 'No groups yet — create them yourself.',
    '',
    sharedBlock(context.shared),
    '',
    methodBlock(),
    '',
    draftBlock(draft, request.source ?? 'code'),
    '',
    schemaBlock(),
    '',
    rulesBlock('generate'),
    '',
    // Код тестов — после границ: он и есть то единственное, что им разрешено сверх черновика.
    context.e2e
      ? e2eBlock(context.e2e, environmentBlock(context.environment), request.projectPath)
      : '',
    '',
    context.e2e
      ? 'The status of new cases is "unknown": the panel sets the results from the junit report.'
      : 'The status of new cases is "unknown": checking is done by a separate run, here only the description.',
    'At the end, answer in one line: how many cases are proposed to add and how many to extend.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Задание на прогон: пройти кейсы живьём и проставить статусы. */
function runPrompt(
  groups: ProjectTestGroup[],
  request: ProjectTestRunRequest,
  context: PromptContext,
): string {
  const targets = groups.map((group) => groupBlock(group, request.caseIds)).join('\n\n');
  const count = groups.reduce(
    (sum, group) =>
      sum +
      (request.caseIds?.length
        ? group.cases.filter((item) => request.caseIds?.includes(item.id)).length
        : group.cases.length),
    0,
  );
  const environment = environmentBlock(context.environment);

  // Недостающая проверка — предложение, а не запись в группу: библиотеку меняет
  // человек через приёмку, и прогон здесь не исключение.
  const draft = context.draftFile ?? `${TESTS_DIR}/drafts/<runId>.draft.json`;

  return [
    'You are running the test cases of THIS project. You work in its directory.',
    '',
    'What to do:',
    environment
      ? `1. Start the application if it is not running, and open it. ${environment}`
      : "1. Start the application if it is not running (the project's dev server), and open it.",
    '2. For each case, first carry out its `precondition`, then go through the steps LIVE —',
    '   pressing and looking at the result, not reasoning about the code. Compare the result with `oracle` if it is set.',
    '   Drive the browser with what the project has (Playwright and the like); nothing to drive it with — say so in note.',
    '3. Right after EACH case, write its result into the group file: `status`, `note` (what you saw),',
    '   `lastRunAt` (the current time in ISO **UTC**, with the letter Z: `node -e "console.log(new Date().toISOString())"`; local time with Z —',
    '   is an error of hours). The panel reads the file during the run and shows the ticks —',
    '   writing in a batch at the end is not allowed. Do not fill in `lastRunId`: the panel sets it.',
    '4. Tell the statuses apart: `failed` — the application does not work as expected; `blocked` — the check',
    "   cannot be reached because of someone else's breakage; `skipped` — nothing to check with or nothing to apply it to (reason in note).",
    '5. ANALYSE a failure, do not just state it. For a failed or blocked case fill in `failure`:',
    '   `step` — the number of the step where it diverged (from one), `expected` — what should have been at',
    '   THIS step, `actual` — what actually came out. "Does not work" without a step number can be neither',
    '   reproduced nor filed as a defect.',
    '6. A failed case — attach evidence: a screenshot or a piece of log in',
    `   ${TESTS_DIR}/attachments/<case id>/ and list the paths in the case's \`attachments\` field.`,
    '   No evidence — write the result anyway: the panel marks it as unproven,',
    '   and a lost result is worse than an incomplete one.',
    '7. Run a failed case a SECOND TIME, right away, in this same run. The same outcome —',
    '   `failure.retry: "confirmed"`. It differed — `failure.retry: "flaky"`, what came out the second time',
    '   in `failure.retryNote`, and describe both attempts in `note`: a case that gives different answers on the',
    '   same code is a broken test, and silently keeping one of the attempts is lying both ways.',
    '8. Noticed a check that is missing — do NOT write it into the group file: put a proposal into',
    `   the draft ${draft} (JSON: {"version":1,"runId":"<from the file name>","source":"run",`,
    '   "createdAt":"ISO","items":[{"op":"add","groupId":"<group>","caseId":"<new id>",',
    '   "case":{…case by the schema…},"reason":"why"}]}). The panel shows it to the human for acceptance.',
    '   But first finish the run.',
    '',
    request.scope ? `The human's wish: ${request.scope}` : '',
    request.full
      ? 'This is a full re-test: go through everything again, do not trust past ticks.'
      : '',
    context.impact?.length
      ? `Edits in the working copy touched these cases — start with them:\n${context.impact
          .map((item) => `- ${item.caseId}: ${item.title} (${item.reason})`)
          .join('\n')}`
      : '',
    '',
    `Cases to check: ${count}.`,
    '',
    targets,
    '',
    sharedBlock(context.shared),
    '',
    schemaBlock(),
    '',
    rulesBlock('run'),
    '',
    'At the end, answer in one line: how many passed, how many failed, how many blocked, how many skipped.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Задание на свободный поиск: найти то, на что кейсов ещё нет. */
function explorePrompt(
  groups: ProjectTestGroup[],
  request: ProjectTestRunRequest,
  context: PromptContext,
): string {
  const targets = groups.map((group) => groupBlock(group)).join('\n\n');
  const environment = environmentBlock(context.environment);
  return [
    'You are running an exploratory session on THIS application — a free search, not a run through a list.',
    '',
    environment ? `Where to look: ${environment}` : '',
    `Session charter: ${request.scope || 'the most used scenarios and their edges'}.`,
    'Limit yourself to about an hour of work and do not leave the charter.',
    '',
    'How to search (tours):',
    '- the "bad input" tour: empty, spaces, very long, special characters, the wrong keyboard layout, a paste from the clipboard;',
    '- the "interruption" tour: a page reload in the middle of a scenario, the "back" button, two tabs, a lost network;',
    '- the "data boundaries" tour: zero items, one, very many, long names, identical names;',
    '- the "permissions and states" tour: without permissions, with an expired session, in read-only mode;',
    '- the "repeat" tour: the same action twice in a row, a double click, a race of requests.',
    '',
    'What to record:',
    request.groupId
      ? `- new cases — only into the group "${request.groupId}": the human chose it for this session;`
      : '',
    '- every problem found — as a new case in a fitting group with `status: "failed"`, reproduction steps and `note`;',
    '  fill in `failure` for such a case: `step` — the number of the step where it diverged (from one), `expected` —',
    '  what should have been at THIS step, `actual` — what came out. "Does not work" without a step cannot be reproduced;',
    '- every check that passed but was not in the set — as a new case with `status: "passed"`;',
    '- every new case has `"source": "agent"` and `lastRunAt` — the current time in ISO **UTC** with the letter Z',
    '  (`node -e "console.log(new Date().toISOString())"`; local time with Z is an error of hours). Do not fill in `lastRunId`: the panel sets it;',
    "- a new case's id is the group prefix and the next free number: a taken id overwrites someone else's case;",
    '- do not change the status of existing cases: this is a search, not a run, and its tick would pass off',
    '  a case not walked through step by step as checked;',
    `- evidence (screenshots, logs) — into ${TESTS_DIR}/attachments/<case id>/, the paths into the \`attachments\` field.`,
    '',
    targets || 'No groups yet — create them yourself.',
    '',
    schemaBlock(),
    '',
    rulesBlock('explore'),
    '',
    'At the end, answer in one line: how many problems were found and how many cases were added.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Задание на автоматизацию: превратить стабильные кейсы в код. */
function automatePrompt(groups: ProjectTestGroup[], request: ProjectTestRunRequest): string {
  const targets = groups.map((group) => groupBlock(group, request.caseIds)).join('\n\n');
  return [
    'You are turning the manual cases of THIS project into automated tests. You work in its directory.',
    '',
    'What to do:',
    '1. Find what the project is already tested with (Playwright, vitest, jest, pytest — look at package.json and the test folders)',
    '   and write in THE SAME style and in the same place as the existing tests. Do not introduce a new framework.',
    '2. Take the cases in order: first `passed` with a high priority, then the rest.',
    '   Skip a case with `automation.status: "automated"` — it is already in code.',
    '3. For each automated case: write the test, RUN it and make sure it is green,',
    '   then set `automation` in the case: `{"status": "automated", "file": "path",',
    '   "testName": "test name", "externalId": "<case id>"}`.',
    '4. Start the test name with the case id in brackets — `[gui-001] sending a message`.',
    '   This is not decoration: only the test name comes back from CI, and by this tag (or, if it is missing, by',
    '   `externalId`) the panel matches results to cases. Without them the result lands in "unrecognised".',
    '5. Do not leave a test you could not make stable red: delete it and write the reason',
    "   into the case's `note`, and leave `automation.status` at `toAutomate`.",
    '',
    request.scope ? `The human's wish: ${request.scope}` : '',
    '',
    targets,
    '',
    schemaBlock(),
    '',
    rulesBlock('automate'),
    '',
    'At the end, answer in one line: how many cases were automated, how many postponed and why.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Задание агенту под запрошенный режим. */
export function buildPrompt(
  groups: ProjectTestGroup[],
  request: ProjectTestRunRequest,
  context: PromptContext = { shared: [] },
): string {
  if (request.mode === 'generate') return generatePrompt(groups, request, context);
  if (request.mode === 'explore') return explorePrompt(groups, request, context);
  if (request.mode === 'automate') return automatePrompt(groups, request);
  return runPrompt(groups, request, context);
}

/** Слова имени сессии на языке панели: имя видно в списке разговоров. */
const RUN_NAME_WORDS = {
  ru: {
    all: 'все группы',
    requirement: 'Тесты: требование',
    diff: 'Тесты: по диффу',
    defect: 'Тесты: регресс',
    generate: 'Тесты: генерация',
    explore: 'Тесты: исследование',
    automate: 'Тесты: автоматизация',
    run: 'Тесты: прогон',
  },
  en: {
    all: 'all groups',
    requirement: 'Tests: requirement',
    diff: 'Tests: from the diff',
    defect: 'Tests: regression',
    generate: 'Tests: generation',
    explore: 'Tests: exploration',
    automate: 'Tests: automation',
    run: 'Tests: run',
  },
} as const;

/**
 * Имя сессии: под ним прогон видно в списке разговоров — на языке панели, как
 * всё остальное в этом списке.
 */
export function runName(
  request: ProjectTestRunRequest,
  groups: ProjectTestGroup[],
  lang: 'ru' | 'en' = 'ru',
): string {
  const words = RUN_NAME_WORDS[lang];
  const where = request.groupId ? (groups[0]?.title ?? request.groupId) : words.all;
  // Источник в имени разговора: три генерации подряд из разных источников иначе
  // выглядят в списке одинаково, а искать среди них будут именно по нему.
  if (request.mode === 'generate') {
    if (request.source === 'requirement')
      return `${words.requirement} ${request.sourceRef ?? ''}`.trim();
    if (request.source === 'diff') return `${words.diff} — ${where}`;
    if (request.source === 'defect')
      return `${words.defect} — ${request.sourceCase?.caseId ?? where}`;
    return `${words.generate} — ${where}`;
  }
  if (request.mode === 'explore') return `${words.explore} — ${where}`;
  if (request.mode === 'automate') return `${words.automate} — ${where}`;
  return `${words.run} — ${where}`;
}

/** Файл группы от корня проекта — маршрутам он нужен для сообщений об ошибке. */
export { groupFile };
