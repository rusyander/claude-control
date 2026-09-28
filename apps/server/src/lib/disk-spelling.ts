import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, parse, relative, sep } from 'node:path';

/**
 * Написание пути на диске — регистр, слэши, короткие имена 8.3, — но без
 * раскрытия ссылок: проект за junction/symlink или на `subst`-диске остаётся
 * по своему пути, иначе ключ реестров расходился с путём из реестра проектов.
 *
 * Одно написание на всех — реестр проектов, записи о папке e2e, реестры
 * прогонов: Windows открывает `C:\Users\RUSYAN~1` и `C:\Users\rusyander` как один
 * каталог, а ключи по «как ввели» у разных мест расходились.
 */
export function spelledOnDisk(resolved: string): string {
  let real: string;
  try {
    real = realpathSync.native(resolved);
  } catch {
    return resolved;
  }
  if (parse(real).root.toLowerCase() !== parse(resolved).root.toLowerCase()) return resolved;
  // Самая глубокая ссылка на пути: выше неё — написание её родителя, она сама —
  // имя из каталога, ниже — хвост настоящего пути той же длины. Раньше под
  // ссылкой путь возвращался как ввели, и `…\link` с `…\LINK` были двумя ключами.
  let link: string | undefined;
  for (let at = resolved; at !== dirname(at); at = dirname(at)) {
    try {
      if (lstatSync(at).isSymbolicLink()) {
        link = at;
        break;
      }
    } catch {
      return resolved;
    }
  }
  if (!link) return real;
  const tail = relative(link, resolved);
  const tailParts = tail ? real.split(sep).slice(-tail.split(sep).length) : [];
  return join(spelledOnDisk(dirname(link)), nameOnDisk(link), ...tailParts);
}

/** Имя последнего сегмента так, как его пишет каталог-родитель. */
function nameOnDisk(path: string): string {
  const name = basename(path);
  try {
    const names = readdirSync(dirname(path));
    return (
      names.find((item) => item === name) ??
      names.find((item) => item.toLowerCase() === name.toLowerCase()) ??
      name
    );
  } catch {
    return name;
  }
}
