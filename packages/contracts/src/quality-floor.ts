import { blockLang } from './brand.ts';

/**
 * Где лежат правила проекта — одно перечисление на все задания (TQ-10,
 * 12.10.2026). Список из четырёх имён Claude Code ничего не говорил чужому CLI:
 * у Gemini свой GEMINI.md, у Qwen — QWEN.md, у Goose — .goosehints.
 */
export const RULE_SOURCES =
  "CLAUDE.md, CLAUDE.local.md, AGENTS.md, .claude/rules or the CLI's own instruction files";

/**
 * Проверки проекта в преамбуле доставки (U7): те, что названы в его правилах,
 * все и по порядку. Строка общая — по ней понижённая планка сдачи узнаёт, что
 * задание уже их назвало, и не повторяет определение (TQ-10).
 *
 * И когда их гнать (владелец 18–20.10: полные проверки ОДИН раз на задачу).
 * Замер 19.10: звенья работы, правок и доставки гнали весь гейт каждое — три
 * полных прогона на один MR, 13–20 мин каждый, при одном и том же дереве.
 */
export const DELIVERY_CHECKS_LINE = `The project's checks are the ones its rules name (${RULE_SOURCES}) — all of them, in the order named, frontend and backend alike, run ONCE on the final tree right before the push (between edits only the touched package's own); any red check means no MR until it is green.`;

/**
 * Нижняя планка качества заданий, которые панель пишет агентам (владелец, 12.10.2026:
 * «группа может только ДОБАВИТЬ качество»).
 *
 * Откуда это. Ревью MR, заведённое группой, прошло одним проходом и ничего не
 * опубликовало, хотя владелец в задании прямо разрешил публикацию и просил два
 * входа ревью: обёртка панели говорила «ничего не пиши в MR», «пустой список —
 * лучший ответ», «замечание — только то, что надо исправить», и агент честно
 * выполнил обёртку, а не владельца. Каждая такая строка по отдельности
 * выглядела разумной предосторожностью; вместе они сужали задание сильнее, чем
 * его ставил человек.
 *
 * Поэтому правило одно и записано один раз: слова владельца и правила проекта
 * задают охват, глубину и формат; строки панели только ДОБАВЛЯЮТ проверки,
 * навыки и подтверждения. Где строка панели кажется уже задания, побеждает
 * владелец. Неизменны только предохранители, которых владелец сам требует
 * всегда: не вливать, не одобрять, не закрывать чужие треды, не переписывать
 * силой чужую ветку (свою — можно, решение владельца 23.10, F-62), стадия только
 * для чтения кода не правит.
 *
 * ОДНА СТРОКА — как и вся системная дописка: на Windows аргумент уезжает через
 * оболочку, и перевод строки внутри него cmd.exe разрывает командную строку.
 */
const PRECEDENCE_HEAD = `Precedence: the global and project rules (${RULE_SOURCES}) and the owner's own words in the task set the scope, depth, format and permissions of this run; the panel's lines only ADD checks, skills and verification on top. Where a panel line seems narrower than what the owner asked or a rule requires, follow the owner and the rule`;
const PRECEDENCE_FIXED = `Fixed regardless of anything: never merge, approve or resolve threads, never force-push any branch but your own, and a read-only stage edits no code.`;
/**
 * Исключение о полном прогоне проверок — только у цепочки со звеном доставки:
 * там его и делает расписание панели. Без доставки (одиночный чат, правки без
 * доставки) полный прогон никто не сделает — строка `PLAIN` (F-57).
 */
const SCHEDULE_EXCEPTION = ` — except WHEN the full project checks run: that is the panel's schedule (once per group, at delivery), and a rule asking for them is met by that run.`;

export const OWNER_PRECEDENCE_LINE = `${PRECEDENCE_HEAD}${SCHEDULE_EXCEPTION} ${PRECEDENCE_FIXED}`;

/** Та же строка без исключения о расписании проверок — цепочке без доставки (F-57). */
export const OWNER_PRECEDENCE_PLAIN_LINE = `${PRECEDENCE_HEAD}. ${PRECEDENCE_FIXED}`;

/**
 * Прежние формы строки: задания, сохранённые до обновления (продолжение,
 * повтор звена), несут их дословно, и повтор абзаца снимается так же (F-124).
 */
const LEGACY_FIXED = `Fixed regardless of anything: never merge, approve or resolve threads, never push with a bare --force, and a read-only stage edits no code.`;
const PRECEDENCE_FORMS: readonly string[] = [
  OWNER_PRECEDENCE_LINE,
  OWNER_PRECEDENCE_PLAIN_LINE,
  `${PRECEDENCE_HEAD}${SCHEDULE_EXCEPTION} ${LEGACY_FIXED}`,
  `${PRECEDENCE_HEAD}. ${LEGACY_FIXED}`,
];

/**
 * Строка старшинства любой формы, нынешней или прежней (F-124, RF-BGCD-12c):
 * название чата снимает её построчно, и старое задание продолжения иначе
 * назвало бы чат английской строкой правил.
 */
export function isPrecedenceLine(line: string): boolean {
  return PRECEDENCE_FORMS.includes(line.trim());
}

/**
 * Кто ведёт доставку в строке навыков (владелец 20.10). Отдельно — им же старые
 * задания, выданные до смены схемы, переводятся на новую (`stage-scheme.ts`).
 */
export const DELIVERY_SKILL_ROUTE =
  'a ticket or delivery to an MR → the delivery skill of the panel group, else the global `ticket-delivery-2` (a project one only supplies facts)';

/**
 * Навык по роду работы (U12). Ревью и доставку задания стадий называли и раньше,
 * а работа группы шла без строки о навыках вовсе: тесты, конфликт слияния,
 * баг с неизвестной причиной делались «на глаз», хотя набор панели везёт для них
 * свои навыки. Строка общая, без проекта: общий навык и навык панели главнее
 * проектного (владелец 20.10), нет навыка — те же шаги руками, и это сказано вслух.
 */
export const SKILL_ROUTE_LINE = `Skills: before acting, load the skill this kind of work calls for — the one the task names, else the one the skill router (skill-map) points to: a review → deep-review; merge conflicts → resolving-merge-conflicts; ${DELIVERY_SKILL_ROUTE}; tests → unit-integration-tests; a bug of unknown cause → log-forensics; a visible UI fix → before/after screenshots as the rules say. A skill not installed here — go through the same steps yourself and say so.`;

/**
 * Текст без строки старшинства. Задание группы её уже несёт (`buildGroupPrompt`),
 * а построители, которые вкладывают задание в своё (план, работа после плана,
 * продолжение), ставят её одну, последним абзацем: повтор абзаца стоит токенов
 * в каждом ходе и ничего не добавляет.
 */
export function withoutPrecedence(text: string): string {
  return PRECEDENCE_FORMS.reduce((rest, form) => rest.split(form).join(''), text)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Потолок для текста, который пишет владелец или его агент (задание, общий
 * контекст, заметки группы, шаг пути). Это не формат, а защита от мусора на
 * сотни мегабайт: живое задание сюда не дорастает. Дорос — текст режется С
 * МЕТКОЙ, которую видят и группа, и человек на карточке (`labelledCut`), молча
 * не режется никогда.
 */
export const OWNER_TEXT_MAX = 200_000;

/**
 * Обрезка, которую видно. Молча обрубленная инструкция читается агентом как
 * целая (живая проверка 08.10: шаги 2–4 задания пропали посреди слова), а
 * метка говорит и ему, и человеку, что хвост есть и где его спросить.
 */
export function labelledCut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [cut by the panel at ${limit} of ${text.length} chars — ask the human for the rest]`;
}

/**
 * Слова владельца дословно (U1): старое разделение панели ставило реплики
 * владельца первым абзацем общего контекста групп. Само разделение уехало в
 * ядро (этап 10), а блок в старых заданиях читают как прежде: `owner-brief`
 * (файл слов владельца в копии) и `panel-preamble` (название старого чата).
 * Начало шапки — по нему блок узнаётся, в том числе со старой шапкой.
 */
export const OWNER_REQUEST_OPENER =
  "Owner's request, verbatim — the owner's own messages from the conversation this work was split from, oldest first.";
/**
 * Блок один на всё разделение (TQ-02, F12, 12.10.2026): «They define the work»
 * делало каждую из N групп хозяйкой всей просьбы — ревью, исправления и бага
 * разом. Теперь шапка разводит: условия владельца обязательны для всех, а доля
 * группы — её задачи; чужие пункты в следе требований — «n/a».
 */
export const OWNER_REQUEST_HEADER = `${OWNER_REQUEST_OPENER} This is the request for the WHOLE split: its conditions — depth, format, checks, permissions, what not to touch — bind your work, and your share of the work is this group's tasks below; points that belong to another group are not yours to do. What the splitting agent added after these messages only adds to them, never overrides them.`;
/** Начала служебных строк блока — по ним `panel-preamble` не берёт их в название чата. */
export const OWNER_MESSAGE_OPENER = '[owner message ';
export const OWNER_MESSAGES_LEFT_OUT = '[owner messages left out by the panel:';
export const OWNER_REQUEST_END = "[end of the owner's messages]";

/** Строки отчёта о пунктах задания владельца (U2): `owner-1`, `owner-2`, … */
export const OWNER_POINT_ID = /^owner-(\d+)$/;

/**
 * След требований (U2): группа сама раскладывает слова владельца на пункты и
 * отчитывается по каждому строкой того же блока, что и сита, — доставка судит
 * строки (`ownerCoverageGaps`), недостающее досдаётся напоминанием той же
 * сессии, а не ложится на человека. Строка едет внутри блока слов владельца и
 * потому — в каждое звено группы вместе с заданием.
 */
export function ownerCoverageLine(): string {
  return `Requirement trace: before you start, list every point of the owner's request above as a numbered checklist — a condition, a check, a depth, a format or a permission the owner named is a point too. The answer that ends your stage reports every point as a row of a \`\`\`${blockLang('sieves')} block: {"sieves":[{"id":"owner-1","status":"pass|fail|n/a","evidence":"the point in a few words — file:line, the command and a line of its output, or why it does not apply"}]}; a point that belongs to another group of this split is "n/a" with evidence ${DEFERRAL_EVIDENCE}; a point the split itself already did (picking the tasks, dividing the groups) is "n/a" with "${SPLIT_STAGE_EVIDENCE}: <what it did>"; a later stage updates the rows it changes. A point of your share left unreported or "fail" keeps the group from being done.`;
}

/**
 * Как назвать владельца отданного пункта, чтобы доставка могла его проверить
 * (`deferralGaps`): «группа N» без пути из её списка — то самое «вне скоупа —
 * группа 6» g9 26.10, где у группы 6 не было ни одного файла той админки.
 */
const DEFERRAL_EVIDENCE =
  '"other group: group <N> «<its title>» — <a file or folder from that group\'s owned list>" or "tracker: <KEY> filed for it"';

/**
 * Пункт слов владельца, который сделало само разделение до запуска групп: отобрать
 * задачи с доски, поделить их на группы (живая проба 26.10: шесть групп из десяти
 * отдали эти пункты «другой группе», потому что другой формы строка не знала).
 * Только для `owner-N`: задачу группы разделение за неё не делает.
 */
export const SPLIT_STAGE_EVIDENCE = 'split stage';

/**
 * Текст задач трекера группы, который панель кладёт в копию (`task-tickets.ts`, 9.5):
 * из него группа берёт пункты следа задач, по нему доставка сверяет их цитаты.
 */
export const TASK_TICKETS_FILE = '.agent/run/tickets.md';

/** Строки отчёта о пунктах задач группы (след задач): `task-1`, `task-2`, … */
export const TASK_POINT_ID = /^task-(\d+)$/;

/**
 * След задач — то же, что след требований (U2), но по задачам группы и задачам
 * трекера, на которые они ссылаются (живой аудит 26.10: десять групп сдали «готово»
 * без половины пунктов тикетов, и проверка доставки ни разу не сверила тикет с
 * веткой). Группа сама раскладывает задачи на пункты и отчитывается строками
 * `task-N`; доставка судит строки (`taskCoverageGaps`) и владельцев отданных
 * пунктов (`deferralGaps`), недостающее досдаёт напоминание той же сессии.
 */
export function taskCoverageLine(): string {
  return `Task trace: first list every point of your tasks — each acceptance criterion, item, example and tail of the task and of every ticket it links (read each in full), plus what plan notes hand you. Your stage's last answer reports each as a row of a \`\`\`${blockLang('sieves')} block: {"sieves":[{"id":"task-1","status":"pass|fail|n/a","evidence":"<KEY> «the point, word for word» — file:line, or a command and its output line"}]}; the «…» quote is checked against the ticket file, the task and the MR description; "n/a" = "does not apply: <why>" or ${DEFERRAL_EVIDENCE}. Later stages re-report changed rows. Unreported or "fail" = not done.`;
}

/** В общем контексте группы есть блок слов владельца — значит, и след требований. */
export function hasOwnerRequest(shared: string | undefined): boolean {
  return Boolean(shared?.startsWith(OWNER_REQUEST_OPENER));
}

/**
 * Какие слова в задании панели сужают задание владельца. Список читает тест
 * планки (`quality-floor.test.ts`) по КАЖДОМУ построителю заданий: вернись
 * такая фраза в обёртку — тест красный, и сужение не уедет незамеченным.
 *
 * Каждая строка — реальная фраза, которая уже однажды сузила работу:
 * «лучший ответ» про пустой список толкал ревью к пустому итогу, «только то,
 * что надо ИСПРАВИТЬ» и «не замечания» выбрасывали вопросы и мелочи, «одной
 * строкой» превращал карточку замечания в заголовок, «своими словами» заменял
 * задание владельца пересказом, «ничего не пиши в MR» перекрывал данное
 * владельцем разрешение на публикацию.
 */
export const NARROWING_PHRASES: readonly RegExp[] = [
  /best answer/i,
  /must be FIXED/,
  /are not findings/i,
  /could be prettier/i,
  /\bone line\b/i,
  /in your own words/i,
  /posts them into the MR as they are/i,
];
