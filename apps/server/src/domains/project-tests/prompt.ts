import type {
  ProjectTestEnvironment,
  ProjectTestGroup,
  ProjectTestRunRequest,
  ProjectTestSharedStep,
} from '@agentdeck/contracts';
import { stepText } from '@agentdeck/contracts/test-format';
import { TESTS_DIR } from './files.ts';
import { groupFile } from './store.ts';

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
 */

/** Схема файла — агент пишет его руками, поэтому форма описана дословно. */
function schemaBlock(): string {
  return [
    'Формат файла группы (JSON, UTF-8):',
    '{',
    '  "version": 1,',
    '  "title": "GUI",',
    '  "description": "о чём эта группа",',
    '  "cases": [',
    '    {',
    '      "id": "gui-001",',
    '      "type": "case | checklist",',
    '      "title": "коротко, что проверяем",',
    '      "purpose": "зачем этот тест нужен",',
    '      "area": "зона приложения: chat, analytics, settings…",',
    '      "section": "путь в дереве: Чат/Вложения",',
    '      "precondition": "с какого состояния начинать",',
    '      "steps": [',
    '        { "action": "что нажать", "data": "что ввести", "expected": "что видно на этом шаге" },',
    '        { "ref": "login", "action": "Войти под тестовым пользователем" }',
    '      ],',
    '      "expected": "итог всего сценария",',
    '      "postcondition": "что вернуть после проверки",',
    '      "oracle": "чем доказывается результат: текст на экране, запись в базе, ответ сети",',
    '      "priority": "blocker | high | medium | low",',
    '      "readiness": "draft | ready | obsolete",',
    '      "duration": 5,',
    '      "tags": ["smoke"],',
    '      "links": [{ "type": "requirement | issue | mr | doc", "url": "…" }],',
    '      "parameters": [{ "name": "role", "values": ["admin", "guest"] }],',
    '      "codePaths": ["apps/web/src/pages/Chat"],',
    '      "automation": { "status": "manual | toAutomate | automated", "file": "…", "testName": "…" },',
    '      "status": "unknown | passed | failed | skipped | blocked",',
    '      "note": "что увидел на самом деле — заполняется прогоном",',
    '      "lastRunAt": "ISO-время прогона",',
    '      "source": "agent | human"',
    '    }',
    '  ]',
    '}',
    'Старая форма (шаги строками) читается по-прежнему, но пиши новую.',
    '`id` менять нельзя: по нему панель сводит правки. `source: "human"` — кейс',
    'написан человеком: такой можно дополнить, но НЕЛЬЗЯ удалить и нельзя',
    'переписать его смысл.',
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
      ? '- в этом режиме РАЗРЕШЕНО создавать и править ФАЙЛЫ ТЕСТОВ проекта (там, где они уже лежат); код приложения по-прежнему не трогай;'
      : `- меняй ТОЛЬКО файлы в ${TESTS_DIR}/. Код приложения, конфиги, миграции не трогай ни под каким предлогом;`;
  return [
    'Границы (нарушать нельзя):',
    extra,
    '- нашёл баг — это результат теста (status: "failed" и что именно не так в note), а не повод чинить;',
    '- ничего не коммить, не пушить, не запускать git-команды, меняющие репозиторий;',
    '- не удаляй и не переписывай кейсы с "source": "human";',
    '- пиши по-русски.',
    'Границы держит не только совесть: запись вне разрешённого панель отклоняет,',
    'и такой отказ — это её правило, а не поломка инструмента. Спрашивать разрешение',
    'некого: прогон идёт без человека, вопрос агента будет отклонён — решай сам и пиши',
    'сомнение в note кейса.',
  ].join('\n');
}

/** Приёмы тест-дизайна: то, без чего получается набор счастливых путей. */
function methodBlock(): string {
  return [
    'Методика (применяй осознанно, а не для галочки):',
    '- классы эквивалентности: одно значение на класс, а не десять одинаковых по смыслу;',
    '- границы: 0, 1, максимум, максимум+1, пусто, только пробелы, очень длинное значение;',
    '- негативные проверки: на каждую критичную форму — что будет при неверном вводе, отказе сети, отсутствии прав;',
    '- таблицы решений там, где результат зависит от комбинации условий (роль × состояние × флаг);',
    '- переходы состояний для мастеров, сессий, очередей: не только «прошёл до конца», но и «вернулся назад», «прервал», «повторил»;',
    '- параметры вместо копий кейса: один кейс с `parameters` вместо пяти почти одинаковых.',
    '  В тексте шага параметр пишется как `%имя` (латиницей), значения перечисляются в `parameters`;',
    '- приоритет по риску: `blocker` — без этого нельзя пользоваться, `high` — ежедневный сценарий, `medium` — обычный, `low` — косметика;',
    '- `oracle` обязателен: чем именно доказывается результат. «Выглядит правильно» — не оракул;',
    '- кейс атомарен и независим: не опирается на порядок и на данные соседа, сам готовит и убирает состояние;',
    '- повторяющиеся 3+ раза шаги выноси в общий шаг (`_shared.steps.json`) и ссылайся `ref`;',
    '- `codePaths` — файлы или папки, которых кейс касается: по ним панель отбирает, что перепроверить после правок;',
    '- чек-лист (`type: "checklist"`) — когда важна широта и скорость; кейс — когда важна воспроизводимость.',
  ].join('\n');
}

/** Текущее состояние группы — чтобы агент дополнял, а не начинал с нуля. */
function groupBlock(group: ProjectTestGroup, caseIds?: string[]): string {
  const cases = caseIds?.length
    ? group.cases.filter((item) => caseIds.includes(item.id))
    : group.cases;
  const head = `Группа «${group.title}» — файл ${group.file}${
    group.description ? `. ${group.description}` : ''
  }`;
  if (cases.length === 0) return `${head}\nКейсов пока нет.`;
  const list = cases
    .map(
      (item) =>
        `- ${item.id} [${item.status}]${item.priority ? ` (${item.priority})` : ''} ${item.title}` +
        (item.area ? ` — зона ${item.area}` : '') +
        (item.precondition ? `\n    предусловие: ${item.precondition}` : '') +
        (item.steps.length
          ? `\n    шаги: ${item.steps.map((step) => stepText(step)).join(' → ')}`
          : '') +
        (item.expected ? `\n    ожидание: ${item.expected}` : '') +
        (item.oracle ? `\n    оракул: ${item.oracle}` : ''),
    )
    .join('\n');
  return `${head}\nКейсы (${cases.length}):\n${list}`;
}

/** Общие шаги — чтобы агент ссылался, а не переписывал их в каждый кейс. */
function sharedBlock(shared: ProjectTestSharedStep[]): string {
  if (shared.length === 0) return '';
  const list = shared
    .map((item) => `- ${item.id}: ${item.title} (${item.steps.length} шагов)`)
    .join('\n');
  return `Общие шаги, на которые можно ссылаться через {"ref": "<id>"}:\n${list}`;
}

/** Окружение прогона: где поднимать и куда смотреть. */
function environmentBlock(environment?: ProjectTestEnvironment): string {
  if (!environment) return '';
  const parts = [
    `Окружение «${environment.title}»`,
    environment.baseUrl ? `адрес: ${environment.baseUrl}` : '',
    environment.browser ? `браузер: ${environment.browser}` : '',
    environment.os ? `система: ${environment.os}` : '',
    environment.start ? `поднимается командой: ${environment.start}` : '',
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
}

/** Задание на генерацию: изучить приложение и написать кейсы. */
function generatePrompt(
  groups: ProjectTestGroup[],
  request: ProjectTestRunRequest,
  context: PromptContext,
): string {
  const targets = groups.map((group) => groupBlock(group)).join('\n\n');
  return [
    'Ты составляешь набор тест-кейсов по ЭТОМУ проекту. Работаешь в его каталоге.',
    '',
    'Что сделать:',
    '1. Разберись, что за приложение перед тобой: экраны, разделы, роли, основные сценарии.',
    '   Смотри код интерфейса, маршруты, словари подписей, схемы данных — запускать ничего не нужно.',
    '2. Опиши проверки по методике ниже. Бери реальные экраны и реальные подписи.',
    '3. Разложи по зонам (`area`) и по секциям (`section`), проставь приоритет и `codePaths`.',
    '4. Сверься с тем, что уже написано: похожий кейс дополни вместо дубля, устаревший (функции больше нет) удали.',
    '5. Запиши файлы групп. Новую группу заводи файлом ' +
      `${TESTS_DIR}/<имя>${'.tests.json'} — она сама станет вкладкой в панели.`,
    '',
    request.scope
      ? `Пожелание человека: ${request.scope}`
      : 'Пожеланий нет — покрывай приложение целиком, начиная с того, чем пользуются каждый день.',
    '',
    targets || 'Групп пока нет — заведи их сам.',
    '',
    sharedBlock(context.shared),
    '',
    methodBlock(),
    '',
    schemaBlock(),
    '',
    rulesBlock('generate'),
    '',
    'Статусы новых кейсов — "unknown": проверка делается отдельным прогоном, здесь только описание.',
    'В конце ответь одной строкой: сколько кейсов добавлено, сколько обновлено, сколько удалено.',
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

  return [
    'Ты прогоняешь тест-кейсы по ЭТОМУ проекту. Работаешь в его каталоге.',
    '',
    'Что сделать:',
    environment
      ? `1. Подними приложение, если оно не поднято, и открой его. ${environment}`
      : '1. Подними приложение, если оно не поднято (dev-сервер проекта), и открой его.',
    '2. Для каждого кейса сначала выполни его `precondition`, потом пройди шаги ЖИВЬЁМ —',
    '   нажимая и глядя на результат, а не рассуждая о коде. Результат сверяй с `oracle`, если он задан.',
    '   Браузером управляй тем, что есть в проекте (Playwright и подобное); нечем — так и напиши в note.',
    '3. Сразу после КАЖДОГО кейса запиши его результат в файл группы: `status`, `note` (что увидел),',
    '   `lastRunAt` (текущее время в ISO). Панель читает файл по ходу прогона и показывает галочки —',
    '   пачкой в конце писать нельзя.',
    '4. Статусы различай: `failed` — приложение работает не так, как ожидалось; `blocked` — до проверки',
    '   не дойти из-за чужой поломки; `skipped` — проверять нечем или не к чему применить (причина в note).',
    '5. Провалил кейс — приложи доказательство: скриншот или кусок лога в',
    `   ${TESTS_DIR}/attachments/<id кейса>/ и перечисли пути в поле \`attachments\` результата.`,
    '6. Заметил проверку, которой не хватает, — добавь новый кейс со `status: "unknown"`,',
    '   но сначала доведи прогон до конца.',
    '',
    request.scope ? `Пожелание человека: ${request.scope}` : '',
    request.full ? 'Это полный перетест: проходи всё заново, прошлым галочкам не верь.' : '',
    context.impact?.length
      ? `Правки в рабочей копии задели эти кейсы — начни с них:\n${context.impact
          .map((item) => `- ${item.caseId}: ${item.title} (${item.reason})`)
          .join('\n')}`
      : '',
    '',
    `Проверить кейсов: ${count}.`,
    '',
    targets,
    '',
    sharedBlock(context.shared),
    '',
    schemaBlock(),
    '',
    rulesBlock('run'),
    '',
    'В конце ответь одной строкой: сколько пройдено, сколько провалено, сколько заблокировано, сколько пропущено.',
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
    'Ты проводишь исследовательскую сессию по ЭТОМУ приложению — свободный поиск, а не прогон по списку.',
    '',
    environment ? `Где смотреть: ${environment}` : '',
    `Хартия сессии: ${request.scope || 'самые используемые сценарии и их края'}.`,
    'Ограничь себя примерно часом работы и не уходи из хартии.',
    '',
    'Как искать (туры):',
    '- тур «плохой ввод»: пусто, пробелы, очень длинное, спецсимволы, чужая раскладка, вставка из буфера;',
    '- тур «прерывание»: перезагрузка страницы посреди сценария, кнопка «назад», две вкладки, потеря сети;',
    '- тур «границы данных»: ноль элементов, один, очень много, длинные имена, одинаковые имена;',
    '- тур «права и состояния»: без прав, с истёкшей сессией, в режиме только для чтения;',
    '- тур «повтор»: то же действие дважды подряд, двойной клик, гонка запросов.',
    '',
    'Что записать:',
    `- каждую найденную проблему — новым кейсом в подходящей группе со \`status: "failed"\`, шагами воспроизведения и \`note\`;`,
    '- каждую проверку, которая прошла, но её не было в наборе, — новым кейсом со `status: "passed"`;',
    '- доказательства (скриншоты) — в `attachments`.',
    '',
    targets || 'Групп пока нет — заведи их сам.',
    '',
    schemaBlock(),
    '',
    rulesBlock('explore'),
    '',
    'В конце ответь одной строкой: сколько проблем найдено и сколько кейсов добавлено.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Задание на автоматизацию: превратить стабильные кейсы в код. */
function automatePrompt(groups: ProjectTestGroup[], request: ProjectTestRunRequest): string {
  const targets = groups.map((group) => groupBlock(group, request.caseIds)).join('\n\n');
  return [
    'Ты превращаешь ручные кейсы ЭТОГО проекта в автотесты. Работаешь в его каталоге.',
    '',
    'Что сделать:',
    '1. Найди, чем проект уже тестируется (Playwright, vitest, jest, pytest — смотри package.json и папки тестов)',
    '   и пиши в ТОМ ЖЕ стиле и в том же месте, что существующие тесты. Новый фреймворк не заводи.',
    '2. Бери кейсы по порядку: сначала `passed` с высоким приоритетом, потом остальные.',
    '   Кейс с `automation.status: "automated"` пропускай — он уже в коде.',
    '3. На каждый автоматизированный кейс: напиши тест, ЗАПУСТИ его и убедись, что он зелёный,',
    '   затем проставь в кейсе `automation`: `{"status": "automated", "file": "путь", "testName": "имя теста"}`.',
    '   Имя теста делай таким, чтобы в нём был идентификатор кейса — по нему панель сводит результаты из CI.',
    '4. Тест, который не удалось сделать устойчивым, не оставляй красным: удали его и напиши причину',
    '   в `note` кейса, а `automation.status` оставь `toAutomate`.',
    '',
    request.scope ? `Пожелание человека: ${request.scope}` : '',
    '',
    targets,
    '',
    schemaBlock(),
    '',
    rulesBlock('automate'),
    '',
    'В конце ответь одной строкой: сколько кейсов автоматизировано, сколько отложено и почему.',
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

/** Имя сессии: под ним прогон видно в списке разговоров. */
export function runName(request: ProjectTestRunRequest, groups: ProjectTestGroup[]): string {
  const where = request.groupId ? (groups[0]?.title ?? request.groupId) : 'все группы';
  if (request.mode === 'generate') return `Тесты: генерация — ${where}`;
  if (request.mode === 'explore') return `Тесты: исследование — ${where}`;
  if (request.mode === 'automate') return `Тесты: автоматизация — ${where}`;
  return `Тесты: прогон — ${where}`;
}

/** Файл группы от корня проекта — маршрутам он нужен для сообщений об ошибке. */
export { groupFile };
