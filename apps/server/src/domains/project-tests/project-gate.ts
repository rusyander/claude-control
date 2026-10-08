import { basename, dirname, join, relative, resolve } from 'node:path';
import { matchesProject } from '../group-activation/group-activation.ts';
import { gitSync } from '../project-git/exec/exec.ts';
import { spelledOnDisk } from '../../lib/disk-spelling/disk-spelling.ts';
import { coded } from '../../lib/server-text/server-text.ts';
import { ProjectTestsError } from './files.ts';

/**
 * Где панель вправе завести папку e2e и запустить команду автотестов.
 *
 * Смотреть кейсы можно в любом каталоге — раздел открывают и на папке чата,
 * которой нет в реестре. Но «Завести папку» пишет в чужое дерево, а «Прогнать
 * автотесты» исполняет его команду (`npx playwright`, `automation.json`), и по
 * одному пути из запроса это делалось в ЛЮБОМ существующем каталоге. Граница —
 * проекты, которые человек сам добавил в панель, каталоги внутри них и копии их
 * веток: копия — тот же проект на другой ветке.
 *
 * Копия узнаётся двумя путями. Панельная лежит рядом, в `<проект>-worktrees/…`
 * (то же правило, что у привязки групп, — без запуска git). Заведённую руками
 * где угодно выдаёт сам git: общий каталог `.git` у неё — репозитория из
 * реестра. git спрашивается только у каталога, не узнанного по пути, — на
 * обычном запросе своего проекта процесса нет.
 */
export function isProjectOrCopy(dir: string, projectPaths: readonly string[]): boolean {
  // Сверка идёт по строке пути: `<проект>\..\чужой` начинался с пути проекта, а
  // ОС открывала по нему соседний каталог. Путь с «..» — отказ, а не догадка,
  // куда он ведёт: на POSIX `ссылка/..` ведёт к родителю цели, не ссылки.
  if (dir.split(/[\\/]/).includes('..')) return false;
  // Обе стороны — в написании диска: запись реестра в коротком имени 8.3
  // (`RUSYAN~1`) и запрос в длинном — один каталог, а не отказ своему проекту.
  const target = spelledOnDisk(resolve(dir));
  const projects = projectPaths.map((project) => spelledOnDisk(resolve(project)));
  if (projects.some((project) => matchesProject(project, target))) return true;
  const origin = mainCheckoutOf(target);
  return origin !== undefined && projects.some((project) => matchesProject(project, origin));
}

/**
 * Тот же каталог в основной копии репозитория: `<копия>/apps/web` →
 * `<основная>/apps/web`. Не под git, голый репозиторий или git не ответил —
 * `undefined`: отказ честнее догадки.
 */
function mainCheckoutOf(dir: string): string | undefined {
  const top = gitSync(dir, ['rev-parse', '--show-toplevel'])?.trim();
  const common = gitSync(dir, ['rev-parse', '--git-common-dir'])?.trim();
  if (!top || !common) return undefined;
  // Относительный ответ git даёт от каталога запроса; у копии — абсолютный.
  const commonDir = resolve(dir, common);
  if (basename(commonDir).toLowerCase() !== '.git') return undefined;
  return join(dirname(commonDir), relative(resolve(top), resolve(dir)));
}

/** Отказ «не проект панели»: 403 с кодом, клиент переводит его своим словарём. */
export function assertProjectOrCopy(dir: string, projectPaths: readonly string[]): void {
  if (isProjectOrCopy(dir, projectPaths)) return;
  throw coded(
    Object.assign(
      new ProjectTestsError(
        'Папку e2e и автотесты панель заводит только у проектов из раздела «Проекты» и копий их веток. Добавьте этот каталог проектом.',
      ),
      { statusCode: 403 },
    ),
    'e2e-project-unregistered',
  );
}
