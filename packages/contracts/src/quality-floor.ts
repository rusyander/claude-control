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
 * Догон основной ветки — только при настоящем конфликте с ней (владелец 19.10,
 * MUST #1). Без конфликта брокер всё равно откажет (`MAIN_SYNC_DENIED`), и
 * задание, велящее догонять, стоило бы хода на отказ и гейта заново.
 */
export const SYNC_ON_CONFLICT_LINE =
  '`git fetch origin`; `git merge-tree --write-tree --quiet HEAD origin/<main>` exit 0 = no ' +
  'conflict: stay on the current base, never rebase, merge or pull main; exit 1 = a real ' +
  'conflict: `git rebase origin/<main>` and resolve it.';

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
 * всегда: не вливать, не одобрять, не закрывать чужие треды, не пушить голым
 * `--force`, стадия только для чтения кода не правит.
 *
 * ОДНА СТРОКА — как и вся системная дописка: на Windows аргумент уезжает через
 * оболочку, и перевод строки внутри него cmd.exe разрывает командную строку.
 */
export const OWNER_PRECEDENCE_LINE = `Precedence: the global and project rules (${RULE_SOURCES}) and the owner's own words in the task set the scope, depth, format and permissions of this run; the panel's lines only ADD checks, skills and verification on top. Where a panel line seems narrower than what the owner asked or a rule requires, follow the owner and the rule. Fixed regardless of anything: never merge, approve or resolve threads, never push with a bare --force, and a read-only stage edits no code.`;

/**
 * Навык по роду работы (U12). Ревью и доставку задания стадий называли и раньше,
 * а работа группы шла без строки о навыках вовсе: тесты, конфликт слияния,
 * баг с неизвестной причиной делались «на глаз», хотя набор панели везёт для них
 * свои навыки. Строка общая, без проекта: общий навык и навык панели главнее
 * проектного (владелец 20.10), нет навыка — те же шаги руками, и это сказано вслух.
 */
export const SKILL_ROUTE_LINE =
  'Skills: before acting, load the skill this kind of work calls for — the one the task names, else the one the skill router (skill-map) points to: a review → deep-review; merge conflicts → resolving-merge-conflicts; a ticket or delivery to an MR → the delivery skill of the panel group, else the global `ticket-delivery-2` (a project one only supplies facts); tests → unit-integration-tests; a bug of unknown cause → log-forensics; a visible UI fix → before/after screenshots as the rules say. A skill not installed here — go through the same steps yourself and say so.';

/**
 * Текст без строки старшинства. Задание группы её уже несёт (`buildGroupPrompt`),
 * а построители, которые вкладывают задание в своё (план, работа после плана,
 * продолжение), ставят её одну, последним абзацем: повтор абзаца стоит токенов
 * в каждом ходе и ничего не добавляет.
 */
export function withoutPrecedence(text: string): string {
  return text
    .split(OWNER_PRECEDENCE_LINE)
    .join('')
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
 * Разрешил ли владелец опубликовать ревью в MR — по его словам в задании.
 *
 * Живое ревью MR (12.10.2026): владелец написал «отпиши ревью в MR», а обёртка
 * группы сказала «ничего не пиши в MR», и публикация не случилась. Разрешение,
 * данное в задании, — то самое согласие, ради которого стоит карточка; второй
 * раз его не спрашивают.
 *
 * Запрет сильнее разрешения (12.10.2026): «в MR ничего не публикуй — отпиши
 * мне итог» читалось как разрешение, потому что «отпиши» стояло без отрицания.
 * Теперь любой запрет публикации в реплике снимает её разрешение целиком, а
 * «отпиши» разрешает, только когда пишут в MR или о ревью — не «мне», не «в
 * чат». Ошибиться в сторону «спросить» дешевле, чем написать в чужой MR.
 */
export type PublishVerdict = 'grant' | 'ban';

/** Публикация сама по себе — разрешает и без адреса. */
const PUBLISH_VERB = /публик|\bpublish/giu;
/** Запись, которая разрешает, если у неё есть адрес MR. */
const WRITE_TO_MR_VERB = /отпиш|запиш|напиш|оставь|\bpost\b|\bleave\b|\bwrite\b|\badd\b/giu;
/** Запись, которая разрешает и без адреса, если пишут ревью или замечания. */
const WRITE_REVIEW_VERB = /отпиш|оставь|\bpost\b|\bleave\b/iu;
/** Запись, запрет которой при адресе MR запрещает публикацию. */
const WRITE_BAN_VERB = /пиш|публик|оставл|оставь|коммент|\bpost|\bwrite|\bcomment|\bpublish/giu;
const MR_TARGET =
  /(?:^|[^\p{L}])(?:в|во|к|на|по)\s+(?:этот\s+|этом\s+)?(?:mr|мр|merge request|pull request|pr)(?!\p{L})|\b(?:in|into|to|on)\s+(?:the\s+|this\s+)?(?:mr|merge request|pull request|pr)\b|\/-\/merge_requests\/|\/pull\//iu;
const REVIEW_OBJECT = /ревью|замечан|коммент|тред|\breview|\bfinding|\bcomment|\bthread/iu;
/** Итог уходит человеку, а не в MR. */
const ELSEWHERE =
  /(?:^|[^\p{L}])(?:мне|сюда|в чат|в телеграм|в слак)(?!\p{L})|\b(?:to me|me the|in (?:the )?chat|here)\b/iu;
// `\b` в JS видит только латиницу — границу перед «не» ищем классом букв.
const NEGATION_BEFORE =
  /(?:^|[^\p{L}])(?:не|без|don'?t|do not|never)(?:\s+(?:надо|нужно|стоит|need to|to))?\s*$/iu;
const NOTHING_AFTER = /^\p{L}*\s+(?:nothing|ничего)(?!\p{L})/iu;
/** Части одной реплики: запрет и разрешение в разных частях не путаются. */
const CLAUSE_SPLIT = /[.;!?\n—–]+|,\s+/u;

function negated(clause: string, at: number, verbLength: number): boolean {
  const before = clause.slice(Math.max(0, at - 16), at);
  return NEGATION_BEFORE.test(before) || NOTHING_AFTER.test(clause.slice(at + verbLength - 1));
}

function clauseBans(clause: string): boolean {
  for (const match of clause.matchAll(PUBLISH_VERB))
    if (negated(clause, match.index, match[0].length)) return true;
  if (!MR_TARGET.test(clause)) return false;
  for (const match of clause.matchAll(WRITE_BAN_VERB))
    if (negated(clause, match.index, match[0].length)) return true;
  return false;
}

function clauseGrants(clause: string): boolean {
  for (const match of clause.matchAll(PUBLISH_VERB))
    if (!negated(clause, match.index, match[0].length)) return true;
  for (const match of clause.matchAll(WRITE_TO_MR_VERB)) {
    if (negated(clause, match.index, match[0].length)) continue;
    if (MR_TARGET.test(clause)) return true;
    if (WRITE_REVIEW_VERB.test(match[0]) && REVIEW_OBJECT.test(clause) && !ELSEWHERE.test(clause))
      return true;
  }
  return false;
}

/** Что одна реплика говорит о публикации: запрет где угодно в ней сильнее разрешения. */
export function publishVerdict(text: string | undefined): PublishVerdict | undefined {
  if (!text) return undefined;
  const clauses = text.split(CLAUSE_SPLIT).filter((part) => part.trim());
  if (clauses.some(clauseBans)) return 'ban';
  return clauses.some(clauseGrants) ? 'grant' : undefined;
}

export function grantsReviewPublish(text: string | undefined): boolean {
  return publishVerdict(text) === 'grant';
}

/**
 * Слова владельца дословно (U1): при разделении панель САМА берёт его реплики
 * из разговора-родителя и ставит их первым абзацем общего контекста групп.
 * Пересказ агента терял условия (живое ревью MR, 12.10.2026: просьба о двух
 * входах ревью и разрешение публиковать не дошли до группы) — теперь пересказ
 * только добавляется под слова владельца, а не стоит вместо них.
 */
/**
 * Начало шапки — по нему блок узнаётся, в том числе со старой шапкой из записи
 * конвейера, начатого до правки ниже.
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
const OWNER_MESSAGE_MARK = (n: number, of: number) => `${OWNER_MESSAGE_OPENER}${n} of ${of}]`;
const OWNER_MESSAGE_LINE = /^\[owner message (\d+) of (\d+)\]$/;
export const OWNER_REQUEST_END = "[end of the owner's messages]";

/**
 * Блок слов владельца. Сверх `OWNER_TEXT_MAX` уходят САМЫЕ СТАРЫЕ реплики — с
 * меткой, сколько их было: последние слова определяют работу точнее первых.
 */
export function ownerRequestBlock(messages: readonly string[]): string | undefined {
  const said = messages.map((text) => text.trim()).filter(Boolean);
  if (said.length === 0) return undefined;
  let first = 0;
  let size = said.reduce((sum, text) => sum + text.length, 0);
  while (size > OWNER_TEXT_MAX && first < said.length - 1) {
    size -= (said[first] as string).length;
    first += 1;
  }
  const kept = said.slice(first).map((text) => labelledCut(text, OWNER_TEXT_MAX));
  const parts = [OWNER_REQUEST_HEADER];
  if (first > 0)
    parts.push(
      `${OWNER_MESSAGES_LEFT_OUT} the ${first} oldest, over the ${OWNER_TEXT_MAX}-char cap — ask the human for them if the work needs them]`,
    );
  kept.forEach((text, index) =>
    parts.push(`${OWNER_MESSAGE_MARK(index + 1, kept.length)}\n\n${text}`),
  );
  parts.push(OWNER_REQUEST_END);
  parts.push(ownerCoverageLine());
  return parts.join('\n\n');
}

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
  return `Requirement trace: before you start, list every point of the owner's request above as a numbered checklist — a condition, a check, a depth, a format or a permission the owner named is a point too. The answer that ends your stage reports every point as a row of a \`\`\`${blockLang('sieves')} block: {"sieves":[{"id":"owner-1","status":"pass|fail|n/a","evidence":"the point in a few words — file:line, the command and a line of its output, or why it does not apply"}]}; a point that belongs to another group of this split is "n/a" with evidence "other group: <its title or task>"; a later stage updates the rows it changes. A point of your share left unreported or "fail" keeps the group from being done.`;
}

/** В общем контексте группы есть блок слов владельца — значит, и след требований. */
export function hasOwnerRequest(shared: string | undefined): boolean {
  return Boolean(shared?.startsWith(OWNER_REQUEST_OPENER));
}

/** Реплики владельца из блока и текст после него — обратная сторона `ownerRequestBlock`. */
export function splitOwnerRequest(text: string | undefined): { messages: string[]; rest: string } {
  if (!text?.startsWith(OWNER_REQUEST_OPENER)) return { messages: [], rest: text ?? '' };
  const end = text.indexOf(OWNER_REQUEST_END);
  if (end < 0) return { messages: [], rest: text };
  const messages: string[] = [];
  let current: string[] | undefined;
  const body = text.indexOf('\n');
  for (const line of text.slice(body < 0 ? end : body, end).split('\n')) {
    if (OWNER_MESSAGE_LINE.test(line.trim())) {
      if (current) messages.push(current.join('\n').trim());
      current = [];
    } else current?.push(line);
  }
  if (current) messages.push(current.join('\n').trim());
  return { messages, rest: text.slice(end + OWNER_REQUEST_END.length).trim() };
}

/** Абзац для сравнения: без кавычек цитаты, разметки цитаты и разницы в пробелах. */
const comparable = (text: string): string =>
  text
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:\d+[.)]|[-*•])\s+/gm, '')
    .replace(/[«»"“”„'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Короче этого абзац совпадает случайно («Сделай тесты.») и остаётся на месте. */
const DUPLICATE_MIN = 40;

/**
 * Общий контекст группы: слова владельца первыми, под ними — то, что добавил
 * агент. Строка агента, которая дословно повторяет слова владельца, второй раз
 * не идёт: одно и то же дважды в задании — только расход (E5). Сверка по
 * строкам, а не по абзацам (TQ-07): агент собирал реплики владельца списком
 * или цитатой в один абзац, и абзац целиком в словах владельца не находился.
 */
export function withOwnerRequest(
  shared: string | undefined,
  block: string | undefined,
): string | undefined {
  if (!block) return shared;
  const said = comparable(block);
  const repeated = (text: string): boolean => {
    const own = comparable(text);
    return own.length >= DUPLICATE_MIN && said.includes(own);
  };
  const rest = (shared ?? '')
    .split(/\n[ \t]*\n/)
    .filter((paragraph) => !repeated(paragraph))
    .map((paragraph) =>
      paragraph
        .split('\n')
        .filter((line) => !repeated(line))
        .join('\n'),
    )
    .filter((paragraph) => comparable(paragraph).length > 0)
    .join('\n\n')
    .trim();
  return rest ? `${block}\n\n${rest}` : block;
}

/** Реплика о ревью или MR — только в такой «отпиши» значит публикацию ревью. */
const REVIEW_TOPIC =
  /ревью|\breview|\bmr\b|\bмр\b|merge request|pull request|\bpr\b|\/-\/merge_requests\/|\/pull\//iu;

/**
 * Разрешение публиковать ревью группы. Слова владельца из блока U1 — весь
 * разговор, и «отпиши» в нём могло относиться к другому делу: оттуда решение
 * берётся только из реплик о ревью или MR, и решает последняя такая — владелец
 * мог передумать в любую сторону. Его запрет добавки агента и задачи не
 * перебивают; без слова владельца они решают, как раньше, целиком. Чужой MR —
 * запись наружу, и ошибиться в сторону «спросить» дешевле.
 */
export function reviewPublishGranted(
  shared: string | undefined,
  tasks: readonly string[],
): boolean {
  const { messages, rest } = splitOwnerRequest(shared);
  let owner: PublishVerdict | undefined;
  for (const text of messages) {
    if (!REVIEW_TOPIC.test(text)) continue;
    owner = publishVerdict(text) ?? owner;
  }
  if (owner) return owner === 'grant';
  return grantsReviewPublish([rest, ...tasks].join('\n'));
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
