import type { OsKind } from './os-kind.ts';

/**
 * Инструменты, что лежат в самом репозитории, по ОС (P51: имена файлов Windows знает только
 * platform/): обёртки сборщиков JVM и каталог исполняемых файлов venv. `gradlew` и `mvnw` —
 * sh-скрипты; на Windows их запускает только пара `gradlew.bat` / `mvnw.cmd`.
 */
export type BuildWrapperTool = 'gradle' | 'mvn';

const WRAPPERS: Record<BuildWrapperTool, { posix: string; win: string }> = {
  gradle: { posix: 'gradlew', win: 'gradlew.bat' },
  mvn: { posix: 'mvnw', win: 'mvnw.cmd' },
};

/** Все файлы обёрток обеих ОС: их правка меняет то, чем собирается проект. */
export const BUILD_WRAPPER_FILES: readonly string[] = Object.values(WRAPPERS).flatMap((w) => [
  w.posix,
  w.win,
]);

/**
 * Файл обёртки, который запускается на этой ОС, и команда его запуска из корня проекта. Команда —
 * путь (`./…`) на обеих ОС: голое `gradlew.bat` искалось бы в PATH и нашло бы чужую обёртку или
 * ничего; путь раннер разрешает от каталога проверки.
 */
export function buildWrapperFor(
  tool: BuildWrapperTool,
  os: OsKind,
): { file: string; command: string } {
  const w = WRAPPERS[tool];
  const file = os === 'win32' ? w.win : w.posix;
  return { file, command: `./${file}` };
}

/** Каталог исполняемых файлов venv проекта (09): `Scripts` на Windows, `bin` на POSIX. */
export function venvBinDir(os: OsKind): string {
  return os === 'win32' ? '.venv/Scripts' : '.venv/bin';
}

/** Интерпретатор venv копии — путь от корня стека (запуск разрешает его от cwd шага). */
export function venvPython(os: OsKind): string {
  return os === 'win32' ? `${venvBinDir(os)}/python.exe` : `${venvBinDir(os)}/python`;
}

/** Имя команды без суффикса исполняемого файла Windows: `gradlew.bat` ≡ `gradlew` при сопоставлении. */
export function commandStem(name: string): string {
  return name.replace(/\.(bat|cmd|exe)$/i, '');
}
