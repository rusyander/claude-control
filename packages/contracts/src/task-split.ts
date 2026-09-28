/**
 * Разделение списка задач по нескольким чатам — формат канала и его разбор.
 *
 * Канал — блок в ОТВЕТЕ агента, а не вызов инструмента: текст умеет любой CLI, а
 * инструменты — только Claude, и формат тогда существовал бы в двух видах. Агент
 * выводит один блок
 *
 * ```agentdeck:split
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

import type { WorktreeBootstrapState } from './project-git';
import type { GroupPermissionLevel, GroupRequestId } from './split-groups.ts';
import { blockLang, blockLangPattern } from './brand.ts';
import { SPLIT_HUMAN_TAG, SPLIT_TICKET_TAG } from './split-tickets.ts';

/** Язык блока: он же признак, по которому панель узнаёт предложение. */
export const SPLIT_BLOCK_LANG = blockLang('split');

/**
 * Потолки: предложение приходит из ответа модели, а не из формы.
 *
 * Групп до 30: группа — это ветка и MR, и выгрузка из трекера на 60–80 задач
 * законно раскладывается на 20 групп. Прежние 8 резали хвост молча — агент о
 * потолке не знал, человек об обрезке не узнавал (23.09.2026). Сколько групп
 * работает ОДНОВРЕМЕННО, решает не этот потолок, а настройка проекта.
 */
export const SPLIT_MAX_GROUPS = 30;
export const SPLIT_MAX_TASKS_PER_GROUP = 50;

/**
 * Разделение на проекте — задаётся человеком один раз, действует на каждое
 * разделение в этом репозитории.
 */
export interface SplitSettings {
  /**
   * Доводить каждую группу до готового MR навыком доставки проекта: задачи
   * группы — одна ветка и один MR, с ревью, живой проверкой и описанием.
   */
  deliver: boolean;
  /**
   * Сколько групп работает одновременно; остальные ждут в очереди и стартуют,
   * как только у работающей кончится ход. Двадцать групп разом — двадцать
   * сессий на потолке со своими ревьюерами: окно подписки кончается за час.
   */
  parallel: number;
}

/** Прежнее поведение: при старом потолке в 8 групп разом шли все восемь. */
export const SPLIT_PARALLEL_DEFAULT = 8;
/**
 * Автоподбор для тяжёлой подготовки копии (несколько установок или сборка):
 * восемь копий по пять `npm ci` разом — сорок установщиков на одном диске.
 * Четыре, а не шесть — решение владельца по живому прогону 24.09.2026; так же
 * обещает и справка панели.
 */
export const SPLIT_PARALLEL_HEAVY = 4;
/**
 * Доставка включена из коробки (24.09.2026): «довести до MR» — штатный конец
 * задачи, а не редкий режим; главный выключатель — `AppSettings.deliverToMr`.
 */
export const SPLIT_SETTINGS_DEFAULT: SplitSettings = {
  deliver: true,
  parallel: SPLIT_PARALLEL_DEFAULT,
};

/**
 * Что панель сама узнала о проекте для доставки — чтобы кнопка в чате
 * показывала правду, а не обещала MR там, где его некуда создать.
 */
export interface DeliveryProfile {
  /** Главный выключатель в настройках панели. */
  enabled: boolean;
  /** Каталог — git-репозиторий; нет — доставлять нечего, кнопку не показывают. */
  repo: boolean;
  /** Есть удалённый репозиторий: без него пушить и открывать MR некуда. */
  remote: boolean;
  /** Проектный навык доставки (`.claude/skills/<имя>`), если найден. */
  skill?: string;
  /** Что пойдёт в новой копии: настроенная команда или план автоопределения. */
  bootstrap?: string;
  bootstrapConfigured: boolean;
  /** Подготовка тяжёлая — автоподбор групп разом ниже. */
  heavy: boolean;
}

/**
 * Запись проекта в панели: число групп разом не задано — берётся из общих
 * правил вкладки «Группы» по тяжести проекта. Разрешения — только строки,
 * которые проект переопределил; остальные наследуются из общих.
 */
export interface StoredSplitSettings {
  deliver: boolean;
  parallel?: number;
  permissions?: Partial<Record<GroupRequestId, GroupPermissionLevel>>;
}

/** Ответ настроек разделения: сохранённое плюс то, что панель вывела сама. */
export interface SplitSettingsView extends SplitSettings {
  /** Число групп разом не задано человеком — взято из общих по тяжести проекта. */
  parallelAuto: boolean;
  profile: DeliveryProfile;
  /** Действующие разрешения групп проекта: своё поверх общего. */
  permissions: Record<GroupRequestId, GroupPermissionLevel>;
  /** Строки, переопределённые проектом; остальные идут из общих. */
  permissionsOwn: GroupRequestId[];
}
const MAX_TITLE = 120;
const MAX_BRANCH = 120;
const MAX_TASK = 2_000;
const MAX_BRIEF = 4_000;
const MAX_SHARED = 4_000;
/** Имя модели и уровень глубины — короткие слова; всё длиннее просто мусор. */
const MAX_ASSIGNMENT = 40;
/** Ссылка на запрос на слияние: длиннее бывает только мусор с якорями. */
const MAX_URL = 500;

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
  /**
   * Род работы в группе (`mechanical`, `implementation`, `tests`,
   * `investigation`, `design`, `review`) — единственное, что панель спрашивает у
   * агента про модель: модель под класс подставляет таблица в коде
   * (`model-cascade.ts`). Здесь строка переносится как есть, потому что сабпаты
   * контрактов друг друга не импортируют, а два понимания «что можно назначить»
   * разошлись бы на первой правке лестницы.
   */
  kind?: string;
  /**
   * Просьба агента о модели и глубине — ТОЛЬКО ВВЕРХ: группа сложнее своего
   * класса поднимается, понизить ниже класса нельзя. Проверяет и решает
   * `planAssignment` на сервере.
   */
  model?: string;
  effort?: string;
  /**
   * Границы группы из разбора разделения (Т1): чем владеет только она и что
   * знать про соседей. Агент в блоке их не пишет — их дописывает панель после
   * уровня 1, поэтому разбор предложения этих полей не читает.
   */
  owns?: string[];
  notes?: string;
  /**
   * Группа панели, выбранная разбором по её `when` (выбор чата — `auto`). Тоже
   * дописывает панель после уровня 1 — уже сверенной с каталогом; ребёнок
   * получает её своим выбором группы до первого прогона.
   */
  groupKey?: string;
  /**
   * Группа ревьюит запрос на слияние по ссылке (Т7), а не делает задачу.
   *
   * Меняет три вещи разом, и все три — намеренно: копия ветвится ОТ ветки MR
   * (иначе ревьюить нечего), группа идёт на потолке без плана (проверка — не
   * работа, планировать в ней нечего), а после ответа панель не заводит правки
   * сама, а показывает человеку карточку решения: писать в чужой MR — его
   * право, не автоматика.
   */
  review?: TaskSplitReview;
}

/** Что именно ревьюит группа: ссылка и, если агент её знал, ветка MR. */
export interface TaskSplitReview {
  /** Адрес MR/PR как его дал человек — по нему же панель находит номер. */
  url: string;
  /**
   * Ветка MR, если она была названа в блоке. Панель предпочитает спросить её у
   * форджа: агент называет ветку по памяти и ошибается, а ошибка здесь тихая —
   * копия заведётся от не той ветки, и ревью прочитает чужой дифф.
   */
  branch?: string;
  /**
   * Группа не ревьюит MR, а РАБОТАЕТ в нём: конфликты, замечания ревьюера,
   * rebase, описание. Копия та же — на ветке MR, — но задание обычное, правки
   * разрешены, а карточки решения по замечаниям нет: замечаний никто не пишет.
   * Без этого режима несколько MR «на фикс» не делились вовсе: ревью-группа
   * обязана ничего не править, а обычная группа ветку MR не находит.
   */
  work?: boolean;
}

/** Что человек решил делать с замечаниями ревью (Т7). */
export type TaskSplitReviewDecision = 'fix' | 'post' | 'both' | 'none';

/** Предложение агента: общий контекст плюс группы. */
export interface TaskSplitProposal {
  /** Контекст, который уходит в КАЖДЫЙ чат: общие правила, стек, договорённости. */
  shared?: string;
  groups: TaskSplitGroup[];
  /**
   * Что разбор отбросил по потолкам: групп сверх `SPLIT_MAX_GROUPS` и задач
   * сверх `SPLIT_MAX_TASKS_PER_GROUP`. Карточка говорит об этом вслух — иначе
   * хвост выгрузки пропадал бы без следа.
   */
  dropped?: { groups?: number; tasks?: number };
}

/** Чат, заведённый под группу. */
export interface TaskSplitStarted {
  title: string;
  /** Ветка, под которой в итоге завели копию: занятое имя получает суффикс. */
  branch: string;
  /** Позиция группы в предложении — по ней конвейер уровней находит свою запись. */
  index?: number;
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
  /**
   * Модель, с которой чат РЕАЛЬНО стартовал (после подбора и клэмпа), её глубина
   * и распознанный класс работы. Отдаётся клиенту, чтобы шапка ребёнка сразу
   * показывала назначенное, а не дефолт из настроек: пер-чат оверрайд модели
   * живёт на клиенте, и без этого второе сообщение ушло бы на другой модели.
   */
  model?: string;
  effort?: string;
  kind?: string;
  /**
   * С какого звена чат начал: `plan` — сперва план на потолке (подбор включён,
   * Т1), `work` — сразу работа. Нет — как `work`: ответы до партии Т1.
   */
  stage?: 'plan' | 'work';
  /**
   * Группа доводит работу до MR (преамбула доставки ушла в задание). По нему
   * конвейер закрывает группу только по фактам git, а не по словам агента.
   */
  deliver?: boolean;
}

/** Группа, которую завести не удалось: остальные при этом не откатываются. */
export interface TaskSplitFailure {
  index?: number;
  title: string;
  branch: string;
  message: string;
}

/** Ответ на разделение: что завелось и что нет. */
export interface TaskSplitResult {
  chats: TaskSplitStarted[];
  failures: TaskSplitFailure[];
  /**
   * Подбор включён — копий ещё нет: сперва идёт разбор разделения на потолке в
   * корне репозитория (Т1), а группы заводит сервер по его итогу. Здесь — чат
   * разбора; `chats` при этом пуст.
   */
  triage?: { chatId: string; path: string; started: boolean };
}

/**
 * Одна строка, которая дописывается к системному промпту прогона (у чужих CLI —
 * приписывается к промпту сверху). Именно ОДНА: на Windows аргумент уезжает через
 * оболочку, а перевод строки внутри аргумента cmd.exe разрывает командную строку.
 */
export const SPLIT_SYSTEM_PROMPT =
  'If one message brings three or more independent tasks, do not take them one after another — ' +
  'first propose a split. ' +
  // Планка занижалась на живых прогонах до абсурда: «убрать лишние импорты в
  // трёх файлах» уезжало тремя задачами, и человек получал предложение делить
  // на каждый чих. Задача — то, что решается отдельно и своим решением; одна и
  // та же правка в десяти файлах остаётся ОДНОЙ задачей, сколько бы файлов ни
  // задела. Предлагать разделение чаще одного раза за разговор нельзя: человек,
  // отказавшийся один раз, отказался не от этой формулировки, а от дробления.
  'Independent means different in substance: each can be delivered on its own, and solving one ' +
  'settles nothing in another. The same change across many files is ONE task, however many files ' +
  'it touches; a list of files, of steps of one piece of work or of items of one refactoring does ' +
  'not count as tasks. Propose at most once per conversation: declined or ignored — keep working ' +
  'yourself and do not ask again until asked. ' +
  'Group the tasks so that the groups do not overlap in files, ' +
  `and output EXACTLY ONE code block in the language ${SPLIT_BLOCK_LANG} containing JSON of the form ` +
  '{"shared":"context common to all","groups":[{"title":"name","branch":"feature/name",' +
  '"tasks":["task","task"],"brief":"what matters to this group"}]}. ' +
  // Формат придуман этой панелью, снаружи его не существует: модель не может
  // «вспомнить» его правильно и раз за разом подменяет имена полей (files,
  // prompt, name). Разбор такие подмены переживает, но карточка честнее, когда
  // поля названы как надо, — поэтому имена перечислены явно и закрыто.
  'The field names are exactly these and no others: a group has title, branch, tasks, brief; ' +
  'tasks is always an ARRAY of strings, one string per task, even for a single task; shared is a STRING. ' +
  // Порождённый чат — чистая сессия в другом каталоге: этого разговора он не
  // видит вовсе. Живой прогон показал, чем это кончается: модель складывает
  // смысл в заголовок («Тесты: src/index.test.js»), tasks не пишет, и агент в
  // новой ветке получает вместо задания название колонки.
  'Write each task in tasks IN FULL, in your own words and with all its conditions: the new chat ' +
  'is a clean session in its own copy of the repository, it will not see this conversation, and ' +
  'apart from shared and tasks it will have nothing. A group name is not a task. ' +
  'Name the branch in short Latin characters; write group names, tasks and shared in the ' +
  'language the human uses. ' +
  'The panel shows the human a choice card instead of this block, so do not retell the JSON in words. ' +
  'You do NOT need to create branches, repository copies or chats yourself, and you have no means ' +
  'to: the panel does all of that when the human presses the button on the card. ' +
  `At most ${SPLIT_MAX_GROUPS} groups and at most ${SPLIT_MAX_TASKS_PER_GROUP} tasks per group: beyond ` +
  'that the panel will not create the groups. Each group becomes its own branch and its own merge ' +
  'request — group what is reviewed and merged together, not merely what is similar in topic. Write ' +
  'a tracker task with its key (ABC-123) and link: the group takes the task into work by them. ' +
  'After the block, stop and wait for the decision. ' +
  // Ревью по ссылке (Т7) — единственный случай, когда одна группа законна:
  // MR и есть отдельная работа в своей копии на его ветке. Без этой оговорки
  // модель послушно требовала трёх задач и ревьюила один MR прямо в разговоре.
  'A special case — links to merge requests (MR/PR) with a request to review them: then make one ' +
  'group per EACH link, and a single link also makes a split — the three-task rule does not apply ' +
  'here. Such a group has kind: "review", review: {"url":"the full link"}, title — the MR title or ' +
  'its number, tasks — what exactly to check. The panel creates the MR branch and a copy on it from ' +
  'the link. ' +
  // Несколько MR на работу (конфликты, замечания, rebase) — второй такой
  // случай: человек хочет видеть каждый MR своим чатом, а в одном разговоре
  // они шли вперемешку и вслепую. Одну ссылку «на фикс» не делим — это и есть
  // обычная работа в этом разговоре.
  'The second special case — TWO or more links to different MRs/PRs that need something DONE ' +
  '(resolve conflicts, merge in the fresh main branch, fix review comments, update the description): ' +
  'propose a split as well, one group per MR, even with fewer than three tasks — the human chooses ' +
  'on the card whether to split or do it all here one by one. Such a group has review: {"url":"the ' +
  'full link","action":"work"}, kind — the class of work (not "review"), tasks — what to do in this ' +
  'MR. Review and work in one message are different groups with action "review" and "work". ' +
  'Apart from these two link cases: if the tasks are related to each other or there are fewer than ' +
  'three — output no block and work as usual.';

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

  const scope = files.length > 0 ? `Group scope: ${files.join(', ')}` : undefined;
  const parts = [own, scope].filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n').slice(0, MAX_BRIEF) : undefined;
}

/**
 * Ссылка на MR/PR группы ревью (Т7). Как и везде здесь, разбор терпимый: модель
 * кладёт ссылку то строкой (`"review": "https://…"`), то объектом, то под
 * именем `mr`/`pr`. Не ссылка — не ревью: строка «посмотри MR Пети» завела бы
 * копию неизвестно от какой ветки, и лучше обычная группа.
 */
function reviewOf(group: Record<string, unknown>): TaskSplitReview | undefined {
  const raw = group.review ?? group.mr ?? group.pr ?? group.mergeRequest ?? group.pullRequest;
  if (!raw) return undefined;

  const source =
    typeof raw === 'object' ? (raw as Record<string, unknown>) : { url: raw as unknown };
  const url = text(source.url ?? source.link ?? source.href, MAX_URL);
  if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) return undefined;

  const branch = text(source.branch ?? source.sourceBranch ?? source.source_branch, MAX_BRANCH);
  // Режим — только явным полем. По классу его не угадываем: ревью со своим
  // классом (`design`) законно, и догадка превратила бы чтение чужого MR в правку.
  const action = text(source.action ?? source.mode ?? group.action ?? group.mode, MAX_ASSIGNMENT);
  // `work: true` — собственный вывод этого разбора: веб шлёт на сервер уже
  // разобранное предложение, и сервер разбирает его ещё раз. Без этого поля
  // второй разбор терял режим, и работа в MR уезжала ревью с «НИЧЕГО НЕ ПРАВЬ».
  const work = source.work === true || Boolean(action && action.toLowerCase() !== 'review');
  return { url, ...(branch ? { branch } : {}), ...(work ? { work } : {}) };
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
  let droppedTasks = 0;
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
    const listed = group.tasks ?? group.task ?? group.items ?? group.prompt;
    if (Array.isArray(listed) && listed.length > SPLIT_MAX_TASKS_PER_GROUP) {
      droppedTasks += listed.length - SPLIT_MAX_TASKS_PER_GROUP;
    }

    const branch = text(group.branch, MAX_BRANCH) ?? branchFromTitle(title, index);
    const brief = briefOf(group);
    // Назначение — необязательное поле, и мусор в нём группу не отменяет:
    // непонятое значение просто уедет на потолок при клэмпе. Синонимы те же,
    // что и везде здесь: модель называет поля своими словами.
    const kind = text(group.kind ?? group.type ?? group.class, MAX_ASSIGNMENT);
    const model = text(group.model, MAX_ASSIGNMENT);
    const effort = text(group.effort ?? group.thinking ?? group.reasoning, MAX_ASSIGNMENT);
    const review = reviewOf(group);
    groups.push({
      title,
      branch,
      tasks,
      ...(brief ? { brief } : {}),
      // Ревью по ссылке — само по себе класс работы: без него группа уехала бы
      // на подобранную ступень, то есть проверяла бы чужой код моделью слабее
      // той, что его писала. Названный агентом класс при этом не трогаем.
      ...(kind ? { kind } : review && !review.work ? { kind: 'review' } : {}),
      ...(review ? { review } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
  }

  // Одна группа — это не разделение, а обычный разговор: карточка с единственной
  // кнопкой «разделить на 1 чат» только сбивала бы с толку. Ревью по ссылке —
  // исключение, и единственное (Т7): один MR — это уже отдельная работа в своей
  // копии на его ветке, ради которой разговор человека прерывать не надо.
  if (groups.length < 2 && !groups.some((group) => group.review && !group.review.work))
    return undefined;
  if (groups.length === 0) return undefined;

  const shared = textOrList(source.shared ?? source.context, MAX_SHARED);
  const droppedGroups = Math.max(0, list.length - SPLIT_MAX_GROUPS);
  const dropped = {
    ...(droppedGroups > 0 ? { groups: droppedGroups } : {}),
    ...(droppedTasks > 0 ? { tasks: droppedTasks } : {}),
  };
  return {
    groups,
    ...(shared ? { shared } : {}),
    ...(Object.keys(dropped).length > 0 ? { dropped } : {}),
  };
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
const OPEN = new RegExp(`(^|\\n)[ \\t]*\`\`\`[ \\t]*${blockLangPattern('split')}[ \\t]*\\r?\\n`);

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
    // Допустимое для git, но не для чужих рук: запятая, кавычки и знаки
    // оболочки ломают адрес MR, команду в терминале и чужой CI. Живой прогон
    // 24.09.2026 дал ветки `fix-PROJ-1064,PROJ-1068,…` из списка ключей.
    .replace(/[,;'"`$&|<>!#%(){}]/g, '-')
    .replace(/-{2,}/g, '-')
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
/** Что панель приготовила в копии — для преамбулы задания. */
export interface EnvironmentPreambleInput {
  /** Строка отчёта зеркала («Локальный слой: перенесено N…»); нет — зеркала не было. */
  mirror?: string;
  /** Итог подготовки копии; нет — команды не было. */
  bootstrap?: WorktreeBootstrapState;
}

/**
 * Преамбула задания для агента в копии: что панель уже сделала, чтобы первый
 * ход был по задаче, а не по «обживанию» копии.
 *
 * До неё агент в свежей копии сам поднимал MCP, зеркалил `.claude/`, ставил
 * зависимости в фоне и откатывал переписанные lock-файлы — минуты и контекст
 * на каждом ребёнке разделения, часть шагов упиралась в человека. Теперь это
 * делается ДО старта, и преамбула называет готовым РОВНО сделанное (Д13):
 * «окружение готово» при ненастроенной подготовке отправило детей живого проекта на
 * пустые `node_modules` — 5–10 минут установки, поднятые установщиком
 * дев-серверы и четыре переписанных lock-файла. Провал подготовки не
 * скрывается — хвост лога здесь же, и агент решает сам, повторять установку
 * или обойтись.
 */
export function environmentPreamble(input: EnvironmentPreambleInput): string {
  const lines: string[] = [];
  const done: string[] = [];
  if (input.mirror) done.push(input.mirror);
  const boot = input.bootstrap;
  if (boot?.status === 'ok') {
    done.push(`dependencies installed with "${boot.command}"`);
  }
  if (boot?.reverted && boot.reverted.length > 0) {
    done.push(`lock files rewritten by the install were reverted: ${boot.reverted.join(', ')}`);
  }
  lines.push(
    done.length > 0
      ? `The panel prepared this copy: ${done.join('; ')}.`
      : 'The panel created this copy of the repository.',
  );
  if (boot && boot.status !== 'ok') {
    const why = boot.timedOut
      ? 'was stopped at the 10-minute ceiling'
      : `exited with code ${boot.exitCode ?? '?'}`;
    const tail = boot.logTail.trim();
    lines.push(
      `⚠ Copy preparation: the command "${boot.command}" ${why}. Dependencies may not be installed — decide yourself: repeat the install or do without it.${
        tail ? `\nLog tail:\n${tail}` : ''
      }`,
    );
  }
  if (boot?.status === 'ok') {
    lines.push(
      'The environment is ready — do not check or set it up (MCP, local layer, dependencies), start with the task right away.',
    );
  } else {
    if (!boot) {
      lines.push(
        'The panel did NOT install dependencies: copy preparation is not set in the project settings. If the task does not need them, do not install them. If it does, install them yourself with one install command, without starting dev servers or a build, and do not commit lock files the install rewrote.',
      );
    }
    lines.push(
      input.mirror
        ? 'Do not set up MCP or the local layer — start with the task.'
        : 'Do not set up MCP — start with the task.',
    );
  }
  return lines.join('\n');
}

/**
 * Развилки группы — человеку (вкладка «Группы», `groupQuestions: 'human'`,
 * аудит 25.09, L40). Строка главнее правила ребёнка «работай автономно»
 * (`CHILD_PROMPT`): оно дописывается к каждому ходу, и без прямого «главнее»
 * агент выбирал бы между двумя правилами сам.
 */
export const GROUP_QUESTIONS_HUMAN_LINE =
  'The human decides the forks of this group (chosen in the panel settings, and this overrides the ' +
  '"work autonomously" rule): take every fork — even one with a recommended option — to the human ' +
  'as a question with the AskUserQuestion tool, with options and your recommendation, wait for the ' +
  'answer and continue from the same stage.';

/**
 * Находка, которая не воспроизвелась (аудит 25.09, L258): группа, получив
 * замечание ревью, которое у неё не повторилось, тянула в проект новые
 * зависимости, CI и тестовую обвязку «чтобы проверить наверняка». Такая
 * инфраструктура — решение человека: сперва объём и вопрос.
 */
export const UNCONFIRMED_FINDING_LINE =
  'A finding you could not reproduce is no reason to change the infrastructure: no new ' +
  'dependencies, no CI, tsconfig or test-harness edits. First say what did not reproduce and how ' +
  'much would have to be added, and ask the human with the AskUserQuestion tool.';

/**
 * Доставка группы до готового MR (настройка проекта `SplitSettings.deliver`).
 *
 * Конвейер доставки панель не повторяет: он уже есть навыком (`ticket-delivery`
 * и проектные варианты — взять задачу, ветка, проверки, коммит, пуш, черновик
 * MR, ревью, живая проверка, описание) и отлажен на живых задачах. Панель
 * велит группе пройти его и держит то, чего навык не знает: копия и ветка уже
 * заведены, задачи группы — один MR, остановка — вопрос через панель.
 *
 * Без этой строки группа кончалась «готово» с незакоммиченной работой в копии,
 * и всё от коммита до MR человек делал руками по каждой группе (23.09.2026).
 */
export function deliveryPreamble(input: {
  branch: string;
  mergeRequest?: string;
  /** Развилки группы (вкладка «Группы»): `human` — вопросом человеку, иначе по плану. */
  questions?: 'plan' | 'human';
}): string {
  return [
    "Delivering a ready MR is this group's duty: the human enabled it on the project, and that is " +
      'their permission to commit, push, create and update the MR and to move the tracker tasks of ' +
      'this group. Merging and deleting branches stay forbidden; so does force-push, except for the ' +
      'one case below about your own branch.',
    "Take the group's tasks through the task delivery skill (a project variant, e.g. " +
      '`<project>-ticket-delivery`, wins over the general `ticket-delivery`; no skill — go through ' +
      "the same stages yourself): tracker tasks into work on yourself, the change, the project's " +
      'checks, commit, push, draft MR, review, live check, design comparison if a mockup is attached ' +
      'to the task, fixing what was found, the MR description — and take the draft off when all is clean.',
    'All tasks of the group are ONE branch and ONE MR: task keys go into the MR description, and ' +
      'each task links to the MR.',
    input.mergeRequest
      ? `The MR already exists: ${input.mergeRequest}. Do not create a new one — push to its branch and update the description.`
      : `The panel has already created the copy's branch: ${input.branch}. Do not create another; if ` +
        'the project convention requires a different name, rename this one before the first push (`git branch -m`).',
    // Свежая основная до первого пуша (журнал 61b): основная уходит вперёд, пока
    // группы работают, и конфликт, найденный при слиянии, стоит человеку дороже.
    'Before the first push — `git fetch origin` and rebase the branch onto the fresh main branch of ' +
      "the remote; resolve a conflict within the group's tasks yourself.",
    // Отправленная и отставшая ветка (решение владельца, W3-3): ветка группы —
    // её собственная, и переписать её арендой не значит тронуть общую историю.
    'If the branch is already pushed and has fallen behind main — the same rebase, then ' +
      '`git push --force-with-lease origin <group branch>`: only your own branch, never the main, ' +
      "a protected branch or another group's branch; a conflict in such a rebase is a question to " +
      'the human with a recommended option.',
    // Автономия по умолчанию (журнал 78, T24): группа стояла на развилке, для
    // которой сама назвала рекомендацию, пока человека не было у панели. Кто
    // решает развилки, выбирает человек во вкладке «Группы» (аудит 25.09, L40).
    input.questions === 'human'
      ? GROUP_QUESTIONS_HUMAN_LINE
      : 'Decide a fork for which you have a recommended option yourself: take it and record it in ' +
        'the MR description as a decision for the review. A question to the human with the ' +
        "AskUserQuestion tool — only when the step is irreversible or goes beyond the group's tasks " +
        "(someone else's task, a DB migration is needed, nothing to recommend); once answered, " +
        'continue from the same stage.',
    UNCONFIRMED_FINDING_LINE,
    'The last line of your answer is the MR link.',
    'The plan stage only takes this section into account in the plan; the work stage carries it out.',
  ].join('\n');
}

/**
 * Дефект ВНЕ задач группы (95b) — блоком в ответе, а не правкой и не тикетом.
 *
 * Чинить чужое группе нельзя (границы разбора), заводить тикет — тоже: запись
 * в трекер требует согласия человека на каждую операцию. А промолчать — значит
 * потерять находку: до блока она оставалась в середине отчёта, который никто
 * не дочитывал. Сервер вынимает блок из текста хода (`split-tickets.ts`), хаб
 * показывает список «Предложить тикет» с кнопкой «копировать».
 */
export function splitTicketPreamble(): string {
  return [
    "A defect outside this group's tasks, noticed along the way: do not fix it and do not file a " +
      'tracker ticket — describe it in your answer as a block, and the panel shows it to the human ' +
      'in the "Suggested tickets" list:',
    `<${SPLIT_TICKET_TAG}>`,
    'title: briefly, what is broken',
    'where: file with line, screen or route',
    'why: why it is bad and how to reproduce it',
    `</${SPLIT_TICKET_TAG}>`,
    'One block — one defect. Fix defects of your own tasks yourself, do not describe them as a block. ' +
      'Write the values of both blocks in the language of the task text: the human reads them.',
    'A step needed for delivery that you cannot do (a dependency between MRs, access, the setup of ' +
      "someone else's service): do not work around it with direct requests — describe it as a " +
      'block, and the panel shows it to the human in the "For you to do" list:',
    `<${SPLIT_HUMAN_TAG}>`,
    'action: what to do',
    'where: a link or the place where it is done',
    'why: why it is needed and why you cannot do it yourself',
    `</${SPLIT_HUMAN_TAG}>`,
  ].join('\n');
}

/**
 * Доставка в ОБЫЧНОМ чате проекта (24.09.2026): та же обязанность, что у группы
 * разделения, но условная — чат бывает и вопросом, и ревью, и исследованием, и
 * MR на «объясни, как это работает» был бы вредом. Поэтому строка велит
 * доставлять только задачу на изменение кода и только готовую.
 *
 * ОДНА СТРОКА — как вся склейка инициатив (`initiative.ts`): на Windows
 * аргумент идёт через оболочку, и перевод строки разорвал бы команду.
 */
export function chatDeliveryPrompt(input: { skill?: string; foreign?: boolean }): string {
  const skill = input.skill
    ? `with the project skill \`${input.skill}\``
    : 'with the task delivery skill (a project variant, e.g. `<project>-ticket-delivery`, wins over ' +
      'the general `ticket-delivery`; no skill — go through the same stages yourself)';
  const ask = input.foreign
    ? 'a question to the human'
    : 'a question to the human with the AskUserQuestion tool';
  return (
    'The human enabled delivery up to an MR on this project in the panel. If the message is a ' +
    'code-change task (ticket, bug, feature, review fixes) and the work is ready, take it to a ' +
    `ready MR ${skill}: a separate branch, not the main one; the project's checks, commit, push, ` +
    'draft MR, review, live check, MR description — and take the draft off when all is clean; the ' +
    "last line of the answer is the MR link. Enabling it is the human's permission to commit, " +
    'push, create and update the MR for this task; merging, deleting branches and force-push are ' +
    'forbidden. A question, an explanation, a review or research without edits needs no MR. A ' +
    `stop of the skill (someone else's task, a DB migration is needed, unclear what is wanted) — ${ask}.`
  );
}

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
