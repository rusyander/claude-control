import { cmdMklink } from './links.ts';
import { resolveFrom } from './paths.ts';
import type { Word } from './shell-parse.ts';
import { DANGER, isAbsolute, type SegmentVerdict, type Walk } from './walk.ts';

/**
 * Суд `cmd /c mklink /J|/D <ссылка> <цель>` (D-7, 25.10): группа заводит точку
 * соединения в своей рабочей папке на `node_modules` своей же копии, чтобы
 * прогнать проверку во второй рабочей копии. Ссылка в копии (или во временном
 * каталоге) на каталог копии — своя работа. Ссылка или цель вне копии, путь не
 * раскрыть, относительный путь от угаданного корня оболочки (она могла уйти
 * соседним вызовом) — человеку. Пути ниже ссылки и дальше остаются чужими
 * (`LinkLedger`): удаление и `git clean -x` по ней — не уборка своего (D-5).
 * `undefined` — не такая строка `cmd`, судится, как раньше.
 */
export function mklinkVerdict(words: Word[], walk: Walk): SegmentVerdict | undefined {
  const made = cmdMklink(words.slice(1));
  if (!made) return undefined;
  const place = walk.place();
  const resolve = (word: Word): string | undefined => {
    const known = walk.expand(word);
    if (known.dynamic) return undefined;
    if (isAbsolute(known.text)) return resolveFrom('/', known.text);
    return place.cwd !== undefined && !place.guessed
      ? resolveFrom(place.cwd, known.text)
      : undefined;
  };
  const link = resolve(made.link);
  const target = resolve(made.target);
  const ownLink = link !== undefined && (walk.inCopy(link) || walk.inScratch(link));
  return ownLink && target !== undefined && walk.inCopy(target)
    ? { kind: 'routine', writes: true }
    : DANGER;
}
