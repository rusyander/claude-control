import { homedir } from 'node:os';
import { canonical, msysThrough, real, realBelow, resolveFrom, within } from './paths.ts';
import type { Redirect, Word } from './shell-parse.ts';
import { segmentMatches } from './glob.ts';
import { targetKind } from './targets.ts';
import { DANGER, isAbsolute, type SegmentVerdict, type Walk } from './walk.ts';

/**
 * Запись, которая портит данные вне своей копии и которую git ни одной копии
 * не вернёт — человеку, как удаление (ревью 23.10, зона A):
 * - `config` — настройки дома и система: сам дом, `~/.bashrc`, `~/.ssh/…`,
 *   `~/AppData/…` (кроме временного), `/etc`, `C:/Windows`. Сюда и запись,
 *   и перезапись (`echo x > ~/.bashrc`, `cp x ~/.ssh/config`);
 * - `home` — прочее в доме (`~/Desktop`, `~/projects/y`): портит только то,
 *   что уничтожает или уносит данные (`truncate`, `dd of=`, перенос, `rsync
 *   --delete`, `chmod -R`); положить файл на рабочий стол — обычная работа;
 * - `append` — дозапись (`>>`, `tee -a`): ничего не стирает, но в файлы
 *   запуска (`~/.bashrc`, `~/.ssh/…`, `~/.gitconfig`, `~/.npmrc`) и в каталоги
 *   системы она добавит код, который исполнится позже, — тоже человеку.
 * Запись в копию, во временное и в соседние репозитории (`elsewhere`) — как
 * раньше: рутина или правила чата.
 */
export type WriteKind = 'temp' | 'inside' | 'config' | 'home' | 'elsewhere' | 'unknown';
type Level = 'config' | 'home' | 'append';

/** Домашний каталог в начале слова: `~`, `$HOME`, `${USERPROFILE}`, `%USERPROFILE%`. */
const HOME_PREFIX =
  /^(?:~|\$HOME|\$\{HOME\}|\$USERPROFILE|\$\{USERPROFILE\}|%USERPROFILE%)(?=[\\/]|$)/i;

/** Путь с подставленным домом; `undefined` — что за путь, не узнать. */
function resolvedWord(word: Word, walk: Walk): Word | undefined {
  const expanded = walk.expand(word);
  if (!expanded.dynamic) return expanded;
  if (expanded.literalDollar) return undefined;
  const home = HOME_PREFIX.exec(expanded.text);
  // `HOME=… ; > $HOME/x` — переназначенный дом уже не дом.
  if (!home || walk.shadows('HOME') || walk.shadows('USERPROFILE')) return undefined;
  const rest = expanded.text.slice(home[0].length);
  if (/[$`%]/.test(rest)) return undefined;
  return { text: `${canonical(homedir())}${rest.replace(/\\/g, '/')}`, dynamic: false };
}

/**
 * Каталоги системы: перезапись там ломает машину, а не проект. Разделы
 * Windows — в виде `canonical` (`c:/windows`).
 */
const SYSTEM =
  /^(\/(etc|usr|bin|sbin|boot|lib\d*|opt|System|Library)(\/|$)|\/var\/(?!tmp(\/|$))|[a-z]:\/(windows|program files[^/]*|programdata)(\/|$))/i;

function area(path: string): WriteKind {
  if (SYSTEM.test(path)) return 'config';
  const home = canonical(homedir());
  if (!within(path, home)) return 'elsewhere';
  const rel = path.slice(home.length + 1);
  // Временный каталог Windows лежит в доме: `~/AppData/Local/Temp/mr938/x`.
  if (/^appdata\/local\/temp(\/|$)/i.test(rel)) return 'elsewhere';
  const first = rel.split('/')[0] ?? '';
  return first === '' || first.startsWith('.') || /^appdata$/i.test(first) ? 'config' : 'home';
}

/**
 * Файлы, дописанное в которые исполнится или пустит на машину: настройки
 * оболочки при входе, ключи `ssh`, настройки git. Дописать в прочее (`>>
 * ~/.claude/…/MEMORY.md`) ничего не уничтожает — правила чата, как раньше.
 */
const STARTUP =
  /\/(\.(bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|kshrc|cshrc|tcshrc|inputrc|gitconfig|npmrc)|\.ssh\/.*|\.config\/(fish|autostart|systemd)\/.*)$/i;

/**
 * Хранилище git — настройки, крючки, ссылки (RF-BGCD, класс «куда уйдёт пуш»,
 * 24.10): `remote.origin.pushurl`, дописанный в `.git/config` основной копии
 * мимо `git config`, увёл бы следующий пуш в чужой репозиторий, а крючок в
 * `.git/hooks` исполнился бы у владельца. Любая запись туда — человеку:
 * сегмент `.git` (без регистра, шаблоном, короткое имя `GIT~1`), путь
 * хранилища от самого git (`$(git rev-parse --git-common-dir)`, `--git-path`),
 * значение настроек (`$(git config …)`, `$(git var …)` — любое), `$GIT_DIR`.
 * Списки файлов дерева (`$(git diff --name-only)`, `ls-files`) хранилища не
 * называют никогда — это работа (корпус 24.10: 9 ложных карточек).
 */
function namesGitStorage(text: string, walk: Walk, shell = false): boolean {
  const segments = text.toLowerCase().split(/[\\/]+/);
  if (
    segments.some((part) => /^git~\d+$/.test(part) || segmentMatches(part, '.git', walk.dotglob))
  ) {
    return true;
  }
  // Подстановки раскроет только оболочка: в коде `perl -e` обратные кавычки — его.
  if (!shell) return false;
  if (/\$\{?GIT_(DIR|COMMON_DIR)\b|%GIT_(DIR|COMMON_DIR)%/i.test(text)) return true;
  for (const match of text.matchAll(GIT_SUBSTITUTION)) {
    if (GIT_STORAGE_CALL.test(match[1] ?? match[2] ?? '')) return true;
  }
  return false;
}

/**
 * Текст PowerShell называет хранилище git (RF-BGCD, раунд 8, 24.10): любой
 * командлет и псевдоним (`Set-Content`, `sc`, `ni`, `copy`), `>`/`>>`,
 * `[IO.File]::…`, `StreamWriter` — таблицы писателей нет, решает само имя:
 * слово-путь с сегментом `.git` (или его настоящий путь), `(git rev-parse
 * --git-common-dir)` и `$(…)`, `$env:GIT_DIR`. Чтение `.git/config` тоже
 * уходит человеку — что командлет сделает с путём, не разбираем.
 */
export function powershellNamesStorage(text: string, walk: Walk): boolean {
  if (namesGitStorage(text, walk, true) || /\$env:GIT_(DIR|COMMON_DIR)\b/i.test(text)) return true;
  for (const match of text.matchAll(PS_GIT_CALL)) {
    if (GIT_STORAGE_CALL.test(match[1] ?? '')) return true;
  }
  const cwd = walk.place().cwd;
  return text
    .split(PS_SEPARATORS)
    .map((token) => token.replace(/^-\w+:/, ''))
    .filter((token) => token.length > 0)
    .some((token) => {
      if (namesGitStorage(token, walk)) return true;
      if (!cwd || !/[\\/]/.test(token) || /[$*?]/.test(token)) return false;
      const below = realBelow(resolveFrom(cwd, token.replace(/\\/g, '/')));
      return below !== undefined && namesGitStorage(below, walk);
    });
}

/** `(git …)`, `(& git …)`, `$(git …)` PowerShell — содержимое вызова. */
const PS_GIT_CALL = /\(\s*(?:&\s*)?git(?:\.exe)?\b([^)]*)\)/gi;
/** Где кончается слово-путь в тексте PowerShell. */
const PS_SEPARATORS = /[\s'"`(),;|&{}=<>+[\]]+/;

/** `$(git …)` и `` `git …` `` — содержимое вызова без самого `git`. */
const GIT_SUBSTITUTION =
  /\$\(\s*(?:command\s+)?\\?git(?:\.exe)?\b([^)]*)\)|`\s*(?:command\s+)?\\?git(?:\.exe)?\b([^`]*)`/gi;
/** Вызов git, что выдаёт путь хранилища или значение настроек. */
const GIT_STORAGE_CALL =
  /--(git-dir|git-common-dir|git-path|absolute-git-dir|resolve-git-dir|local-env-vars)\b|^\s*(-c\s+\S+\s+|-C\s+\S+\s+)*(config|var)\b/;

/**
 * Путь записи и его место; `path` — только для пути вне копии и временного.
 * `through` — путь идёт сквозь ссылку этой команды или распакованный ею архив
 * (RF-BGCD-04): куда ляжет запись, не узнать — как в настройки дома.
 */
function located(word: Word, walk: Walk): { kind: WriteKind; path?: string; through?: boolean } {
  const shown = walk.expand(word);
  if (
    namesGitStorage(word.text, walk, word.dynamic) ||
    namesGitStorage(shown.text, walk, shown.dynamic)
  ) {
    return { kind: 'config', through: true };
  }
  const place = { ...walk.place(), write: true };
  if (targetKind(word, walk, place) === 'temp') return { kind: 'temp' };
  const resolved = resolvedWord(word, walk);
  if (!resolved) return { kind: 'unknown' };
  if (targetKind(resolved, walk, place) === 'temp') return { kind: 'temp' };
  const cwd = place.cwd ?? (isAbsolute(resolved.text) ? '/' : undefined);
  if (!cwd) return { kind: 'unknown' };
  const path = resolveFrom(cwd, resolved.text);
  const realPath = real(path);
  // Существующая ссылка или короткое имя (`SHOP~1/.git`) — по настоящему пути
  // ближайшего существующего предка: цели записи на диске ещё может не быть.
  const below = realBelow(path);
  const storage = below !== undefined && namesGitStorage(below, walk);
  if (storage || walk.links.crosses(path, true) || msysThrough(path)) {
    return { kind: 'config', path, through: true };
  }
  if (walk.rootOf(path)) return { kind: 'inside' };
  const kinds = [path, realPath].filter((entry): entry is string => Boolean(entry)).map(area);
  if (kinds.includes('config')) return { kind: 'config', path };
  return { kind: kinds.includes('home') ? 'home' : 'elsewhere', path };
}

export function writeKind(word: Word, walk: Walk): WriteKind {
  return located(word, walk).kind;
}

/**
 * Правка на месте (`sed -i`, `perl -pi`) обычно судится не местом (политика
 * владельца 19.10), но в хранилище git или сквозь ссылку этой команды она
 * уводит пуш и ставит крючки — человеку, как запись.
 */
export function editLandsUnseen(word: Word, walk: Walk): boolean {
  return located(word, walk).through === true;
}

/** Потоки и «никуда»: `>/dev/null`, `2>NUL`, `>/dev/tty`; `/dev/sda` сюда не входит. */
const QUIET = /^(\/dev\/(null|stdout|stderr|tty|fd\/\d+)|nul)$/i;

/**
 * Запись по пути портит невозвратное: `config` — перезапись настроек и
 * системы, `home` — уничтожение чего угодно в доме, `append` — дописывание в
 * то, что исполнится при входе или пустит на машину.
 */
export function spoils(word: Word | undefined, walk: Walk, level: Level): boolean {
  if (word === undefined || (!word.dynamic && QUIET.test(word.text))) return false;
  const { kind, path = '', through = false } = located(word, walk);
  if (level === 'append') {
    return kind === 'config' && (through || STARTUP.test(path) || SYSTEM.test(path));
  }
  return kind === 'config' || (level === 'home' && kind === 'home');
}

/** Перенаправление в настройки дома или системы: `> ~/.bashrc`, `>> ~/.profile`. */
export function redirectOutside(redirect: Redirect, walk: Walk): boolean {
  if (redirect.op === '<' || redirect.op === '<&' || redirect.op === '>&') return false;
  return spoils(redirect.target, walk, redirect.op === '>>' ? 'append' : 'config');
}

/** Слова без ключей; `valued` — ключи со значением отдельным словом. */
function operands(args: Word[], valued: RegExp = /^$/): Word[] {
  const found: Word[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    if (ended || !arg.text.startsWith('-') || arg.text === '-') found.push(arg);
    else if (arg.text === '--') ended = true;
    else if (valued.test(arg.text)) i += 1;
  }
  return found;
}

const flag = (args: Word[], pattern: RegExp): boolean => args.some((arg) => pattern.test(arg.text));

interface Written {
  path: Word;
  level: Level;
}

const at = (level: Level, paths: (Word | undefined)[]): Written[] =>
  paths.filter((path): path is Word => path !== undefined).map((path) => ({ path, level }));

/** Цель `cp`/`install`/`mv`: `-t каталог` или последнее слово. */
function destination(args: Word[], valued: RegExp): Word | undefined {
  const target = args.find((_arg, i) => /^(-t|--target-directory)$/.test(args[i - 1]?.text ?? ''));
  return target ?? operands(args, valued).at(-1);
}

/**
 * Куда скачивание кладёт файл (R-C05, ревью корпуса 23.10: `curl -o ~/.bashrc`
 * проходил сам): `curl -o/--output/--output-dir`, склейка `-sSLo x`, `wget
 * -O/-P` и их длинные формы, `Invoke-WebRequest -OutFile`.
 */
function downloadTargets(name: string, args: Word[]): Word[] {
  const found: Word[] = [];
  const value = (arg: Word, text: string): Word => ({ ...arg, text });
  const long =
    name === 'curl'
      ? /^--(output|output-dir)(=|$)/
      : name === 'wget'
        ? /^--(output-document|directory-prefix)(=|$)/
        : /^-outfile(:|$)/i;
  const short =
    name === 'curl' ? /^-[a-zA-Z]*o(.*)$/ : name === 'wget' ? /^-[a-zA-Z]*[OP](.*)$/ : /^$/;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    const text = arg.text;
    const longMatch = long.exec(text);
    if (longMatch) {
      const inline = text.slice(longMatch[0].length);
      if (longMatch[2] === '=' || longMatch[2] === ':' || longMatch[1] === ':') {
        found.push(value(arg, inline));
      } else if (args[i + 1]) found.push(args[(i += 1)] as Word);
      continue;
    }
    if (text.startsWith('--')) continue;
    const shortMatch = short.exec(text);
    if (!shortMatch) continue;
    const inline = shortMatch[1] ?? '';
    if (inline) found.push(value(arg, inline));
    else if (args[i + 1]) found.push(args[(i += 1)] as Word);
  }
  return found.filter((word) => word.text !== '-');
}

const DOWNLOADERS = new Set([
  'curl',
  'wget',
  'iwr',
  'invoke-webrequest',
  'irm',
  'invoke-restmethod',
]);

/** Пишущие команды, чьи цели судит `writesVerdict`: за обёрткой (`sudo tee`) они тоже звено. */
export function isWriter(name: string): boolean {
  return DOWNLOADERS.has(name) || writtenPaths(name, []) !== undefined;
}

/** Что команда перезапишет или унесёт; `undefined` — не пишущая команда. */
function writtenPaths(name: string, args: Word[]): Written[] | undefined {
  if (DOWNLOADERS.has(name)) return at('config', downloadTargets(name, args));
  switch (name) {
    case 'cp':
    case 'install':
      return at('config', [destination(args, /^(-t|-S|--suffix|-m|-o|-g)$/)]);
    case 'mv': {
      // Перенос уносит источник: `mv ~/x .agent/tmp/` — дома его больше нет.
      const valued = /^(-t|-S|--suffix)$/;
      const target = destination(args, valued);
      const sources = operands(args, valued).filter((word) => word !== target);
      return [...at('home', sources), ...at('config', [target])];
    }
    case 'ln':
      return flag(args, /^(-[a-zA-Z]*f|--force)$/)
        ? at('config', operands(args, /^(-t|-S)$/).slice(-1))
        : [];
    case 'rsync': {
      const target = operands(args, /^(-e|--rsh|--exclude|--include|--filter|-f)$/).at(-1);
      return at(flag(args, /^--(delete|remove-source-files)/) ? 'home' : 'config', [target]);
    }
    case 'tee':
      return at(flag(args, /^(-[a-zA-Z]*a|--append)$/) ? 'append' : 'config', operands(args));
    case 'truncate':
      return at('home', operands(args, /^(-s|-r|--size|--reference)$/));
    case 'dd':
      return at(
        'home',
        args
          .filter((arg) => arg.text.startsWith('of='))
          .map((arg) => ({ ...arg, text: arg.text.slice(3) })),
      );
    case 'chmod':
    case 'chown':
    case 'chgrp':
      // Права одного файла дома — обычная работа; рекурсивно — уже чужое дерево.
      return flag(args, /^(-[a-zA-Z]*R|--recursive)$/)
        ? at('home', operands(args).slice(1))
        : at('config', operands(args).slice(1));
    default:
      return undefined;
  }
}

/** Запись, которую git не вернёт, — человеку; иначе `undefined`: решает остальной суд. */
export function writesVerdict(words: Word[], walk: Walk): SegmentVerdict | undefined {
  const name = (words[0]?.text ?? '').toLowerCase().replace(/\.exe$/, '');
  const written = writtenPaths(name, words.slice(1));
  if (!written) return undefined;
  return written.some(({ path, level }) => spoils(path, walk, level)) ? DANGER : undefined;
}
