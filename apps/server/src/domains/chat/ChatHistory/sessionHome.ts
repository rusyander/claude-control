import { layoutForCwd } from '../../project-git/copy-readiness.ts';

/**
 * Дом разговора: каталог, где его продолжать и за каким проектом он числится.
 *
 * Обычно это ПЕРВЫЙ `cwd` транскрипта — там сессия начата, а поздние строки
 * несут каталог оболочки агента (после `cd sub/dir` чат «уезжал» в подпапку).
 * Одно исключение — переезд в копию из карточки ворот ветки (Ф-6): панель
 * поднимает тот же разговор в git-копии того же репозитория, и с этого хода
 * его дом — копия. Без этого следующее сообщение человека уходило обратно в
 * основную копию, к тем же воротам, и ответ «завести копию» жил один ход.
 *
 * Переездом считается только последний `cwd` внутри СВЯЗАННОЙ копии
 * репозитория, к которому относится первый: подпапка или чужой каталог им не
 * являются. Домом становится корень копии, а не подпапка, куда агент мог
 * зайти в ней. Копию убрали — `.git` в её каталоге больше нет, раскладка
 * пуста, и разговор сам возвращается в основную копию.
 */
export function sessionHome(
  first: string | undefined,
  last: string | undefined,
): string | undefined {
  if (!first || !last || same(first, last)) return first;
  const { mainDir, copyDir } = layoutForCwd(last);
  if (!mainDir || !copyDir) return first;
  return within(first, mainDir) ? copyDir : first;
}

const norm = (path: string): string => path.split('\\').join('/').replace(/\/+$/, '').toLowerCase();

function same(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

function within(path: string, dir: string): boolean {
  const target = norm(path);
  const root = norm(dir);
  return target === root || target.startsWith(`${root}/`);
}
