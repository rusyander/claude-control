import { readUniversalSections } from '../sections.ts';
import type { Importer } from '../types.ts';

/**
 * Aider → канон.
 *
 * Инструкции у Aider — не файл и не каталог, а СПИСОК ССЫЛОК: ключ `read` в
 * `~/.aider.conf.yml`. Каждая ссылка едет своей записью с путём того файла, на
 * который она указывает; ссылка на несуществующий файл — пропуск с причиной, а
 * не пустая запись: паспорт описывает среду, а не намерения.
 */
export const importAiderEnvironment: Importer = (deps) => readUniversalSections(deps);
