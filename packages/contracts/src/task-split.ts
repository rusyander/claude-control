/**
 * Разделение списка задач по нескольким чатам — формат канала и его разбор.
 *
 * Канал — блок в ОТВЕТЕ агента, а не вызов инструмента: текст умеет любой CLI, а
 * инструменты — только Claude, и формат тогда существовал бы в двух видах. Агент
 * выводит один блок
 *
 * ```claude-control:split
 * {"shared":"…","groups":[{"title":"…","branch":"…","tasks":["…"],"brief":"…"}]}
 * ```
 *
 * панель его прячет из показа и рисует на его месте карточку «делать здесь по
 * очереди / разделить на N чатов». Никаких субагентов: каждая группа — обычный
 * чат, в котором человек разговаривает сам.
 *
 * Модуль намеренно САМОДОСТАТОЧЕН и без zod: его значения (не только типы) нужны
 * и серверу, и обоим отрисовщикам ленты, а сервер работает без сборки
 * (`--experimental-strip-types`) и падает на импорте значения из бочки
 * контрактов. Отсюда же ручная проверка вместо схемы — она одна и та же на
 * стороне разбора ответа и на стороне приёма запроса, поэтому разойтись двум
 * пониманиям формата негде.
 */

/** Язык блока: он же признак, по которому панель узнаёт предложение. */
export const SPLIT_BLOCK_LANG = 'claude-control:split';

/** Потолки: предложение приходит из ответа модели, а не из формы. */
export const SPLIT_MAX_GROUPS = 8;
export const SPLIT_MAX_TASKS_PER_GROUP = 50;
const MAX_TITLE = 120;
const MAX_BRANCH = 120;
const MAX_TASK = 2_000;
const MAX_BRIEF = 4_000;
const MAX_SHARED = 4_000;

/** Одна группа задач: свой чат, своя ветка, своя рабочая копия. */
export interface TaskSplitGroup {
  /** Название группы — заголовок вкладки и строка карточки. */
  title: string;
  /** Ветка (и имя каталога копии), под которой пойдёт этот чат. */
  branch: string;
  /** Сами задачи группы, по одной строкой. */
  tasks: string[];
  /** Что важно знать этому чату сверх списка задач. */
  brief?: string;
}

/** Предложение агента: общий контекст плюс группы. */
export interface TaskSplitProposal {
  /** Контекст, который уходит в КАЖДЫЙ чат: общие правила, стек, договорённости. */
  shared?: string;
  groups: TaskSplitGroup[];
}

/** Чат, заведённый под группу. */
export interface TaskSplitStarted {
  title: string;
  /** Ветка, под которой в итоге завели копию: занятое имя получает суффикс. */
  branch: string;
  /** Ключ прогона и разговора — под ним чат живёт в реестре и в памяти вкладки. */
  chatId: string;
  /** Рабочий каталог чата: копия репозитория либо сам проект. */
  path: string;
  /** Копия заведена git-ом (иначе чат идёт в том же каталоге). */
  isWorktree: boolean;
  /** Прогон запущен сразу; иначе в чат положен только текст задания. */
  started: boolean;
  /** Задание группы целиком — им засевается поле ввода, когда прогон не пускали. */
  prompt: string;
}

/** Группа, которую завести не удалось: остальные при этом не откатываются. */
export interface TaskSplitFailure {
  title: string;
  branch: string;
  message: string;
}

/** Ответ на разделение: что завелось и что нет. */
export interface TaskSplitResult {
  chats: TaskSplitStarted[];
  failures: TaskSplitFailure[];
}

/**
 * Одна строка, которая дописывается к системному промпту прогона (у чужих CLI —
 * приписывается к промпту сверху). Именно ОДНА: на Windows аргумент уезжает через
 * оболочку, а перевод строки внутри аргумента cmd.exe разрывает командную строку.
 */
export const SPLIT_SYSTEM_PROMPT =
  'Если в одном сообщении пришло три или более независимых задач, не берись за них подряд — ' +
  'сначала предложи разделение. ' +
  // Планка занижалась на живых прогонах до абсурда: «убрать лишние импорты в
  // трёх файлах» уезжало тремя задачами, и человек получал предложение делить
  // на каждый чих. Задача — то, что решается отдельно и своим решением; одна и
  // та же правка в десяти файлах остаётся ОДНОЙ задачей, сколько бы файлов ни
  // задела. Предлагать разделение чаще одного раза за разговор нельзя: человек,
  // отказавшийся один раз, отказался не от этой формулировки, а от дробления.
  'Независимых — значит разных по сути, каждую можно сдать отдельно, и решение одной ничего не ' +
  'решает в другой. Одна и та же правка во многих файлах — ОДНА задача, сколько бы файлов она ни ' +
  'задела; перечисление файлов, шагов одной работы или пунктов одного рефакторинга задачами не ' +
  'считается. Предложи не больше одного раза за разговор: отказались или промолчали — работай ' +
  'дальше сам и больше не спрашивай, пока не попросят. ' +
  'Сгруппируй задачи так, чтобы группы не пересекались по файлам, ' +
  `и выведи РОВНО ОДИН блок кода с языком ${SPLIT_BLOCK_LANG}, внутри — JSON вида ` +
  '{"shared":"общий контекст для всех","groups":[{"title":"название","branch":"feature/имя",' +
  '"tasks":["задача","задача"],"brief":"что важно этой группе"}]}. ' +
  // Формат придуман этой панелью, снаружи его не существует: модель не может
  // «вспомнить» его правильно и раз за разом подменяет имена полей (files,
  // prompt, name). Разбор такие подмены переживает, но карточка честнее, когда
  // поля названы как надо, — поэтому имена перечислены явно и закрыто.
  'Имена полей ровно эти и никакие другие: у группы — title, branch, tasks, brief; ' +
  'tasks — всегда МАССИВ строк, по строке на задачу, даже если задача одна; shared — СТРОКА. ' +
  // Порождённый чат — чистая сессия в другом каталоге: этого разговора он не
  // видит вовсе. Живой прогон показал, чем это кончается: модель складывает
  // смысл в заголовок («Тесты: src/index.test.js»), tasks не пишет, и агент в
  // новой ветке получает вместо задания название колонки.
  'Задачу в tasks пиши ЦЕЛИКОМ, своими словами и со всеми условиями: новый чат — чистая ' +
  'сессия в своей копии репозитория, этого разговора он не увидит, и кроме shared и tasks ' +
  'у него не будет ничего. Название группы — не задание. ' +
  'Ветку называй короткой латиницей, имена групп — на языке собеседника. ' +
  'Панель покажет человеку карточку выбора вместо этого блока, поэтому не пересказывай JSON словами. ' +
  'Заводить ветки, копии репозитория и чаты самому НЕ нужно и нечем: всё это делает панель, ' +
  'когда человек нажмёт кнопку в карточке. ' +
  'После блока остановись и жди решения. ' +
  'Если задачи связаны между собой или их меньше трёх — блока не выводи и работай как обычно.';

/** Строка нужной длины или undefined: пустое поле лучше пустой строки. */
function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

/**
 * То же, но принимает и СПИСОК строк. Живой ответ модели присылал
 * `"shared": []` и `"shared": ["…", "…"]` там, где инструкция просит строку:
 * поле у неё «общий контекст», а контекст естественно перечислять пунктами.
 * Пустой список — это отсутствие контекста, а не пустая строка.
 */
function textOrList(value: unknown, limit: number): string | undefined {
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => text(item, limit))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join('\n').slice(0, limit) : undefined;
  }
  return text(value, limit);
}

/**
 * Кириллица в латиницу — для имени ветки, выведенного из названия группы.
 * Имена групп модель пишет на языке собеседника (так сказано в инструкции), а
 * каталог копии называется веткой, и кириллица в пути ломается ровно там, где
 * её меньше всего ждут: в аргументах git, в консоли Windows, в bundler-ах.
 */
const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/**
 * Имя ветки из названия группы — запасной путь, когда модель поле `branch` не
 * прислала. Раньше такая группа отбрасывалась целиком, и предложение из пяти
 * групп молча превращалось в сырой JSON в ленте. Придумать имя безопасно:
 * человек видит его в карточке ДО того, как что-то заводится, а занятое имя
 * git всё равно разведёт суффиксом.
 */
function branchFromTitle(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[а-яё]/g, (letter) => TRANSLIT[letter] ?? '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug ? `task/${slug}` : `task/group-${index + 1}`;
}

/**
 * Список задач группы. Кроме `tasks` принимаем и то, чем модель его подменяет:
 * `prompt` целым текстом задания, `task`/`items` — теми же списками под другим
 * именем. Причина не в красоте: инструкция уезжает ОДНОЙ строкой системного
 * промпта, и модель регулярно пересказывает её своими полями — а панель на этом
 * отбрасывала предложение целиком и молча.
 */
function taskList(group: Record<string, unknown>): string[] {
  const direct = group.tasks ?? group.task ?? group.items ?? group.prompt;

  if (Array.isArray(direct)) {
    return direct
      .slice(0, SPLIT_MAX_TASKS_PER_GROUP)
      .map((task) => text(task, MAX_TASK))
      .filter((task): task is string => Boolean(task));
  }

  // Одной строкой приходит готовое задание целиком — оно и есть содержание
  // группы. Режем по длине задания, а не по длине пункта: это не пункт.
  const single = text(direct, MAX_BRIEF);
  return single ? [single] : [];
}

/**
 * Памятка группы. `files` — не памятка, но и терять её нельзя: модель называет
 * ими границы группы, и в задании это ровно то, что агенту нужно знать первым.
 */
function briefOf(group: Record<string, unknown>): string | undefined {
  const own = text(group.brief ?? group.context ?? group.note, MAX_BRIEF);

  const raw = group.files;
  const files = Array.isArray(raw)
    ? raw.map((file) => text(file, MAX_TITLE)).filter((file): file is string => Boolean(file))
    : [text(raw, MAX_BRIEF)].filter((file): file is string => Boolean(file));

  const scope = files.length > 0 ? `Границы группы: ${files.join(', ')}` : undefined;
  const parts = [own, scope].filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n').slice(0, MAX_BRIEF) : undefined;
}

/**
 * Разбор предложения из уже разобранного JSON или из строки.
 *
 * Разбор НАМЕРЕННО терпимый к именам полей: обязательным остаётся только
 * название группы и хоть какое-то содержание, всё прочее либо имеет синоним,
 * либо выводится. Прежняя строгость («почти правильный блок лучше не
 * показывать») стоила ровно того, ради чего писалась: 1 сентября предложение из
 * пяти групп ушло в ленту сырым JSON-ом, потому что модель назвала поля
 * `files`/`prompt` вместо `brief`/`tasks`. Заводить ветки наугад мы всё равно не
 * можем — между разбором и первой командой git стоит человек с карточкой.
 */
export function parseSplitProposal(raw: unknown): TaskSplitProposal | undefined {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;

  const source = value as {
    shared?: unknown;
    context?: unknown;
    groups?: unknown;
    chats?: unknown;
    parts?: unknown;
  };
  const list = source.groups ?? source.chats ?? source.parts;
  if (!Array.isArray(list)) return undefined;

  const groups: TaskSplitGroup[] = [];
  for (const [index, item] of list.slice(0, SPLIT_MAX_GROUPS).entries()) {
    if (!item || typeof item !== 'object') continue;
    const group = item as Record<string, unknown>;

    const title = text(group.title ?? group.name, MAX_TITLE);
    if (!title) continue;

    // Список задач модель опускает целиком, когда считает, что название группы
    // и есть её содержание («Тесты: src/index.test.js»). Отбрасывать такую
    // группу нельзя: предложение из четырёх групп превращалось бы в сырой JSON
    // из-за поля, которое человек и так видит в заголовке карточки.
    const tasks = taskList(group);
    if (tasks.length === 0) tasks.push(title);

    const branch = text(group.branch, MAX_BRANCH) ?? branchFromTitle(title, index);
    const brief = briefOf(group);
    groups.push({ title, branch, tasks, ...(brief ? { brief } : {}) });
  }

  // Одна группа — это не разделение, а обычный разговор: карточка с единственной
  // кнопкой «разделить на 1 чат» только сбивала бы с толку.
  if (groups.length < 2) return undefined;

  const shared = textOrList(source.shared ?? source.context, MAX_SHARED);
  return { groups, ...(shared ? { shared } : {}) };
}

/** Что осталось от текста после вырезания блоков и что из них разобрано. */
export interface SplitScan {
  /** Текст, который видит человек: без блоков и без лишних пустых строк. */
  text: string;
  /** Предложения в порядке появления. */
  proposals: TaskSplitProposal[];
  /**
   * Сколько закрытых блоков разобрать не удалось. Ноль в подавляющем
   * большинстве случаев, и именно поэтому число важно: непонятый блок остаётся
   * в ленте текстом, и без этого счётчика человек видит простыню JSON, не
   * понимая, что панель предложение ОТВЕРГЛА, а не агент так решил написать.
   */
  rejected: number;
}

/** Начало блока: тройная кавычка в начале строки и наш язык за ней. */
const OPEN = new RegExp(`(^|\\n)[ \\t]*\`\`\`[ \\t]*${SPLIT_BLOCK_LANG}[ \\t]*\\r?\\n`);

/**
 * Вырезать блоки предложений из текста ответа.
 *
 * Три случая, и все три встречаются в ленте:
 *
 * - блок закрыт и разобран → уходит из показа, предложение попадает в карточку;
 * - блок закрыт, а JSON внутри сломан → остаётся в тексте КАК ЕСТЬ: прятать то,
 *   чего панель не поняла, значит потерять слова агента без следа;
 * - блок ещё пишется (закрывающей кавычки нет) → всё от него до конца текста
 *   прячем. Так лента не показывает голый JSON, пока ответ печатается.
 */
export function scanSplitBlocks(source: string): SplitScan {
  const proposals: TaskSplitProposal[] = [];
  let rejected = 0;
  let rest = source;
  let out = '';

  for (;;) {
    const open = OPEN.exec(rest);
    if (!open) {
      out += rest;
      break;
    }

    // Перенос строки перед кавычками — часть совпадения, но не часть блока:
    // он принадлежит тексту выше и остаётся в показе.
    const lead = (open[1] ?? '').length;
    const bodyStart = open.index + open[0].length;
    out += rest.slice(0, open.index + lead);

    const close = /(^|\n)[ \t]*```[ \t]*(\r?\n|$)/.exec(rest.slice(bodyStart));
    if (!close) {
      // Блок ещё печатается — остальное не показываем и разбирать нечего.
      break;
    }

    const body = rest.slice(bodyStart, bodyStart + close.index);
    const proposal = parseSplitProposal(body);
    if (proposal) {
      proposals.push(proposal);
    } else {
      rejected += 1;
      out += rest.slice(open.index + lead, bodyStart + close.index + close[0].length);
    }

    rest = rest.slice(bodyStart + close.index + close[0].length);
  }

  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), proposals, rejected };
}

/**
 * Имя ветки, пригодное для git. Модель пишет заголовками («Правки формы входа»),
 * а `git check-ref-format` таких имён не принимает — и отказывать из-за пробела
 * в предложении, которое человек уже одобрил, было бы издевательством. Поэтому
 * имя приводится к допустимому виду здесь, а проверка git остаётся страховкой.
 *
 * Живёт в контрактах, а не в сервере: по этому же имени панель узнаёт, что
 * предложение УЖЕ разделено (`branchTaken`). Две реализации одного приведения
 * разошлись бы на первой правке, и карточка врала бы про состояние.
 */
export function safeBranchName(raw: string): string {
  const value = stripControl(raw.trim().replace(/\s+/g, '-'))
    // Запрещённое самим git: ~ ^ : ? * [ \ — а также `..`, `@{`, точка и дефис
    // в начале сегмента, `.lock` и слэш на конце.
    .replace(/[~^:?*[\]\\]/g, '-')
    .replace(/@\{/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .split('/')
    .map((part) => part.replace(/^[-.]+/, '').replace(/[-.]+$/, ''))
    .filter(Boolean)
    .join('/')
    .replace(/\.lock$/i, '')
    .slice(0, 100)
    .replace(/[-./]+$/, '');
  return value || 'task';
}

/**
 * Управляющие символы — по кодам, а не классом в регулярном выражении.
 * Escape-запись такого класса инструменты правки превращают в сам байт, файл
 * становится для git бинарным, и ни diff, ни merge по нему больше не работают
 * (`.claude/gotchas.md`, §Code structure). Здесь escape-записи не нужно вовсе.
 */
function stripControl(value: string): string {
  let out = '';
  for (const char of value) out += char.charCodeAt(0) < 32 ? '-' : char;
  return out;
}

/**
 * Заведена ли уже ветка под это имя. Занятое имя разделение не отвергает, а
 * дополняет суффиксом (`-2`, `-3`, … — так же, как вкладки проводника), поэтому
 * сверять «в лоб» нельзя: второй заход по тому же предложению искался бы среди
 * имён, которых он сам никогда не создаёт.
 */
export function branchTaken(wanted: string, taken: readonly string[]): boolean {
  const safe = safeBranchName(wanted);
  return taken.some(
    (branch) =>
      branch === safe ||
      (branch.startsWith(`${safe}-`) && /^\d+$/.test(branch.slice(safe.length + 1))),
  );
}

/**
 * Задание одной группе: общий контекст, свои задачи, своя памятка. Собирается
 * в ОДНОМ месте — иначе текст, ушедший в чат сразу, и текст, положенный в поле
 * ввода при «только создать чаты», разошлись бы уже на второй правке.
 */
export function buildGroupPrompt(group: TaskSplitGroup, shared?: string): string {
  const parts: string[] = [];
  if (shared) parts.push(shared);
  if (group.brief) parts.push(group.brief);
  // Нумеруем только настоящий список. Единственная задача часто приходит целым
  // готовым заданием (модель кладёт его одной строкой), и «1.» перед абзацем,
  // внутри которого уже есть свои пункты, читается как ошибка.
  parts.push(
    group.tasks.length > 1
      ? group.tasks.map((task, index) => `${index + 1}. ${task}`).join('\n')
      : (group.tasks[0] ?? ''),
  );
  return parts.join('\n\n').trim();
}
