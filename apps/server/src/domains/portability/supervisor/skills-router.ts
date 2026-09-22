/**
 * СКИЛЛЫ ДЛЯ CLI БЕЗ СВОЕГО МЕХАНИЗМА (П3.4).
 *
 * У Claude скилл раскрывается постепенно: в контексте всегда лежит только имя и
 * `description`, а тело подкладывается тогда, когда скилл понадобился. Инструмента
 * `Skill` у чужого CLI нет и не будет — значит постепенное раскрытие отыгрывает
 * панель: каталог уходит в инструкции цели, тело дописывается в следующий запрос.
 *
 * Тело НИКОГДА не едет через argv. Потолок argv около 32k, промпт и так режется на
 * 24k (`provider-chat/prompt.ts`), а тело скилла бывает длиннее обоих — уехав
 * аргументом, оно обрубится молча.
 */

/** Одна запись каталога: то, что у Claude лежит в контексте всегда. */
export interface SkillCatalogEntry {
  readonly name: string;
  readonly description: string;
  /**
   * Приоритет: чем БОЛЬШЕ, тем важнее остаться в каталоге при переполнении.
   *
   * Поле обязательное и явное намеренно. Отбрасывание «с конца списка» означало бы,
   * что порядок чтения каталога с диска решает, какой скилл модель увидит, — то
   * есть решение принимал бы алфавит, и притом молча.
   */
  readonly priority: number;
}

export interface SkillCatalog {
  /** Текст, который уходит в инструкции цели. Пусто — каталог не влез вовсе. */
  readonly text: string;
  /** Что поместилось, в порядке показа. */
  readonly included: readonly SkillCatalogEntry[];
  /** Что отброшено — перечисляется поимённо, а не теряется. */
  readonly dropped: readonly SkillCatalogEntry[];
  readonly chars: number;
}

/** Одна строка каталога — имя и описание, без тела. */
function lineOf(entry: SkillCatalogEntry): string {
  return `- ${entry.name}: ${entry.description}`;
}

/**
 * Каталог в бюджет символов.
 *
 * Порядок отбора — по приоритету (больше вперёд), при равном приоритете по имени:
 * иначе два прогона с одним набором скиллов давали бы разные каталоги, и
 * объяснить пользователю, почему скилл исчез, было бы нечем.
 *
 * Показывается каталог в ТОМ ЖЕ порядке, в каком отбирался: у модели тоже есть
 * начало внимания, и важное должно стоять первым.
 */
export function buildSkillCatalog(
  entries: readonly SkillCatalogEntry[],
  budgetChars: number,
): SkillCatalog {
  const ordered = [...entries].sort(
    (left, right) => right.priority - left.priority || left.name.localeCompare(right.name),
  );

  const included: SkillCatalogEntry[] = [];
  const dropped: SkillCatalogEntry[] = [];
  let chars = 0;

  for (const entry of ordered) {
    // Перевод строки между записями считается: бюджет должен совпадать с тем, что
    // реально уедет цели, а не быть на единицу меньше на каждой строке.
    const cost = lineOf(entry).length + (included.length > 0 ? 1 : 0);
    if (chars + cost > budgetChars) {
      dropped.push(entry);
      continue;
    }
    included.push(entry);
    chars += cost;
  }

  return { text: included.map(lineOf).join('\n'), included, dropped, chars };
}

/**
 * Скилл, названный в тексте.
 *
 * Ищется и `/имя`, и имя как отдельное слово: модель называет скилл и так, и так,
 * а требовать от неё одной формы панель не может — у чужого CLI нет инструмента,
 * которым имя приехало бы полем.
 *
 * Возвращается ровно одно имя — самое длинное из совпавших. Иначе `review` внутри
 * `deep-review` уводил бы в другой скилл, и человек получал бы не то тело.
 */
export function matchSkillName(
  text: string,
  entries: readonly SkillCatalogEntry[],
): string | undefined {
  const lowered = text.toLowerCase();

  const matched = entries
    .filter((entry) => {
      const name = entry.name.toLowerCase();
      if (lowered.includes(`/${name}`)) return true;
      // Границей слова считаем всё, что не буква, не цифра, не дефис: имена
      // скиллов пишутся через дефис, и он частью границы быть не может.
      //
      // Буква здесь — ЛЮБАЯ буква (`\p{L}`), а не латинская: с классом `a-z`
      // кириллица работала границей, и «переразборку» попадало под скилл
      // «разбор» — человек получал тело чужого скилла, не назвав его. Ту же
      // ошибку П3.4 уже исправил в разборе команд.
      return new RegExp(
        `(^|[^\\p{L}\\p{N}-])${escapeForRegExp(name)}([^\\p{L}\\p{N}-]|$)`,
        'u',
      ).test(lowered);
    })
    .map((entry) => entry.name);

  if (matched.length === 0) return undefined;
  return matched.sort((left, right) => right.length - left.length)[0];
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Как тело скилла попадает к цели. */
export type SkillBodyChannel = 'instructions' | 'file';

export interface SkillBodyDelivery {
  readonly channel: SkillBodyChannel;
  /** Текст для канала `instructions`. */
  readonly text?: string;
  /** Путь файла для канала `file` — его цель прочитает сама. */
  readonly path?: string;
}

/**
 * Куда положить тело скилла.
 *
 * Короткое тело уезжает инструкциями — это дешевле и не оставляет файлов. Длинное
 * уезжает файлом: инструкции у чужих CLI тоже не бесконечны, а обрубленное
 * наполовину тело хуже отсутствующего — модель уверенно делает половину работы.
 *
 * Канала `argv` здесь нет и появиться не может: тип не предусматривает его
 * намеренно.
 */
export function planSkillBody(
  body: string,
  options: { readonly maxInstructionChars: number; readonly filePath: string },
): SkillBodyDelivery {
  if (body.length <= options.maxInstructionChars) {
    return { channel: 'instructions', text: body };
  }
  return { channel: 'file', path: options.filePath };
}

/** Тело одного скилла вместе с путём файла, которым его можно отдать. */
export interface SkillBodySource {
  readonly text: string;
  /** Путь SKILL.md на этой машине — цель читает его сама. */
  readonly filePath: string;
}

export interface SkillTurnRequest {
  readonly entries: readonly SkillCatalogEntry[];
  /**
   * Бюджет каталога в символах. Это и есть защита от потолка argv: каталог —
   * единственное, что уезжает вместе с промптом, и он ограничен здесь.
   */
  readonly budgetChars: number;
  /** Последняя реплика человека: в ней ищется имя скилла. */
  readonly prompt?: string;
  /**
   * Тело скилла по имени. Функция, а не готовая карта: тела бывают в сотни
   * килобайт, и читать их все ради одного — платить диском за каждый запрос.
   */
  readonly readBody: (name: string) => SkillBodySource | undefined;
  /**
   * Сколько символов тела панель может положить в файл ИНСТРУКЦИЙ цели.
   *
   * Задаётся только тем, кто этим файлом владеет (подписка, П5). Не задано —
   * панель файлом инструкций не распоряжается, и тело уезжает единственным
   * оставшимся каналом: путём к своему же `SKILL.md`.
   */
  readonly instructionsBudget?: number;
}

export interface SkillTurnPlan {
  /**
   * Тексты, которые встают перед перепиской и уезжают вместе с промптом.
   *
   * Здесь ровно две вещи: каталог (ограничен бюджетом) и — если скилл назван —
   * ОДНА строка с путём его файла. Тела скилла здесь нет и быть не может: промпт
   * уезжает элементом argv, а argv обрывается около 32k.
   */
  readonly prefixes: readonly string[];
  /** Скилл, тело которого подложено в ЭТОТ запрос. */
  readonly used?: string;
  /** Каким каналом уехало тело. */
  readonly channel?: SkillBodyChannel;
  /**
   * Текст для файла инструкций цели — его пишет владелец файла, не эта функция.
   * Пусто, если тело уехало путём.
   */
  readonly instructionsText?: string;
  /** Что не влезло в каталог — называется поимённо. */
  readonly dropped: readonly SkillCatalogEntry[];
}

/**
 * Один ход разговора с точки зрения скиллов: каталог всегда, тело — по имени.
 *
 * Это и есть постепенное раскрытие, отыгранное панелью: в контексте цели лежит
 * только каталог, а тело появляется ровно тогда, когда модель или человек назвали
 * скилл. Функция ЧИСТАЯ — диск за ней ходит `readBody`, процесс не запускается
 * вовсе, поэтому «тело не едет через argv» проверяется не здесь, а живым
 * прогоном (`tools/qa/check-supervisor-skills.mjs`).
 *
 * Названный, но нечитаемый скилл молчит: подложить пустое тело значило бы сказать
 * модели «скилл пуст», хотя он просто не прочитался.
 */
export function planSkillTurn(request: SkillTurnRequest): SkillTurnPlan {
  const catalog = buildSkillCatalog(request.entries, request.budgetChars);
  const prefixes: string[] = [];
  if (catalog.text) prefixes.push(`${SKILL_CATALOG_HEADING}\n${catalog.text}`);

  // Имя ищется только среди ПОКАЗАННЫХ скиллов: отброшенного модель не видела, и
  // «совпадение» с ним было бы совпадением с тем, чего в её контексте не было.
  const name = request.prompt ? matchSkillName(request.prompt, catalog.included) : undefined;
  if (!name) return { prefixes, dropped: catalog.dropped };

  const source = request.readBody(name);
  if (!source) return { prefixes, dropped: catalog.dropped };

  const delivery = planSkillBody(source.text, {
    // Без владения файлом инструкций бюджет этого канала равен нулю, и остаётся
    // только путь. Нулём, а не отсутствием проверки: так канал один и тот же, и
    // подписка (П5) включает его числом, не второй веткой кода.
    maxInstructionChars: request.instructionsBudget ?? 0,
    filePath: source.filePath,
  });

  // В промпт уходит ПУТЬ, а не тело, — и тогда, когда тело поехало инструкциями
  // тоже: файл инструкций цель читает сама, и повторять его в запросе незачем.
  prefixes.push(`${skillBodyHeading(name)} ${source.filePath}`);

  return {
    prefixes,
    used: name,
    channel: delivery.channel,
    ...(delivery.channel === 'instructions' ? { instructionsText: delivery.text ?? '' } : {}),
    dropped: catalog.dropped,
  };
}

/** Заголовок каталога в инструкциях цели. */
const SKILL_CATALOG_HEADING =
  'Доступные скиллы (имя: назначение). Назови скилл по имени, чтобы получить его инструкции:';

function skillBodyHeading(name: string): string {
  return `Инструкции скилла «${name}» лежат в файле, прочитай его целиком:`;
}
