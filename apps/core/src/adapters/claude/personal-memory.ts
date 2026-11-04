import { currentOs, homeDir, type OsKind } from '../../platform/os-kind.ts';
import { foldsCaseAt, pathFlavour, samePath } from '../../platform/paths.ts';
import { caselessGlob } from './copy-parity.ts';
import { claudeConfigDir } from './user-layer.ts';

/**
 * Личный `CLAUDE.md`, который CLI читает КАК ПРОЕКТНЫЙ, — исключение при снятом источнике `user`
 * (перенос `personalMemoryExcludes` панели в ядро, s10 p9: после переезда прогонов в ядро у
 * серверной функции не осталось вызова, и личные правила снова доходили до модели).
 *
 * ПОЧЕМУ `--setting-sources project,local` МАЛО. CLI ищет `CLAUDE.md` и `.claude/CLAUDE.md` вверх
 * от cwd, и у проекта под `~` файл `~/.claude/CLAUDE.md` приезжает правилами ПРОЕКТА `~`: источник
 * `user` снят, а личные правила в запросе (замер панели 17.09 на 2.1.263; живой красный ядра —
 * `claude.carry.live.integration.test.ts`, случай «under the home»). Снять весь `project` нельзя:
 * ушёл бы `CLAUDE.md` монорепозитория над проектом — правила задачи. Поэтому исключаются ровно
 * личные файлы — `claudeMdExcludes` в `--settings` ядра, он действует при любом `--setting-sources`.
 *
 * Все три имени инструкций (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`): с 2.1.277 CLI читает
 * `AGENTS.md` тем же поиском, лишнее исключение не стоит ничего. Прямые слэши на Windows — так
 * шаблоны читает CLI. На томе без регистра — ещё и шаблон `[cC]:/[uU]…`: CLI сравнивает с учётом
 * регистра, а написание пути (буква диска через `cmd.exe`, короткие имена) зависит от запуска;
 * буквальные написания (от дома и от cwd — предки перебираются в его написании) идут всегда.
 */

const INSTRUCTION_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'] as const;
const PROJECT_DIR = '.claude';

export function personalMemoryExcludes(
  pin: Record<string, string>,
  cwd: string,
  os: OsKind = currentOs(),
): string[] {
  const p = pathFlavour(os);
  const home = homeDir(pin, os);
  const configDir = claudeConfigDir(pin, os);
  const files = new Set<string>();
  const addNames = (dir: string): void => {
    for (const name of INSTRUCTION_NAMES) files.add(p.join(dir, name));
  };
  addNames(configDir);
  addNames(p.join(home, PROJECT_DIR));
  // Поиск вверх от cwd: дом (его `.claude/`) и каталог конфига — где бы на пути они ни встретились.
  let dir = p.normalize(cwd);
  for (;;) {
    if (samePath(dir, home, os) || samePath(p.join(dir, PROJECT_DIR), configDir, os)) {
      addNames(p.join(dir, PROJECT_DIR));
    }
    if (samePath(dir, configDir, os)) addNames(dir);
    const parent = p.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const literal = [...files].map((file) => (os === 'win32' ? file.replaceAll('\\', '/') : file));
  const out = new Set(literal);
  if (foldsCaseAt(undefined, os)) for (const file of literal) out.add(caselessGlob(file));
  return [...out];
}

/** Источники, при которых личный файл вернулся бы правилами проекта: `project` есть, `user` нет. */
export function dropsUserKeepsProject(sources: readonly string[] | undefined): boolean {
  return !!sources && sources.includes('project') && !sources.includes('user');
}
