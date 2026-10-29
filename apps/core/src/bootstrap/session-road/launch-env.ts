import { pathListSeparator } from '../../platform/os-kind.ts';
import { readLoginShellPath, type LoginPath } from '../../platform/shell-path.ts';

/**
 * PATH оболочки входа для окружения CLI (03 §Launcher, P104): ядро, запущенное автозапуском
 * (systemd, launchd), видит урезанный PATH, а человек ставил CLI и его инструменты в каталоги,
 * которые открывает только `~/.profile` / `~/.zprofile`. Читается один раз на загрузку ядра —
 * оболочка входа медленная, а её PATH за время жизни ядра не меняется. Запасной путь (таймаут,
 * нет меток) не глотается: причина — в журнале ядра и в исходе подготовки сессии.
 */

export type LoginPathReader = () => Promise<LoginPath>;

export function memoLoginPath(
  read: LoginPathReader = () => readLoginShellPath(),
  note: (event: string, data: Record<string, unknown>) => void = () => {},
): LoginPathReader {
  let once: Promise<LoginPath> | undefined;
  return () => {
    once ??= read().then((got) => {
      note('login-path', {
        source: got.source,
        ...(got.reason ? { reason: got.reason } : {}),
      });
      return got;
    });
    return once;
  };
}

/** PATH сессии: обёртки ядра первыми, затем каталоги вызывающего, затем путь входа. */
export function sessionPath(
  wrapperDir: string,
  prefix: readonly string[],
  login: LoginPath,
): string {
  const separator = pathListSeparator();
  const dirs = [wrapperDir, ...prefix, ...login.path.split(separator)].filter((d) => d !== '');
  return [...new Set(dirs)].join(separator);
}
