import type {
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestTaxonomyMove,
  ProjectTestTaxonomyPlan,
} from '@agentdeck/contracts';

/**
 * Таксономия набора: куда переложить кейсы, чтобы дерево секций перестало врать.
 *
 * Библиотека растёт кусками — десяток кейсов завёл агент прогоном, пять дописал
 * человек, ещё двадцать приехали импортом из чужой TMS, — и половина оказывается
 * вообще без секции, а половина в секциях по одному кейсу. Дерево при этом есть,
 * но ориентироваться по нему нельзя.
 *
 * Правило предлагает ТОЛЬКО переносы (`section`), и никогда — правку содержимого
 * кейса: заголовков, шагов, ожиданий. Переложить кейс — обратимое действие, его
 * видно в git одной строкой; переписать формулировку значит потерять то, что
 * кто-то писал руками, и такой «уборкой» пользоваться уже нельзя.
 *
 * Переносить между ГРУППАМИ правило тоже не предлагает: группа — это отдельный
 * файл, и переезд между файлами меняет и владение, и историю кейса. Такое
 * решение принимает человек, а не эвристика по совпадению зоны.
 *
 * Улучшением считаются ровно два случая, оба проверяемые счётом:
 * 1) кейс без секции, чьи собратья по зоне, началу названия или коду уже лежат
 *    в одной и той же секции;
 * 2) секция из одного кейса, когда его собратья живут в другой, населённой.
 * Из этого следует главное свойство: на прибранном наборе правило возвращает
 * ноль переносов — и «применить» нечего нажать по второму разу.
 */

/**
 * Сколько кейсов должно уже лежать в секции, чтобы считать её домом признака.
 *
 * Один сосед — совпадение, а не закономерность: по нему набор растащило бы по
 * случайным секциям ровно там, где порядка ещё нет.
 */
const DEFAULT_MIN_CASES = 2;

export interface TaxonomySuggestOptions {
  /** Порог уверенности: сколько кейсов признака уже должно быть в секции. */
  minCases?: number;
}

/** По какому признаку кейс опознан: зона, начало названия, общий код. */
type FeatureKind = 'area' | 'prefix' | 'path';

/** Признак кейса и его человеческое имя для причины переноса. */
interface Feature {
  kind: FeatureKind;
  /** Ключ сравнения: регистр и лишние пробелы уже убраны. */
  key: string;
  label: string;
}

/** Найденный дом признака: секция и сколько кейсов в ней его подтверждают. */
interface Target extends Feature {
  section: string;
  count: number;
}

/** Признак → секция → сколько кейсов признака в ней лежит. */
type Counts = Map<string, Map<string, number>>;

const REASONS: Record<FeatureKind, (target: Target) => string> = {
  area: (target) =>
    `зона «${target.label}»: ${target.count} кейсов этой зоны уже в секции «${target.section}»`,
  prefix: (target) =>
    `общее начало названия «${target.label}»: ${target.count} таких кейсов уже в секции «${target.section}»`,
  path: (target) =>
    `общий код «${target.label}»: ${target.count} кейсов этого пути уже в секции «${target.section}»`,
};

/**
 * Начало названия до разделителя: «Чат: отправка» → «Чат».
 *
 * Разделитель обязан отделяться пробелом, иначе в префиксы попали бы адреса и
 * имена файлов из заголовка. Слишком короткое начало и начало без единой буквы
 * признаком не считаются: по «1 —» ничего не сгруппируешь.
 */
function titlePrefix(title: string): string | undefined {
  const match = title.trim().match(/^(.{3,40}?)\s*[:—–|/-]\s+/);
  const prefix = match?.[1]?.trim();
  if (!prefix || !/\p{L}/u.test(prefix)) return undefined;
  return prefix;
}

/**
 * Корни `codePaths`: путь до папки в posix-форме.
 *
 * У файла берётся его папка — кейсы одного экрана ссылаются на разные файлы
 * одной директории, и без этого шага общий код у них не нашёлся бы вовсе.
 */
function pathRoots(testCase: ProjectTestCase): string[] {
  const roots = new Set<string>();
  for (const raw of testCase.codePaths ?? []) {
    const clean = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim();
    if (!clean) continue;
    const parts = clean.split('/');
    const last = parts[parts.length - 1] ?? '';
    const root = last.includes('.') && parts.length > 1 ? parts.slice(0, -1).join('/') : clean;
    if (root) roots.add(root);
  }
  return [...roots];
}

/** Признаки кейса по убыванию доверия: зона сильнее названия, название — кода. */
function featuresOf(testCase: ProjectTestCase): Feature[] {
  const features: Feature[] = [];
  const area = testCase.area?.trim();
  if (area) features.push({ kind: 'area', key: `area:${area.toLowerCase()}`, label: area });
  const prefix = titlePrefix(testCase.title);
  if (prefix) {
    features.push({ kind: 'prefix', key: `prefix:${prefix.toLowerCase()}`, label: prefix });
  }
  for (const root of pathRoots(testCase)) {
    features.push({ kind: 'path', key: `path:${root.toLowerCase()}`, label: root });
  }
  return features;
}

/** Разложить уже расставленные кейсы по признакам: это и есть «как сейчас». */
function collect(cases: ProjectTestCase[]): { counts: Counts; sectionSize: Map<string, number> } {
  const counts: Counts = new Map();
  const sectionSize = new Map<string, number>();

  for (const testCase of cases) {
    const section = testCase.section?.trim();
    if (!section) continue;
    sectionSize.set(section, (sectionSize.get(section) ?? 0) + 1);
    for (const feature of featuresOf(testCase)) {
      const row = counts.get(feature.key) ?? new Map<string, number>();
      row.set(section, (row.get(section) ?? 0) + 1);
      counts.set(feature.key, row);
    }
  }
  return { counts, sectionSize };
}

/**
 * Секция, где признак живёт увереннее всего.
 *
 * Ничья не годится: если кейсы зоны поровну лежат в двух секциях, дома у неё
 * нет, и правило молчит — предложить наугад хуже, чем не предложить ничего.
 */
function dominant(
  counts: Counts,
  feature: Feature,
  min: number,
  exclude?: string,
): Target | undefined {
  const row = counts.get(feature.key);
  if (!row) return undefined;
  const rows = [...row.entries()]
    .filter(([section]) => section !== exclude)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  const top = rows[0];
  const second = rows[1];
  if (!top || top[1] < min) return undefined;
  if (second && second[1] === top[1]) return undefined;
  return { ...feature, section: top[0], count: top[1] };
}

/** Первый признак кейса, у которого дом нашёлся. */
function targetFor(
  counts: Counts,
  testCase: ProjectTestCase,
  min: number,
  exclude?: string,
): Target | undefined {
  for (const feature of featuresOf(testCase)) {
    const target = dominant(counts, feature, min, exclude);
    if (target) return target;
  }
  return undefined;
}

/** Переносы одной группы: кейсы без секции и секции из одного кейса. */
function movesForGroup(
  groupId: string,
  cases: ProjectTestCase[],
  min: number,
): ProjectTestTaxonomyMove[] {
  const { counts, sectionSize } = collect(cases);
  const moves: ProjectTestTaxonomyMove[] = [];

  for (const testCase of cases) {
    const section = testCase.section?.trim();

    if (!section) {
      const target = targetFor(counts, testCase, min);
      if (!target) continue;
      moves.push({
        groupId,
        caseIds: [testCase.id],
        section: target.section,
        reason: REASONS[target.kind](target),
      });
      continue;
    }

    // Секция из одного кейса — не секция, а строка в дереве. Собственный дом
    // кейса ищем БЕЗ неё, иначе она же и победила бы своим единственным кейсом.
    if ((sectionSize.get(section) ?? 0) !== 1) continue;
    const target = targetFor(counts, testCase, min, section);
    if (!target || target.section === section) continue;
    moves.push({
      groupId,
      caseIds: [testCase.id],
      section: target.section,
      reason: `в секции «${section}» остался один кейс; ${REASONS[target.kind](target)}`,
    });
  }
  return moves;
}

/**
 * Предложить разложение по секциям.
 *
 * Архивные кейсы не участвуют ни как переносимые, ни как голоса за секцию:
 * убранный кейс не должен решать, где лежат живые.
 *
 * Переносы с ОДИНАКОВОЙ причиной в одну секцию склеиваются в одну строку —
 * человек читает «перенести 6 кейсов зоны «чат» в «Чат/Отправка»», а не шесть
 * одинаковых предложений подряд.
 */
export function suggestTaxonomy(
  groups: ProjectTestGroup[],
  options: TaxonomySuggestOptions = {},
): ProjectTestTaxonomyPlan {
  const min = Math.max(options.minCases ?? DEFAULT_MIN_CASES, DEFAULT_MIN_CASES);
  const merged = new Map<string, ProjectTestTaxonomyMove>();
  let total = 0;

  for (const group of groups) {
    if (group.error) continue;
    const cases = group.cases.filter((testCase) => !testCase.archived);
    for (const move of movesForGroup(group.id, cases, min)) {
      const key = `${move.groupId}|${move.section}|${move.reason}`;
      const found = merged.get(key);
      if (found) found.caseIds.push(...move.caseIds);
      else merged.set(key, move);
      total += move.caseIds.length;
    }
  }

  return { moves: [...merged.values()], total };
}
