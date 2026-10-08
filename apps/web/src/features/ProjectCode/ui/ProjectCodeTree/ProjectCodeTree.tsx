import type { ProjectCodeTreeProps } from './ProjectCodeTree.types';
import styles from './ProjectCodeTree.module.scss';
import { ProjectCodeBranch } from './ProjectCodeBranch/ProjectCodeBranch';

/**
 * Дерево файлов проекта — все файлы, а не только тронутые.
 *
 * Каждая ветка запрашивает своё содержимое сама и только когда её раскрыли:
 * целиком настоящий репозиторий не читается — это десятки тысяч записей ради
 * двух-трёх открытых папок. Поэтому ветка — отдельный компонент со своим
 * запросом, а не рекурсивный обход заранее загруженного дерева.
 *
 * Работа агента видна прямо здесь: у изменённого файла зелёное имя и счётчики
 * строк, у папки на пути к нему — зелёная точка. Иначе найти результат прогона
 * в дереве можно было бы только перебором папок.
 *
 * Список раскрытых папок хранится СНАРУЖИ, в состоянии окна: он переживает и
 * закрытие окна, и перезагрузку панели, потому что сохраняется у таба проекта.
 */
export function ProjectCodeTree(props: ProjectCodeTreeProps) {
  return (
    <div className={styles.tree} role="tree" aria-label="files">
      <ProjectCodeBranch {...props} dir="" depth={0} />
    </div>
  );
}
