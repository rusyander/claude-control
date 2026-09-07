import type { ProjectTestGroup, ProjectTestImpact } from '@agentdeck/contracts';
import { gitSync } from '../project-git/exec.ts';

/**
 * Отбор по диффу: какие кейсы задеты тем, что сейчас лежит в рабочей копии.
 *
 * Это то, чего в TMS не бывает: панель видит и кейсы, и изменения кода рядом.
 * Полный регресс сотни GUI-кейсов агентом стоит часы и заметный расход окна, а
 * после правки одной страницы проверять нужно десяток кейсов. Связь строится по
 * `codePaths` кейса (что он трогает), а если их не проставили — по совпадению
 * зоны (`area`) с путём файла, чтобы отбор работал и на старых кейсах.
 *
 * Гадать здесь нельзя: если изменений нет или каталог не репозиторий, честнее
 * вернуть пустой список, чем «на всякий случай» весь набор — иначе «прогнать
 * задетое» молча превратится в «прогнать всё».
 */

/** Ветка и коммит рабочей копии — контекст любого прогона. */
export function gitContext(root: string): { branch?: string; commit?: string } {
  const branch = gitSync(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  const commit = gitSync(root, ['rev-parse', '--short', 'HEAD'])?.trim();
  return { branch: branch || undefined, commit: commit || undefined };
}

/**
 * Изменённые файлы рабочей копии в posix-форме.
 *
 * `--porcelain` даёт и индекс, и рабочее дерево одной командой; переименование
 * приходит как `R  было -> стало`, и интересен здесь второй путь.
 *
 * `-uall` обязателен: без него git сворачивает новую папку в одну строку `src/`,
 * и целиком новая страница не пересеклась бы ни с одним `codePaths` — отбор
 * молча возвращал бы пусто там, где изменений как раз больше всего.
 */
export function changedFiles(root: string): string[] {
  const output = gitSync(root, ['status', '--porcelain', '-uall']);
  if (!output) return [];
  const files: string[] = [];
  for (const line of output.split('\n')) {
    const path = line.slice(3).trim();
    if (!path) continue;
    const arrow = path.lastIndexOf(' -> ');
    const clean = (arrow >= 0 ? path.slice(arrow + 4) : path).replace(/^"|"$/g, '');
    if (clean) files.push(clean.replace(/\\/g, '/'));
  }
  return [...new Set(files)];
}

/** Слова файла: имя без расширения и папки пути — по ним ищут зону. */
function wordsOf(file: string): string[] {
  return file
    .toLowerCase()
    .split(/[/\\.]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 2);
}

/** Кейсы, задетые изменениями рабочей копии. */
export function impactOf(root: string, groups: ProjectTestGroup[]): ProjectTestImpact {
  const files = changedFiles(root).filter((file) => !file.startsWith('.agent/tests/'));
  const cases: ProjectTestImpact['cases'] = [];
  if (files.length === 0) return { files, cases };

  const words = new Set(files.flatMap((file) => wordsOf(file)));

  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      if (testCase.archived) continue;

      const byPath = (testCase.codePaths ?? []).find((path) => {
        const needle = path.replace(/\\/g, '/').replace(/^\.\//, '');
        return files.some((file) => file === needle || file.startsWith(`${needle}/`));
      });
      if (byPath) {
        cases.push({
          groupId: group.id,
          caseId: testCase.id,
          title: testCase.title,
          reason: `изменён ${byPath}`,
        });
        continue;
      }

      // Запасной путь для кейсов без `codePaths`: зона кейса встретилась в
      // пути файла. Слабее прямой привязки, поэтому и причина пишется иначе —
      // человек должен видеть, на чём основан отбор.
      const area = testCase.area?.toLowerCase().trim();
      if (area && words.has(area)) {
        cases.push({
          groupId: group.id,
          caseId: testCase.id,
          title: testCase.title,
          reason: `зона «${testCase.area}» в изменённых файлах`,
        });
      }
    }
  }
  return { files, cases };
}
