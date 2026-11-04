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

import type { WorktreeBootstrapState, WorktreeRuntimeNote } from './project-git';
import type { GroupPermissionLevel, GroupRequestId } from './split-groups.ts';
import { blockLang, blockLangPattern } from './brand.ts';
import {
  SPLIT_MAX_GROUPS,
  SPLIT_MAX_TASKS_PER_GROUP,
  SPLIT_PARALLEL_DEFAULT,
} from './split-limits.ts';
import { SPLIT_HUMAN_TAG, SPLIT_TICKET_TAG } from './split-tickets.ts';
import {
  labelledCut,
  OWNER_PRECEDENCE_LINE,
  OWNER_PRECEDENCE_PLAIN_LINE,
  OWNER_TEXT_MAX,
  SKILL_ROUTE_LINE,
  taskCoverageLine,
} from './quality-floor.ts';

/** Язык блока: он же признак, по которому панель узнаёт предложение. */
export const SPLIT_BLOCK_LANG = blockLang('split');

// Потолки и параллельность — в `split-limits.ts` (круг с `split-groups.ts`); пути импорта прежние.
export {
  SPLIT_MAX_GROUPS,
  SPLIT_MAX_TASKS_PER_GROUP,
  SPLIT_PARALLEL_DEFAULT,
  SPLIT_PARALLEL_HEAVY,
} from './split-limits.ts';

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
/**
 * Задача, памятка и общий контекст — слова владельца или его агента, и до
 * группы они доходят целиком (владелец, 12.10.2026: прежние 2 000 / 4 000 знаков
 * резали задания из трекера посреди условий). Потолок — защита от мусора, а не
 * формат; дорос — режется с меткой (`longText`), молча никогда.
 */
const MAX_TASK = OWNER_TEXT_MAX;
const MAX_BRIEF = OWNER_TEXT_MAX;
const MAX_SHARED = OWNER_TEXT_MAX;
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

/** Строка нужной длины или undefined: пустое поле лучше пустой строки. */
function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

/**
 * Текст задания: длиннее потолка — обрезается С МЕТКОЙ. Молча обрубленная
 * инструкция читается группой как целая (живая проверка 08.10: шаги 2–4 задания
 * пропали посреди слова), а метку видят и группа, и человек в карточке.
 */
function longText(value: unknown, limit: number): string | undefined {
  const whole = text(value, Number.POSITIVE_INFINITY);
  return whole ? labelledCut(whole, limit) : undefined;
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
      .map((item) => text(item, Number.POSITIVE_INFINITY))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? longText(parts.join('\n'), limit) : undefined;
  }
  return longText(value, limit);
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
      .map((task) => longText(task, MAX_TASK))
      .filter((task): task is string => Boolean(task));
  }

  // Одной строкой приходит готовое задание целиком — оно и есть содержание
  // группы. Режем по длине задания, а не по длине пункта: это не пункт.
  const single = longText(direct, MAX_BRIEF);
  return single ? [single] : [];
}

/**
 * Памятка группы. `files` — не памятка, но и терять её нельзя: модель называет
 * ими границы группы, и в задании это ровно то, что агенту нужно знать первым.
 */
function briefOf(group: Record<string, unknown>): string | undefined {
  const own = longText(group.brief ?? group.context ?? group.note, MAX_BRIEF);

  const raw = group.files;
  const files = Array.isArray(raw)
    ? raw.map((file) => text(file, MAX_TITLE)).filter((file): file is string => Boolean(file))
    : [longText(raw, MAX_BRIEF)].filter((file): file is string => Boolean(file));

  const scope = files.length > 0 ? `Group scope: ${files.join(', ')}` : undefined;
  const parts = [own, scope].filter(Boolean);
  return parts.length > 0 ? longText(parts.join('\n\n'), MAX_BRIEF) : undefined;
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
  // кнопкой «разделить на 1 чат» только сбивала бы с толку. Ревью по одной ссылке
  // больше не исключение (живое ревью MR, 18.10.2026): одна задача не делится.
  if (groups.length < 2) return undefined;

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
  /**
   * Пути группы разделения (`owns`): модули вне них — одной строкой. Нет —
   * в зоне вся копия.
   */
  scope?: string[];
  /** Корень копии на этой машине: путь зоны внутри него — путь от корня копии. */
  root?: string;
}

/**
 * Что панель сделала с версиями рантайма проекта — строки для задания (T1/T8,
 * T15). Молчаливый запуск на чужой версии стоил группе ревью `npm ci` с кодом
 * 2: агент должен знать, на чём собрана копия и как в ней запускать тесты.
 */
const RUNTIME_NAMES = { node: 'Node', python: 'Python', go: 'Go' } as const;

/** Источник версии без каталога модуля: `cp-auth/go.mod go` → `go.mod go`. */
function sourceOf(note: WorktreeRuntimeNote): string {
  return note.where && note.source.startsWith(`${note.where}/`)
    ? note.source.slice(note.where.length + 1)
    : note.source;
}

/** Модули с одинаковой строкой — одна строка со списком модулей. */
function groupRuntimes(
  notes: WorktreeRuntimeNote[],
): Array<{ note: WorktreeRuntimeNote; where: string[] }> {
  const groups = new Map<string, { note: WorktreeRuntimeNote; where: string[] }>();
  for (const note of notes) {
    const key = JSON.stringify([
      note.tool,
      note.status,
      note.wanted,
      sourceOf(note),
      note.used,
      note.found,
      note.run,
      note.detail,
    ]);
    const group = groups.get(key);
    if (group) group.where.push(note.where);
    else groups.set(key, { note, where: [note.where] });
  }
  return [...groups.values()];
}

/**
 * Путь зоны группы так, как его пишет модель (`./api`, `/api`, `api/**`,
 * `**\/*.go`, `API`, пояснение после пробела), — в путь от корня копии до
 * первого шаблона. Пусто — вся копия; `undefined` — путь машины вне копии
 * (`C:/…`, `/home/…`), зону по нему не узнать. Путь внутри копии `root`
 * становится путём от её корня — на Linux/macOS он начинается с `/` так же,
 * как `/api` модели, и без корня читался бы как модуль `home/u/…`.
 */
function zonePath(raw: string, root?: string): string | undefined {
  let path = (raw.trim().split(/\s/)[0] ?? '').replace(/\\/g, '/');
  const base = root?.replace(/\\/g, '/').replace(/\/+$/, '');
  // Регистр складывается только у корня с буквой диска: на Linux `/home/u/App` и `/home/u/app` — разные.
  const fold = (text: string) => (base && /^[A-Za-z]:/.test(base) ? text.toLowerCase() : text);
  const inRoot =
    !!base &&
    fold(path.slice(0, base.length)) === fold(base) &&
    (path.length === base.length || path[base.length] === '/');
  if (inRoot) path = path.slice(base.length);
  else if (/^[A-Za-z]:\/|^\/(?:home|Users|tmp|private|var|mnt|opt|srv|root|Volumes)\//.test(path))
    return undefined;
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  const glob = parts.findIndex((part) => /[*?[{]/.test(part));
  return (glob < 0 ? parts : parts.slice(0, glob)).join('/').toLowerCase();
}

/**
 * Модуль в зоне группы: корень копии, модуль, внутри которого лежит путь
 * группы, или модуль внутри её пути. Без зоны в зоне всё — так задание
 * обычного чата в копии остаётся прежним. Зона, которую не разобрать на путь
 * (`.`, `*`, `**\/*.go`, путь машины), — тоже вся копия: прежде такая зона
 * выносила за неё каждый модуль вместе с указаниями «не обходи молча» и
 * «первым в PATH» (ревью B1-F6).
 */
function inScope(where: string, scope: string[] | undefined, root?: string): boolean {
  if (!scope || scope.length === 0 || !where) return true;
  const module = where.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return scope.some((raw) => {
    const path = zonePath(raw, root);
    if (!path) return true;
    return path === module || path.startsWith(`${module}/`) || module.startsWith(`${path}/`);
  });
}

/**
 * Строки о средах. Отчёт о большом монорепозитории — по строке на каждый из
 * ~40 модулей, 9–10 тыс. знаков в задании каждой группы и в каждом её вызове
 * (замер 16.10.2026). Одинаковые строки склеиваются списком модулей — ни
 * версия, ни команда запуска не теряются; модули вне зоны группы (`scope`) —
 * одной строкой: группа их не правит, но версия и команда при ней остаются.
 */
function runtimeLines(
  notes: WorktreeRuntimeNote[] | undefined,
  scope?: string[],
  root?: string,
): string[] {
  const all = notes ?? [];
  const inside = all.filter((note) => inScope(note.where, scope, root));
  const outside = all.filter((note) => !inScope(note.where, scope, root));
  const lines = groupRuntimes(inside).map(({ note, where }) => runtimeLine(note, where));
  if (outside.length > 0) {
    const parts = groupRuntimes(outside).map(({ note, where }) => {
      const modules = where.map((w) => `${w}/`).join(', ');
      const name = RUNTIME_NAMES[note.tool];
      if (note.status === 'failed')
        return `⚠ ${name} preparation failed in ${modules}${note.detail ? ` (${note.detail})` : ''}`;
      if (note.status === 'missing') return `⚠ ${name} ${note.wanted} not installed for ${modules}`;
      return `${name} ready on ${note.used ?? 'the default'} in ${modules}${note.run ? ` — run: ${note.run}` : ''}`;
    });
    lines.push(`Outside this group's zone (not needed for its tasks): ${parts.join('; ')}.`);
  }
  return lines;
}

/**
 * Чат, который панель запускает в копии, уже получает Node проекта первым в PATH
 * (`chat-node`). Без этой оговорки «put it first in PATH» агенты приписывали
 * `export PATH=…` к КАЖДОМУ Bash — 37 раз за одну группу (R7, живое ревью 19.10).
 */
const NODE_IN_CHAT =
  ' A chat the panel starts here already has it first in PATH: check `node -v` once and prefix PATH only if it differs — never on every command.';

function runtimeLine(note: WorktreeRuntimeNote, modules: string[]): string {
  const listed = modules.filter(Boolean);
  const where =
    listed.length === 0
      ? ''
      : listed.length === 1
        ? ` in ${listed[0]}/`
        : ` in ${listed.map((w) => `${w}/`).join(', ')} (${listed.length} modules)`;
  const head = `${RUNTIME_NAMES[note.tool]}${where}: the project asks for ${note.wanted} (${listed.length > 1 ? sourceOf(note) : note.source})`;
  const run = note.run ? ` Run it with: ${note.run}.` : '';
  const detail = note.detail ? ` ${note.detail}` : '';
  if (note.status === 'switched') {
    return `${head}; the panel prepared the copy on ${note.used}, the machine default is ${note.found ?? 'other'}. Use ${note.used} for installs and runs (put it first in PATH).${note.tool === 'node' ? NODE_IN_CHAT : ''}${run}${detail}`;
  }
  if (note.status === 'missing') {
    return `⚠ ${head}, but no matching version is installed${note.found ? ` (default ${note.found})` : ''}. The copy was NOT prepared on a wrong version${note.tool === 'python' ? ' (no venv was built)' : ''} — say so in the first lines of your answer if the task needs it, and never work around it silently.${detail}`;
  }
  if (note.status === 'failed') {
    return `⚠ ${head}: preparing it failed.${detail} Decide yourself: retry or do without it.`;
  }
  return `${head}: ready on ${note.used ?? 'the default'}.${run}${detail}`;
}

/**
 * Готовая установка — командой, только если та короткая. У монорепозитория команда
 * склеена из цепочки на модуль (`[api] go mod download · [web] npm ci …`): у живой
 * группы 20.10 — 2,4 тыс. знаков в каждом её вызове (замер B.1), а готовую
 * установку группа не повторяет. Провал называет команду целиком — его решают повторить.
 */
const INSTALL_COMMAND_SHOWN = 200;

function installedLine(command: string): string {
  if (command.length <= INSTALL_COMMAND_SHOWN) return `dependencies installed with "${command}"`;
  const steps = command.split(' · ').length;
  return `dependencies installed by the project's copy preparation (${steps} steps)`;
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
 * скрывается — первая строка ошибки и путь к полному логу здесь же, и агент решает сам, повторять установку
 * или обойтись.
 */
export function environmentPreamble(input: EnvironmentPreambleInput): string {
  const lines: string[] = [];
  const done: string[] = [];
  if (input.mirror) done.push(input.mirror);
  const boot = input.bootstrap;
  if (boot?.status === 'ok') done.push(installedLine(boot.command));
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
    const first = boot.firstError?.trim();
    const tail = boot.logTail.trim();
    // Первая строка настоящей ошибки вместо хвоста: хвост из двух килобайт
    // предупреждений установщика (EBADENGINE) прятал причину (13.10.2026).
    const logLine = boot.logFile
      ? `
Full log: ${boot.logFile}`
      : '';
    const evidence = first
      ? `
First error: ${first}${logLine}`
      : tail
        ? `
Log tail:
${tail}${logLine}`
        : '';
    lines.push(
      `⚠ Copy preparation: the command "${boot.command}" ${why}. Dependencies may not be installed — decide yourself: repeat the install or do without it.${evidence}`,
    );
  }
  lines.push(...runtimeLines(boot?.runtimes, input.scope, input.root));
  // «Не проверяй MCP» стоило ревью MR без форджа: сервер не поднялся, а агент,
  // которому сказали «всё готово», молча обходил его (12.10.2026). Готовое не
  // настраивают заново, но отсутствующий инструмент называют, а не обходят.
  const missingTool =
    'If a tool the task needs is missing (an MCP server, a skill, a CLI), say so in the first lines of your answer and name what it blocks — never work around it silently.';
  if (boot?.status === 'ok') {
    lines.push(
      'The environment is ready — do not set it up again (MCP, local layer, dependencies), start with the task right away.',
      missingTool,
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
      missingTool,
    );
  }
  return lines.join('\n');
}

const PREAMBLE_START = /^The panel (prepared this copy|created this copy of the repository)/;
const PREAMBLE_END = 'If a tool the task needs is missing';
const RUNTIME_ROW =
  /^(⚠ )?(Node|Python|Go) in (.+?): the project asks for (.*?) \(([^()]*)\)([;:,] .*)$/;
const COPY_PREP_ROW =
  /^⚠ Copy preparation: the command ".*" (was stopped at the 10-minute ceiling|exited with code \S+)\. (.*)$/;
/** Удачная установка в задании до `installedLine` (20.10) — команда целиком. */
const INSTALLED_WITH = /dependencies installed with "(.*?)"(?=; |\.$)/;
const OUTSIDE_ZONE = "Outside this group's zone (not needed for its tasks): ";
/** Список модулей строки вне зоны (`in a/, b/` или `for a/`): каждый — путь с косой чертой на конце. */
const OUTSIDE_MODULES = /( (?:in|for) )([^\s,;()«»]+\/(?:, [^\s,;()«»]+\/)*)/g;

/**
 * Преамбула окружения в задании, которое продолжение группы получает заново.
 * Первая сессия читает её целиком; продолжению хватает того же без повторов:
 * у живой группы базы знаний (18.10.2026) было 10,8 тыс. знаков — 30 строк Go
 * «ready on 1.27.0», семь одинаковых провалов Python и 2,5 тыс. знаков списка
 * команд подготовки — в каждом первом промпте каждой следующей сессии.
 * Одинаковые строки склеиваются списком модулей (так же, как `groupRuntimes`
 * склеивает новые задания; старые хранятся несклеенными), из провала
 * подготовки уходит только список команд — причина, первая ошибка и путь к
 * логу остаются. Повторный вызов ничего не меняет; текст без преамбулы — тоже.
 */
export function continuationEnvironment(task: string): string {
  const lines = task.split('\n');
  const start = lines.findIndex((line) => PREAMBLE_START.test(line));
  if (start < 0) return task;
  const end = lines.findIndex((line, i) => i > start && line.startsWith(PREAMBLE_END));
  if (end < 0) return task;
  type Row = { head: string; rest: string; where: string[]; wanted: string[] };
  const out: Array<string | Row> = [];
  const groups = new Map<string, Row>();
  for (const [i, line] of lines.slice(start, end).entries()) {
    // Удачная подготовка старого задания — то же сжатие, что `installedLine`
    // даёт новым: у живой группы 24.10 — 2,6 тыс. знаков в каждой вводной.
    if (i === 0) {
      out.push(line.replace(INSTALLED_WITH, (_, command: string) => installedLine(command)));
      continue;
    }
    const prep = COPY_PREP_ROW.exec(line);
    if (prep) {
      out.push(`⚠ Copy preparation ${prep[1]} when the group started. ${prep[2]}`);
      continue;
    }
    // Модули вне зоны группа не правит: продолжению хватает сред, версий и команд без списков
    // модулей — у живой группы 25.10 строка весила 1,3 тыс. знаков в каждой вводной.
    if (line.startsWith(OUTSIDE_ZONE)) {
      out.push(
        line.replace(OUTSIDE_MODULES, (_, lead: string, list: string) => {
          const n = list.split(', ').length;
          return `${lead}${n} ${n === 1 ? 'module' : 'modules'}`;
        }),
      );
      continue;
    }
    const row = RUNTIME_ROW.exec(line);
    if (!row) {
      out.push(line);
      continue;
    }
    const [, warn = '', name, where = '', wanted = '', , rest = ''] = row;
    const key = `${warn}${name}${rest}`;
    const modules = where.replace(/ \(\d+ modules\)$/, '').split(', ');
    // Модуль без объявленной версии пишется «asks for  ()» — в склейке он не версия.
    const asked = wanted.split(' or ').filter(Boolean);
    const group = groups.get(key);
    if (group) {
      group.where.push(...modules.filter((m) => !group.where.includes(m)));
      for (const w of asked) if (!group.wanted.includes(w)) group.wanted.push(w);
    } else {
      const fresh = { head: `${warn}${name}`, rest, where: modules, wanted: asked };
      groups.set(key, fresh);
      out.push(fresh);
    }
  }
  const block = out.map((g) => {
    if (typeof g === 'string') return g;
    const where =
      g.where.length > 1 ? `${g.where.join(', ')} (${g.where.length} modules)` : g.where[0];
    const asked = g.wanted.length > 0 ? `: the project asks for ${g.wanted.join(' or ')}` : '';
    return `${g.head} in ${where}${asked}${g.rest}`;
  });
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
}

/**
 * Дефект ВНЕ задач группы (95b) — блоком в ответе, а не правкой и не тикетом.
 *
 * Чинить чужое группе нельзя (границы разбора), заводить тикет — тоже: запись
 * в трекер требует согласия человека на каждую операцию. А промолчать — значит
 * потерять находку: до блока она оставалась в середине отчёта, который никто
 * не дочитывал. Сервер вынимает блок из текста хода (`split-tickets.ts`), хаб
 * показывает список «Предложить тикет» с кнопкой «копировать».
 *
 * `readOnly` — ревью по ссылке (TQ-10, 12.10.2026): группа ничего не правит и
 * не доставляет, а строки «свои дефекты чини сам» и «шаг, нужный для доставки»
 * ей противоречили. Ей остаётся только блок тикета; дефект проверяемого MR — её
 * замечание ревью, а не блок.
 */
export function splitTicketPreamble(input: { readOnly?: boolean } = {}): string {
  const ticket = [
    "A defect outside this group's tasks, noticed along the way: do not fix it and do not file a " +
      'tracker ticket — describe it in your answer as a block, and the panel shows it to the human ' +
      'in the "Suggested tickets" list:',
    `<${SPLIT_TICKET_TAG}>`,
    'title: briefly, what is broken',
    'where: file with line, screen or route',
    'why: why it is bad and how to reproduce it',
    `</${SPLIT_TICKET_TAG}>`,
  ];
  if (input.readOnly) {
    return [
      ...ticket,
      'One block — one defect. A defect of the merge request you review is a finding of your review, ' +
        'not a block. Write the block values in the language of the task text: the human reads them.',
    ].join('\n');
  }
  return [
    ...ticket,
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
  // Найденный проектный навык не ведёт стадии (владелец 20.10) — только факты проекта.
  const skill = input.skill
    ? 'with the global task delivery skill `ticket-delivery-2` (a global or panel skill outranks a ' +
      `project one: the project skill \`${input.skill}\` does not drive the stages — open it only ` +
      'for the project facts it holds: gate commands, tracker statuses, the stand)'
    : 'with the global task delivery skill `ticket-delivery-2` (no skill — go through the same stages ' +
      'yourself)';
  const ask = input.foreign
    ? 'a question to the human'
    : 'a question to the human with the AskUserQuestion tool';
  return (
    'The human enabled delivery up to an MR on this project in the panel. If the message is a ' +
    'code-change task (ticket, bug, feature, review fixes) and the work is ready, take it to a ' +
    `ready MR ${skill}: a separate branch, not the main one; review, live check, fixing what was ` +
    "found, then the project's checks ONCE on that tree, commit, push, draft MR, MR description — " +
    'and take the draft off when all is clean; the ' +
    "last line of the answer is the MR link. Enabling it is the human's permission to commit, " +
    'push, create and update the MR for this task; merging, deleting branches and force-push are ' +
    'forbidden. A question, an explanation, a review or research without edits needs no MR. A ' +
    `stop of the skill (someone else's task, a DB migration is needed, unclear what is wanted) — ${ask}.`
  );
}

/**
 * Задание группы. `deliver` — за работой идёт звено доставки с полным прогоном
 * проверок: только тогда строка старшинства обещает «правило о полном прогоне
 * выполнит доставка». Без доставки обещание неправда — полный прогон никто не
 * сделает, и группа пропустила бы то, что требует правило (RF-BGCD-06, F-57).
 */
export function buildGroupPrompt(
  group: TaskSplitGroup,
  shared?: string,
  options: { deliver?: boolean } = {},
): string {
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
  // След задач — группе с доставкой: её «готово» судит доставка, и пункт тикета
  // без строки `task-N` держит группу (`taskCoverageGaps`, аудит 26.10).
  if (options.deliver) parts.push(taskCoverageLine());
  // Строка приоритета — последним абзацем: задание выше написано владельцем
  // или его агентом, и всё, что панель допишет к прогону потом (преамбулы,
  // стадии), читается под ней, а не поверх неё. Навык по роду работы (U12) —
  // над ней: это добавка панели, и старшинство накрывает и её.
  parts.push(
    SKILL_ROUTE_LINE,
    options.deliver ? OWNER_PRECEDENCE_LINE : OWNER_PRECEDENCE_PLAIN_LINE,
  );
  return parts.join('\n\n').trim();
}
