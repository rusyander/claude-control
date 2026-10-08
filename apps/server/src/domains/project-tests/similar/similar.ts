import type {
  ProjectTestCase,
  ProjectTestDraftSimilar,
  ProjectTestDuplicate,
  ProjectTestGroup,
} from '@agentdeck/contracts';
import { stepText } from '@agentdeck/contracts/test-format';

/**
 * Похожесть кейсов по словам — единственная защита библиотеки от собственной
 * генерации.
 *
 * Агент, которого просят «допиши кейсы», на третьем прогоне приносит третий
 * «Вход с пустым паролем»: он не помнит предыдущие два, а человек руками такой
 * набор уже не сведёт. Поэтому похожесть считается ЗДЕСЬ, до записи в файлы, и
 * считается словами: множество токенов заголовка и шагов, мера Жаккара.
 *
 * Ни эмбеддингов, ни внешних моделей — намеренно. Ответ нужен мгновенный (он
 * рисуется в приёмке черновика, пока человек читает строку), одинаковый на
 * офлайн-машине и объяснимый: «совпали на 82% по этим словам», а не «модель так
 * решила». Модуль чистый: ни файлов, ни сети, ни времени.
 */

/**
 * Служебные слова русского и английского: они есть почти в каждом кейсе и
 * похожесть от них только растёт. Сюда же — подписи `stepText` («данные»,
 * «ожидание»): это форматирование панели, а не слова кейса.
 */
const STOPWORDS = new Set([
  'и',
  'в',
  'во',
  'на',
  'с',
  'со',
  'из',
  'к',
  'ко',
  'у',
  'о',
  'об',
  'от',
  'до',
  'по',
  'за',
  'при',
  'над',
  'под',
  'без',
  'про',
  'для',
  'же',
  'ли',
  'бы',
  'то',
  'не',
  'ни',
  'но',
  'а',
  'или',
  'что',
  'чтобы',
  'как',
  'так',
  'это',
  'этот',
  'эта',
  'все',
  'весь',
  'есть',
  'был',
  'была',
  'было',
  'быть',
  'если',
  'когда',
  'после',
  'перед',
  'там',
  'тут',
  'где',
  'его',
  'её',
  'их',
  'данные',
  'ожидание',
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'for',
  'and',
  'or',
  'is',
  'are',
  'be',
  'as',
  'with',
  'from',
  'into',
  'that',
  'this',
  'it',
  'its',
  'when',
  'then',
  'should',
  'must',
]);

/**
 * Порог похожести по умолчанию.
 *
 * Настоящей библиотеки (`.agent/tests/`) в этом репозитории пока нет, поэтому
 * порог мерялся на парах, списанных с разделов самой панели. Настоящие копии
 * («Вход с пустым паролем» против «Вход с пустым полем пароля», один и тот же
 * вход в двух группах) дали 0.61–0.88; соседние по теме, но разные кейсы
 * («Отправка сообщения» против «Остановка ответа», правила против хуков) —
 * 0.13–0.32. Между этими облаками и стоит 0.6: ниже начинаются ложные дубли на
 * общей лексике раздела, выше отваливается уже и честная пара из разных групп.
 *
 * Чего порог не ловит ни при каком значении: копию, ПЕРЕСКАЗАННУЮ другими
 * словами («Вход с пустым паролем» против «Авторизация без пароля запрещена» —
 * 0.13). Это цена отказа от эмбеддингов, и она принята осознанно.
 *
 * Появится живая библиотека — порог перемерить на ней; значение вынесено сюда
 * ровно для этого.
 */
export const SIMILAR_THRESHOLD = 0.6;

/** Сколько похожих показывать на кейс: список нужен человеку, а не полный граф. */
export const SIMILAR_LIMIT = 3;

/**
 * Сколько общих слов обязательно, чтобы пара вообще рассматривалась.
 *
 * Одно общее слово — совпадение, а не дубль, и опаснее всего это на коротких
 * кейсах: «Вход с %login» и «Вход с %user» после отсева параметров держат по
 * одному слову «вход», и мера Жаккара честно выдаёт на них единицу. Ложный
 * дубль дороже пропуска — человек перестаёт читать список после второго вранья.
 */
const MIN_SHARED = 2;

/** Настройка сравнения — общая для обоих входов модуля. */
export interface SimilarOptions {
  /** Порог похожести 0–1. */
  threshold?: number;
  /** Сколько похожих оставлять на кейс. */
  limit?: number;
}

/** Настройка поиска похожих на один кейс. */
export interface SimilarToOptions extends SimilarOptions {
  /**
   * Кейс библиотеки, который сравнивать не надо. По умолчанию — сам
   * проверяемый: правка существующего кейса иначе всегда находит себя на 100%.
   */
  excludeId?: string;
  /** Группа исключаемого кейса: идентификаторы уникальны только внутри группы. */
  excludeGroupId?: string;
}

/** Слова текста: нижний регистр, без пунктуации, без служебных и без `%параметров`. */
function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      // «ё» и «е» пишут вперемешку в одном и том же наборе, и без этой замены
      // «Всё меню» и «Все меню» оказывались разными словами.
      .replace(/ё/g, 'е')
      // Имя параметра — деталь оформления кейса: `%login` и `%user` в одном и
      // том же сценарии означают одно и то же место подстановки.
      .replace(/%[\p{L}_][\p{L}\p{N}_]*/gu, ' ')
      .split(/[^\p{L}\p{N}]+/u)
      // Однобуквенные остатки («в», «x») ничего не различают.
      .filter((word) => word.length > 1 && !STOPWORDS.has(word))
  );
}

/** Множество слов кейса: заголовок и шаги целиком (действие, данные, ожидание). */
export function caseTokens(testCase: ProjectTestCase): Set<string> {
  const parts = [testCase.title ?? '', ...(testCase.steps ?? []).map((step) => stepText(step))];
  return new Set(tokenize(parts.join(' ')));
}

/** Общие слова и мера Жаккара одной парой — счёт общих нужен и сам по себе. */
function compare(a: Set<string>, b: Set<string>): { shared: number; score: number } {
  if (a.size === 0 || b.size === 0) return { shared: 0, score: 0 };
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const word of small) {
    if (large.has(word)) shared += 1;
  }
  if (shared === 0) return { shared: 0, score: 0 };
  return { shared, score: shared / (a.size + b.size - shared) };
}

/** Мера Жаккара двух множеств слов: общее делить на объединение, 0–1. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  return round(compare(a, b).score);
}

/** Доля с двумя знаками: в приёмке она показывается процентом, «82%». */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Кейс библиотеки с уже посчитанными словами. */
interface IndexedCase {
  groupId: string;
  caseId: string;
  title: string;
  tokens: Set<string>;
}

/**
 * Разбор библиотеки в сравнимый вид ОДИН раз.
 *
 * Токенизация внутри двойного цикла — единственный способ уронить эту проверку
 * по времени: на пятистах кейсах она превратилась бы в четверть миллиона
 * разборов текста вместо пятисот.
 *
 * Архивные пропускаются: дубль убранного кейса — не дубль, а именно то, ради
 * чего архив и существует. Нечитаемая группа (`error`) тоже: её кейсов панель
 * не знает.
 */
function indexCases(groups: ProjectTestGroup[]): IndexedCase[] {
  const items: IndexedCase[] = [];
  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      if (testCase.archived) continue;
      items.push({
        groupId: group.id,
        caseId: testCase.id,
        title: testCase.title,
        tokens: caseTokens(testCase),
      });
    }
  }
  return items;
}

function toSimilar(item: IndexedCase, score: number): ProjectTestDraftSimilar {
  return { groupId: item.groupId, caseId: item.caseId, title: item.title, score: round(score) };
}

/** Лучшие похожие сверху, не больше `limit`. */
function best(found: ProjectTestDraftSimilar[], limit: number): ProjectTestDraftSimilar[] {
  return found
    .sort((a, b) => b.score - a.score || a.caseId.localeCompare(b.caseId))
    .slice(0, limit);
}

/**
 * Дубли внутри библиотеки: у каждого кейса — на что он похож.
 *
 * Сравниваются и кейсы РАЗНЫХ групп: набор растёт вширь именно так — «Вход»
 * заводят в `smoke`, потом ещё раз в `gui`, и обе группы по отдельности
 * выглядят чистыми. Пара считается один раз и раскладывается в обе стороны:
 * повторный подсчёт того же ничего не добавляет, а сам с собой кейс не
 * сравнивается никогда.
 */
export function similarCases(
  groups: ProjectTestGroup[],
  options: SimilarOptions = {},
): ProjectTestDuplicate[] {
  const threshold = options.threshold ?? SIMILAR_THRESHOLD;
  const limit = options.limit ?? SIMILAR_LIMIT;
  const items = indexCases(groups);
  const hits: ProjectTestDraftSimilar[][] = items.map(() => []);

  for (let i = 0; i < items.length; i += 1) {
    const left = items[i];
    if (!left) continue;
    for (let j = i + 1; j < items.length; j += 1) {
      const right = items[j];
      if (!right) continue;
      const { shared, score } = compare(left.tokens, right.tokens);
      if (shared < MIN_SHARED || score < threshold) continue;
      hits[i]?.push(toSimilar(right, score));
      hits[j]?.push(toSimilar(left, score));
    }
  }

  const duplicates: ProjectTestDuplicate[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const found = hits[i];
    if (!item || !found || found.length === 0) continue;
    duplicates.push({
      groupId: item.groupId,
      caseId: item.caseId,
      title: item.title,
      similar: best(found, limit),
    });
  }

  // Самые похожие пары — вверх: список читают сверху и до первой скучной строки.
  return duplicates.sort(
    (a, b) =>
      (b.similar[0]?.score ?? 0) - (a.similar[0]?.score ?? 0) ||
      a.groupId.localeCompare(b.groupId) ||
      a.caseId.localeCompare(b.caseId),
  );
}

/**
 * На что похож ОДИН кейс — строка «похоже на gui-014 (82%)» в приёмке черновика.
 *
 * Кейс сюда приходит предложенный, в библиотеке его ещё нет; при правке
 * существующего он в библиотеке есть, и его же надо исключить, иначе
 * единственным «похожим» окажется он сам.
 */
export function similarTo(
  testCase: ProjectTestCase,
  groups: ProjectTestGroup[],
  options: SimilarToOptions = {},
): ProjectTestDraftSimilar[] {
  const threshold = options.threshold ?? SIMILAR_THRESHOLD;
  const limit = options.limit ?? SIMILAR_LIMIT;
  const skipId = options.excludeId ?? testCase.id;
  const tokens = caseTokens(testCase);
  if (tokens.size === 0) return [];

  const found: ProjectTestDraftSimilar[] = [];
  for (const item of indexCases(groups)) {
    if (
      item.caseId === skipId &&
      (!options.excludeGroupId || item.groupId === options.excludeGroupId)
    )
      continue;
    const { shared, score } = compare(tokens, item.tokens);
    if (shared < MIN_SHARED || score < threshold) continue;
    found.push(toSimilar(item, score));
  }
  return best(found, limit);
}
