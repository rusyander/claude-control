/**
 * Сравнение находок групп по тексту — без модели (владелец 24.10.2026, ревизия 3).
 *
 * Группы пишут один дефект разными словами: «Go tests fail on Windows» и
 * «Windows: go tests failing» — одно и то же. Слова приводятся к грубой основе
 * (регистр, знаки, английские окончания, первые пять букв), и близость — доля
 * общих основ (Жаккар). Порог высокий нарочно: склеить два разных дефекта хуже,
 * чем оставить повтор, — повтор человек увидит в окне, слитый дефект пропадёт.
 */

/** Слова без смысла для сравнения: служебные, на обоих языках интерфейса. */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'not',
  'are',
  'was',
  'when',
  'from',
  'that',
  'this',
  'into',
  'does',
  'при',
  'для',
  'что',
  'это',
  'как',
  'или',
  'нет',
  'без',
  'над',
  'под',
  'если',
  'после',
  'перед',
  'когда',
]);

/** Название без регистра, знаков и лишних пробелов: «Падает экспорт.» = «падает  экспорт». */
export function normTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Грубая основа слова: английские окончания долой, дальше первые пять букв. */
function stem(word: string): string {
  let base = word;
  if (/^[a-z]+$/.test(base) && base.length > 4) {
    base = base
      .replace(/ies$/, 'y')
      .replace(/(ing|ed)$/, '')
      .replace(/(ss|x|ch|sh)es$/, '$1')
      .replace(/([^s])s$/, '$1');
  }
  return base.slice(0, 5);
}

/** Основы значимых слов названия: короче трёх букв и служебные не считаются. */
export function titleTokens(value: string): Set<string> {
  return new Set(
    normTitle(value)
      .split(' ')
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
      .map(stem),
  );
}

/** Сколько основ общих и какая это доля всех основ обоих названий. */
export function titleOverlap(a: string, b: string): { shared: number; ratio: number } {
  const [left, right] = [titleTokens(a), titleTokens(b)];
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return { shared, ratio: union === 0 ? 0 : shared / union };
}

/** Порог «то же другими словами» — для названий без общего места. */
export const NEAR_DUPLICATE_RATIO = 0.7;
/** Порог для находок в одном файле: общее место — уже половина довода. */
export const SAME_FILE_RATIO = 0.6;

/** Два названия — один дефект: хотя бы две общие основы и доля не ниже порога. */
export function nearDuplicate(a: string, b: string, ratio = NEAR_DUPLICATE_RATIO): boolean {
  const overlap = titleOverlap(a, b);
  return overlap.shared >= 2 && overlap.ratio >= ratio;
}

/**
 * Файлы, которые называет «где»: всё похожее на путь с расширением, без
 * `:строка` и `:строка:столбец`, слэши прямые, регистр нижний. «web» или
 * «экран настроек» файлов не называют — такая находка ни с кем по файлу не склеится.
 */
export function whereFiles(where: string): string[] {
  const found = where.match(/[\p{L}\p{N}_.\-/\\]+\.[A-Za-z][A-Za-z0-9]{0,7}/gu) ?? [];
  return [
    ...new Set(
      found
        .map((path) => path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase())
        .filter((path) => /[a-z]/.test(path.split('.').pop() ?? '') && path.length >= 4),
    ),
  ];
}
