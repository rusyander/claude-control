/**
 * Какой изменённый файл — «исходник» для пробела покрытия (04:82): код, но не сам тест и не
 * документация. Тест покрывает себя сам; markdown и конфиги кейсом не покрываются.
 */
const CODE = /\.(m?[jt]sx?|c[jt]s|py|go|java|kt|kts|cs|rs|rb|php|swift|scala|vue|svelte)$/;
const TEST =
  /(^|\/)(__tests__|tests?|e2e)\/|[._-](test|spec)\.[^/]+$|_test\.go$|(^|\/)test_[^/]+\.py$/;

/** Код (тест тоже): его правка без единой проверки над ним итога не даёт. */
export function isCodePath(path: string): boolean {
  return CODE.test(path);
}

export function isCoverageSource(path: string): boolean {
  return isCodePath(path) && !TEST.test(path);
}
