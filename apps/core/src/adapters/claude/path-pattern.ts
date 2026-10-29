import { caselessGlob, localShareHosts } from '../local-share.ts';

/**
 * Путь запрета в правиле Claude Code. Правило сравнивает строку пути, как её написала модель, —
 * поэтому один путь диска пишется несколькими правилами: форма диска (`//c/x`), административная
 * доля этой машины (`\\localhost\C$\x`, verify-cli V4), префиксы `\\?\C:\` и `\\?\UNC\` (core-s2
 * F-126), регистр и короткие имена 8.3 — и `AGENTD~1` (V3), и хэш-форма `AGC9C9~1` (F-127).
 * Знаки шаблона в имени (`[ ] { } ( ) ! * ?`) — подстановка `?`, иначе `Core[1]Home` читался бы
 * как класс и правило не совпадало бы с самим путём (V4). Фигурных альтернатив `{a,b}` CLI не
 * знает (проверено на живом CLI), поэтому каждая форма — своё правило.
 *
 * Не выражается вовсе: `\\.\C:\…` и `\\.\UNC\…` — путь устройства CLI не сверяет ни с одним
 * правилом пути, даже `Read(**)` (живые пробы V5 dotq / dotunc); его стережёт судья ядра
 * (`platform-path`).
 */

const GLOB_SPECIAL = /[[\]{}()!*?]/g;
/** Имя, у которого 8.3 нет своего короткого: оно само короткое (регистр — не в счёт). */
const DOS_NAME = /^[A-Za-z0-9_\-$~#%&@^'`]{1,8}(\.[A-Za-z0-9_\-$~#%&@^'`]{1,3})?$/;
/** Знак, который 8.3 оставляет как есть; прочие (`+ , ; = [ ]`, не-ASCII) становятся `_`. */
const DOS_CHAR = /[A-Za-z0-9_\-$~#%&@^'`]/;
const STEM = 6;
/** Хэш-форма 8.3 берёт два первых знака имени, четыре знака хэша и `~N`. */
const HASH_STEM = 2;

const escapeGlob = (value: string): string => value.replace(GLOB_SPECIAL, '?');

const caseless = (value: string): string => caselessGlob(escapeGlob(value));

/** Имена хоста, под которыми `\\<host>\X$\` — диск этой же машины. */
const localHosts = localShareHosts;

/**
 * Каноническая форма с `/`: `\\?\C:\x` и `\\.\C:\x` → `C:/x`, `\\?\UNC\h\s` → `//h/s`,
 * административная доля этой машины (`\\localhost\C$\x`) → `C:/x`; хвостовой `/` снят.
 */
export function canonicalPath(path: string): string {
  let p = path.replace(/\\/g, '/');
  p = p.replace(/^\/\/[?.]\/UNC\//i, '//').replace(/^\/\/[?.]\/(?=[A-Za-z]:)/, '');
  const admin = /^\/\/([^/]+)\/([A-Za-z])\$(?=\/|$)/.exec(p);
  if (admin && localHosts().includes((admin[1] as string).toLowerCase())) {
    p = `${admin[2] as string}:${p.slice(admin[0].length) || '/'}`;
  }
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

const DRIVE = /^([A-Za-z]):(?:\/|$)/;
const UNC = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/;

/**
 * Абсолютный путь в правиле Claude Code: `//` + путь от корня, на Windows — в форме POSIX
 * (`C:\x` → `//c/x`), так CLI сравнивает пути со своими. Относительный путь сюда не доходит —
 * его разрешает вызывающий от cwd (F-36): правило «от корня ФС» не совпало бы ни с чем.
 */
export function claudeAbsolutePattern(path: string): string {
  const slashed = escapeGlob(canonicalPath(path));
  const drive = DRIVE.exec(slashed);
  if (drive) return `//${(drive[1] as string).toLowerCase()}/${slashed.slice(3)}`;
  if (!slashed.startsWith('/')) throw new Error(`deny path is not absolute: ${path}`);
  return `/${slashed}`;
}

/** Знаки 8.3 из имени: без ведущих точек и пробелов, основа без точек и пробелов. */
function dosStem(segment: string): string[] {
  const name = segment.replace(/^[. ]+/, '');
  const dot = name.lastIndexOf('.');
  return [...(dot > 0 ? name.slice(0, dot) : name).replace(/[. ]/g, '')];
}

const dosChar = (c: string): string => (DOS_CHAR.test(c) ? caseless(c) : '?');

/**
 * Сегмент, совпадающий и с длинным именем, и с его коротким `~N` любого регистра: короткое
 * берёт до шести первых знаков имени без точек и пробелов (недопустимые → `_`), поэтому шаблон —
 * эти знаки по порядку с `*` между ними (`*` CLI сверяет и с именем на точку, живая проба V7).
 */
function tolerantSegment(segment: string): string {
  if (DOS_NAME.test(segment)) return caseless(segment);
  const stem = dosStem(segment).slice(0, STEM);
  if (stem.length === 0) return '*';
  return `*${stem.map(dosChar).join('*')}*`;
}

/**
 * Хэш-форма 8.3 (`AGC9C9~1`, `CO1A2B~1.TXT`): пятое и дальше имя с тем же префиксом в каталоге
 * получает два первых знака, хэш и `~N`. Хэш из имени не вычислить — шаблон берёт любые четыре.
 * Короткое имя (8.3 само) хэш-формы не имеет — `null`.
 */
function hashSegment(segment: string): string | null {
  if (DOS_NAME.test(segment)) return null;
  const stem = dosStem(segment).slice(0, HASH_STEM);
  if (stem.length === 0) return null;
  return `${stem.map(dosChar).join('')}${stem.length < HASH_STEM ? '*' : '????'}~*`;
}

/**
 * Хвосты, терпимые к 8.3: все сегменты терпимы, и по одному сегменту — в хэш-форме. Два хэш-имени
 * в одном пути (два каталога по пять имён с общим префиксом на одной дороге) — остаток: его
 * стережёт судья (`platform-path`), а произведение форм раздуло бы правила в разы.
 */
function tolerantTails(rest: readonly string[]): string[] {
  const tolerant = rest.map(tolerantSegment);
  const tails = [tolerant.join('/')];
  rest.forEach((segment, i) => {
    const hash = hashSegment(segment);
    if (hash !== null) tails.push(tolerant.map((t, j) => (j === i ? hash : t)).join('/'));
  });
  return tails;
}

/** Корень пути (буква диска или `\\сервер\доля`) и сегменты под ним. */
interface Rooted {
  /** Точные префиксы правила: как путь записан в канонической форме. */
  exact: string[];
  /** Префиксы любого регистра — к ним идут хвосты регистра и 8.3. */
  loose: string[];
  rest: string[];
}

function rooted(canonical: string): Rooted | null {
  const drive = DRIVE.exec(canonical);
  if (drive) {
    const letter = drive[1] as string;
    const exact = [`//${letter.toLowerCase()}/`];
    // `\\?\C:\…` CLI сравнивает как `//?/C:/…` (живая проба V6 qprefix): своя форма префикса.
    const loose = [`//${caseless(letter)}/`, `///?/${caseless(letter)}:/`];
    for (const host of localHosts()) {
      exact.push(`///${host}/${letter.toUpperCase()}$/`);
      loose.push(`///${caseless(host)}/${caseless(letter)}$/`);
      // `\\?\UNC\host\C$\…` CLI сравнивает как `//?/UNC/…` (живая проба V6).
      loose.push(`///?/${caseless('UNC')}/${caseless(host)}/${caseless(letter)}$/`);
    }
    return { exact, loose, rest: canonical.slice(drive[0].length).split('/').filter(Boolean) };
  }
  const unc = UNC.exec(canonical);
  if (unc) {
    const server = escapeGlob(unc[1] as string);
    const share = escapeGlob(unc[2] as string);
    return {
      exact: [`///${server}/${share}/`],
      loose: [
        `///${caseless(unc[1] as string)}/${caseless(unc[2] as string)}/`,
        `///?/${caseless('UNC')}/${caseless(unc[1] as string)}/${caseless(unc[2] as string)}/`,
      ],
      rest: canonical.slice(unc[0].length).split('/').filter(Boolean),
    };
  }
  return null;
}

/**
 * Все формы пути для правил запрета. Путь POSIX — одна форма. Путь диска или доли: точная; любой
 * регистр; терпимая к `~N` и к хэш-форме по одному сегменту — у буквы диска, у административной
 * доли каждого имени этой машины и у неё же за `\\?\UNC\`; у доли `\\сервер\доля` — у неё и за
 * `\\?\UNC\`.
 */
export function claudePathPatterns(path: string): string[] {
  const exact = claudeAbsolutePattern(path);
  const root = rooted(canonicalPath(path));
  if (!root) return [exact];
  // Регистр без 8.3 — отдельной формой: точная буква с любым регистром не зависит от того,
  // какие сегменты CLI получил короткими.
  const caselessRest = root.rest.map(caseless).join('/');
  const exactRest = escapeGlob(root.rest.join('/'));
  const tails = [caselessRest, ...tolerantTails(root.rest)];
  const forms = [exact];
  for (const prefix of root.exact) forms.push(`${prefix}${exactRest}`);
  for (const prefix of root.loose) for (const tail of tails) forms.push(`${prefix}${tail}`);
  return [...new Set(forms.map((form) => form.replace(/\/+$/, '')))];
}
