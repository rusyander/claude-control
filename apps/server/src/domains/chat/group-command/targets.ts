import { DEFAULT_INCLUDE, listed } from '../../project-git/mirror-local.ts';
import { GLOB, segmentMatches } from './glob.ts';
import {
  escapesBase,
  isTempInside,
  isTempName,
  isTempOutside,
  leavesTemp,
  msysLink,
  real,
  resolveFrom,
  scratchpadRoot,
  tempVariable,
  within,
} from './paths.ts';
import type { Word } from './shell-parse.ts';
import { DANGER, ROUTINE, isAbsolute, type SegmentVerdict, type Walk } from './walk.ts';

/**
 * Что пропадёт при удалении или перезаписи пути (политика владельца 19.10 и
 * 23.10: «все безопасные команды — сами»):
 * - `temp` — временное: сборка, кэш, `.agent/tmp`, свежий `mktemp` этой
 *   команды, своя рабочая папка CLI; для ЗАПИСИ — ещё `/tmp/…`, `$TMPDIR/…`;
 * - `own` — прочее в своей копии: отслеживаемое git вернёт, а неотслеживаемое и
 *   не игнорируемое git НЕ вернёт — его удаление оставлено группе как работа
 *   в своей копии (решение владельца 23.10, F-74a); игнорируемое невременное
 *   вне локального слоя — тоже: это зеркало файлов основной копии или сделанное
 *   группой (R-C02, ревью корпуса 23.10: уборка своих проб в игнорируемом `e2e/`);
 * - `protected` — корень копии, `.git`, локальный слой (`.agent/`, `.claude/`,
 *   `.env…` — `DEFAULT_INCLUDE` зеркала) и игнорируемое, что в него входит или
 *   названо как секрет (`secrets/`, `*.pem`, `*.key`, `credentials…`), путь,
 *   уходящий из копии по ссылке, всё вне копии, неизвестный путь.
 *
 * Без списка игнорируемого (`scope.ignored`) невременное — `protected`, как раньше.
 */
export type TargetKind = 'temp' | 'own' | 'protected';

/** Каталог звена и известен ли он точно (`Walk.anchored`). */
export interface Place {
  cwd: string | undefined;
  anchored: boolean;
  /**
   * Каталог — корень копии наугад (`Walk.guessed`, F-29). Не задан — берётся у
   * обхода, если звено судится в его каталоге.
   */
  guessed?: boolean;
  /** Путь пишут, а не удаляют: `/tmp/x.log` для записи — временное, для удаления — нет (F-77). */
  write?: boolean;
  /** Удаление идёт и внутрь ссылки на каталог (`Remove-Item -Recurse`, `rm -rf link/`). */
  follow?: boolean;
}

const WIN = process.platform === 'win32';
const fold = (text: string): string => (WIN ? text.toLowerCase() : text);
const LOCAL_LAYER = DEFAULT_INCLUDE.map(fold);
/**
 * Образцы имён локального слоя для сверки с шаблоном цели: `.claude/**` →
 * `.claude`, `*.env` → `x.env`. `.cl*` под образец попадает — карточка.
 */
const LAYER_NAMES = [
  ...new Set(DEFAULT_INCLUDE.map((entry) => fold((entry.split('/')[0] ?? '').replace(/\*/g, 'x')))),
];

/**
 * Задевает ли цель игнорируемый путь: он внутри цели или цель внутри него. Без
 * точного каталога оболочка агента могла остаться в подкаталоге копии — цель
 * тогда сверяется с каждым положением внутри пути, а не только от корня.
 */
function touches(target: string[], entry: string[], anchored: boolean, dotglob: boolean): boolean {
  const offsets = anchored ? 1 : entry.length;
  for (let offset = 0; offset < offsets; offset += 1) {
    const overlap = Math.min(target.length, entry.length - offset);
    let matches = true;
    for (let i = 0; i < overlap && matches; i += 1) {
      matches = segmentMatches(target[i] as string, entry[offset + i] as string, dotglob);
    }
    if (matches) return true;
  }
  return false;
}

/**
 * Без точного каталога оболочка агента могла стоять в подкаталоге копии, и
 * `cd .. && rm -rf .agent/tmp/x`, `rm ../.agent/tmp/x` уходят «из копии» только
 * по счёту от корня. Временным такое считается, лишь если ниже общего с копией
 * предка путь начинается с временного каталога: `.agent/tmp/…`, `dist`, `tmp-x`.
 */
function climbedToTemp(path: string, walk: Walk): boolean {
  const below = walk.belowAncestor(path);
  if (!below) return false;
  const [first = '', second] = below.split('/');
  return isTempName(first) || (first === '.agent' && second !== undefined && isTempName(second));
}

/**
 * Путь в копии уходит из неё по ссылке (F-25): `node_modules` копии — ссылка
 * на каталог оригинала, и `rm -rf node_modules/*` сносит зависимости
 * оригинала. Сверяется настоящий путь ближайшего существующего предка цели (у
 * шаблона — предка первого шаблонного сегмента); сама цель — только когда
 * удаление идёт внутрь ссылки (`follow`): `rm -rf node_modules` убирает ссылку.
 */
function leavesCopy(path: string, root: string, walk: Walk, follow: boolean): boolean {
  const parts = path.split('/');
  const glob = parts.findIndex((part) => GLOB.test(part));
  let probe =
    glob >= 0 ? parts.slice(0, glob).join('/') : follow ? path : parts.slice(0, -1).join('/');
  while (probe !== root && within(probe, root)) {
    if (msysLink(probe)) return true;
    const resolved = real(probe);
    if (resolved) return !walk.inCopy(resolved);
    probe = probe.slice(0, probe.lastIndexOf('/'));
  }
  return false;
}

/** Временный путь вне копии по записи — если переменную в начале не переназначили в этой команде. */
function writableTemp(word: Word, walk: Walk): boolean {
  // Ссылка этой команды могла лечь под временный путь — судим по раскрытому пути.
  if (word.literalDollar || walk.links.any || !isTempOutside(word.text)) return false;
  const variable = tempVariable(word.text);
  if (variable !== undefined && walk.shadows(variable)) return false;
  return !leavesTemp(word.text);
}

/**
 * Вне копии: своё — только свежий `mktemp` и своя рабочая папка CLI (F-77).
 * Ссылка, заведённая там раньше и ведущая наружу, своим не делает (RF-BGCD-04).
 */
function outsideKind(
  path: string,
  target: Word,
  walk: Walk,
  place: Place,
  follow: boolean,
): TargetKind {
  const through = follow || place.write === true;
  if (walk.isFresh(path, through) || walk.inOwnScratchpad(path, through)) {
    return 'temp';
  }
  const pad = place.write ? scratchpadRoot(path) : undefined;
  if (pad !== undefined && !escapesBase(path, pad, true)) return 'temp';
  if (place.write && isTempOutside(path) && !leavesTemp(path)) return 'temp';
  return !place.anchored && !isAbsolute(target.text) && climbedToTemp(path, walk)
    ? 'temp'
    : 'protected';
}

export function targetKind(word: Word, walk: Walk, place: Place): TargetKind {
  // `$TMPDIR/…`, `%TEMP%\…` — временное по записи, до раскрытия переменных.
  if (place.write && writableTemp(word, walk)) return 'temp';
  const target = walk.expand(word);
  if (target.dynamic || /^:/.test(target.text)) return 'protected';
  if (place.write && writableTemp(target, walk)) return 'temp';
  // Каталог неизвестен — абсолютный путь всё равно назван точно.
  const cwd = place.cwd ?? (isAbsolute(target.text) ? '/' : undefined);
  if (!cwd) return 'protected';
  const path = resolveFrom(cwd, target.text);
  const follow = place.follow === true || /[\\/]\.?$/.test(target.text);
  // Через ссылку, заведённую этой же командой, — куда угодно (RF-BGCD-04).
  if (walk.links.crosses(path, follow || place.write === true)) return 'protected';
  const placed = walk.rootOf(path);
  if (!placed) return outsideKind(path, target, walk, place, follow);
  if (placed.path === placed.root) return 'protected';
  const rel = fold(placed.path.slice(placed.root.replace(/\/$/, '').length + 1));
  const parts = rel.split('/');
  if (parts.some((part) => segmentMatches(part, '.git', walk.dotglob))) return 'protected';
  if (leavesCopy(placed.path, placed.root, walk, follow)) return 'protected';
  if (isTempInside(placed.path, placed.root)) return 'temp';
  // Каталог взят наугад: оболочка могла уйти соседним вызовом (F-29).
  const guessed = place.guessed ?? (walk.guessed && place.cwd === walk.cwd);
  if (guessed && !isAbsolute(target.text)) return 'protected';
  const ignored = walk.ignored;
  if (!ignored) return 'protected';
  if (parts.some((part) => part === '*' || part === '**')) return 'protected';
  if (listed(rel, LOCAL_LAYER) || listed(`${rel}/_`, LOCAL_LAYER)) return 'protected';
  const layer = parts.some(
    (part) =>
      GLOB.test(part) && LAYER_NAMES.some((name) => segmentMatches(part, name, walk.dotglob)),
  );
  if (layer) return 'protected';
  // Игнорируемое невременное в своей копии — зеркало файлов основной копии
  // (оригинал цел там) или то, что группа сделала сама: его удаление — работа в
  // своей копии (R-C02, 23.10). Карточка — задетому локальному слою и секрету:
  // ключ, которого зеркало не копировало, git тоже не вернёт.
  const secretTarget = secretNamed(parts, walk.dotglob);
  const layerHit = ignored.some((entry) => {
    const folded = fold(entry);
    const split = folded.split('/');
    const kept =
      secretTarget ||
      secretNamed(split, walk.dotglob) ||
      listed(folded, LOCAL_LAYER) ||
      listed(`${folded}/_`, LOCAL_LAYER);
    return kept && touches(parts, split, place.anchored, walk.dotglob);
  });
  return layerHit ? 'protected' : 'own';
}

/**
 * Имя секрета: `secrets/`, `*.key`, `*.pem`, `.env…`, `credentials…`, ключи
 * ssh и хранилища ключей. `*.pem` в цели совпадает с образцом и так.
 */
const SECRET_SEGMENT =
  /^(\.?secrets?|\.?credentials?(\..*)?|\.env(\..*)?|.*\.env|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.netrc|\.npmrc|\.pypirc|.*\.(key|pem|p12|pfx|jks|keystore|crt|cer|gpg|kdbx))$/i;
/** Образцы для шаблона цели: `cred*`, `id_*`, `secret?` могут попасть в секрет. */
const SECRET_SAMPLES = ['secrets', 'secret', 'credentials', 'credentials.json', 'id_rsa', '.env'];

function secretNamed(parts: string[], dotglob: boolean): boolean {
  return parts.some(
    (part) =>
      SECRET_SEGMENT.test(part) ||
      (GLOB.test(part) && SECRET_SAMPLES.some((name) => segmentMatches(part, name, dotglob))),
  );
}

/**
 * `git ls-files -z --others --ignored --exclude-standard --directory` → список для
 * `scope.ignored`: пути от корня копии без `/` на конце, временное отброшено —
 * его удаление и так уборка.
 */
export function ignoredFacts(stdout: string): string[] {
  return stdout
    .split('\0')
    .map((entry) => entry.replace(/\/+$/, ''))
    .filter((entry) => entry.length > 0 && !isTempInside(`/r/${entry}`, '/r'));
}

const REMOVERS = new Set([
  'rm',
  'rmdir',
  'rd',
  'del',
  'erase',
  'unlink',
  'remove-item',
  'shred',
  'rimraf',
  'trash',
]);

export function isRemover(name: string): boolean {
  return REMOVERS.has(name.toLowerCase());
}

/**
 * Ключи `cmd` у его команд удаления. Только у них `/x` — ключ: у `rm` `/c` —
 * диск C: Git Bash, и `rm -rf /c` проходил без карточки как «ноль целей» (F-01).
 */
const CMD_SWITCHES: Record<string, RegExp> = {
  rd: /^[sq]$/i,
  rmdir: /^[sq]$/i,
  del: /^([pfsqa]|a:\S*)$/i,
  erase: /^([pfsqa]|a:\S*)$/i,
};
/** Удаляют всегда всё дерево. */
const ALWAYS_RECURSIVE = new Set(['rimraf', 'trash']);

/**
 * Удаление: временное и своё в копии — уборка, рутина (строка «удаление
 * файлов»); прочее — человеку. Пустой каталог (`rmdir` без `/s`) удалить
 * нечего — рутина.
 */
export function removeVerdict(words: Word[], walk: Walk): SegmentVerdict {
  const name = (words[0] as Word).text.toLowerCase().replace(/\.exe$/, '');
  const args = words.slice(1);
  const switches = CMD_SWITCHES[name];
  // `rd /s/q x` — ключи cmd слитно (F-13): каждый сегмент между `/` — ключ.
  const isSwitch = (text: string): boolean =>
    switches !== undefined &&
    /^(\/[^/\s]+)+$/.test(text) &&
    text
      .split('/')
      .slice(1)
      .every((part) => switches.test(part));
  const recursive =
    ALWAYS_RECURSIVE.has(name) ||
    args.some(
      (arg) =>
        /^-r(ecurse)?$/i.test(arg.text) ||
        /^-[a-zA-Z]*[rR]/.test(arg.text) ||
        arg.text === '--recursive' ||
        (isSwitch(arg.text) && /\/s(\/|$)/i.test(arg.text)),
    );
  if ((name === 'rmdir' || name === 'rd') && !recursive) return ROUTINE;
  const end = args.findIndex((arg) => arg.text === '--');
  const targets = args.filter(
    (arg, i) => (end >= 0 && i > end) || (!/^-/.test(arg.text) && !isSwitch(arg.text)),
  );
  const place = { ...walk.place(), follow: name === 'remove-item' };
  return pathsVerdict(targets, walk, place) ?? DANGER;
}

/**
 * Цели удаления или перезаписи: все временные или свои в копии — рутина с
 * удалением, иначе `undefined` — решает вызывающий.
 */
export function pathsVerdict(
  targets: Word[],
  walk: Walk,
  place: Place,
): SegmentVerdict | undefined {
  for (const target of targets) {
    if (targetKind(target, walk, place) === 'protected') return undefined;
  }
  return { kind: 'routine', deletes: true };
}
