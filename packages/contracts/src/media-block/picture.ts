import { blockLang } from '../brand.ts';
/**
 * Рисунок из блока в ответе агента: проверка, после которой файл можно положить
 * на диск и открыть.
 */

/** Язык блока с рисунком. Внутри — сам `<svg>`, а не JSON вокруг него. */
export const PICTURE_BLOCK_LANG = blockLang('svg');

/**
 * Потолок рисунка — в ЗНАКАХ, а не в байтах: этот разбор идёт и в браузере, и в
 * сервере, а мерить байты одинаково в обоих местах нечем (`Buffer` есть только в
 * одном, `TextEncoder` не объявлен в типах контрактов). Вектор, нарисованный
 * кодом, — это килобайты; полмиллиона знаков означают либо вставленный внутрь
 * растр, либо мусор, и открывать такое в панели незачем.
 */
export const PICTURE_MAX_CHARS = 512_000;

/** Почему рисунок отвергнут. Причина называется: молча выбросить ответ агента нельзя. */
export type PictureProblem =
  /** Не SVG вовсе: ни корневого тега, ни закрывающего. */
  | 'not-svg'
  /** Больше потолка. */
  | 'too-big'
  /** Скрипт, обработчик события или чужой документ внутри картинки. */
  | 'active-content'
  /** Ссылка наружу: картинка обязана быть самодостаточной, сети в показе нет. */
  | 'remote-ref';

export interface PictureCheck {
  /** Рисунок, годный к показу. Пусто — смотри `problem`. */
  svg?: string;
  problem?: PictureProblem;
}

/**
 * Проверка рисунка — fail-closed, и проверок ровно столько, сколько нужно, чтобы
 * файл был самодостаточным и мёртвым.
 *
 * Показывается он `<img>`-ом с нашего же адреса (в этом контексте скрипты не
 * исполняются вовсе) и отдаётся с `default-src 'none'`, так что запреты здесь —
 * второй слой, а не единственный. Но отвергать активное содержимое обязательно
 * и на разборе: иначе панель хранила бы на диске файл, который опасен ровно в
 * тот момент, когда человек откроет его СНАРУЖИ панели, своим браузером.
 */
export function checkPicture(source: string): PictureCheck {
  const svg = source.trim();
  if (svg.length > PICTURE_MAX_CHARS) return { problem: 'too-big' };

  // Пролог XML и комментарии перед корнем допустимы — их пишут генераторы.
  if (!/^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg)) {
    return { problem: 'not-svg' };
  }
  if (!/<\/svg\s*>\s*$/i.test(svg)) return { problem: 'not-svg' };

  // Смотрим на РАСКОДИРОВАННУЮ копию, а сохраняем исходную: браузер читает
  // `&#104;ttps://…` как адрес, а проверка по сырому тексту видела там безобидную
  // строку (враждебная проверка 13.09.2026 — принятые и сохранённые файлы, которые
  // звонили наружу при открытии с диска).
  const probe = normalise(svg);

  if (active(probe)) return { problem: 'active-content' };
  if (remoteRef(probe)) return { problem: 'remote-ref' };

  return { svg: withNamespaces(svg) };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * Объявить пространства имён, которых рисунок не объявил.
 *
 * Внутри HTML `<svg>` без `xmlns` рисуется, поэтому модели его и не пишут. А
 * файлом — `<img>` панели, картинка слайда PPTX, скачанный `.svg` — это XML, и
 * без пространства имён браузер показывает пустое место, а `xlink:` без
 * объявления вовсе ошибка разбора (аудит MD-08, проверено Chromium на выходе
 * этой функции). Отказывать здесь не за что — рисунок годный, — поэтому это
 * единственная правка исходника: одно-два объявления в корневом теге, и только
 * отсутствующие, иначе второй `xmlns` сам стал бы ошибкой разбора.
 */
function withNamespaces(svg: string): string {
  const root = /<svg(?=[\s>])([^>]*)>/i.exec(svg);
  if (!root) return svg;
  const attrs = root[1] ?? '';
  const missing: string[] = [];
  if (!/\sxmlns\s*=/i.test(attrs)) missing.push(`xmlns="${SVG_NS}"`);
  if (/\bxlink:/i.test(svg) && !/\sxmlns:xlink\s*=/i.test(attrs)) {
    missing.push(`xmlns:xlink="${XLINK_NS}"`);
  }
  if (missing.length === 0) return svg;
  const at = root.index + '<svg'.length;
  return `${svg.slice(0, at)} ${missing.join(' ')}${svg.slice(at)}`;
}

/**
 * Копия рисунка, приведённая к тому виду, в котором его прочтёт браузер:
 * раскодированные ссылки на знаки, снятые escape-последовательности CSS, без
 * комментариев.
 *
 * Копия нужна именно для ПРОВЕРКИ: на диск уходит исходник (плюс недостающие
 * объявления пространств имён, `withNamespaces`), иначе панель меняла бы рисунок
 * агента, а отвечать за вид файла должна не она. Строгость копии
 * односторонняя — лишний запрет здесь превращается в названную причину отказа, а
 * пропущенный превращается в файл, который звонит домой.
 */
function normalise(svg: string): string {
  return (
    decodeRefs(svg)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // `\3a` и `\:` в CSS — это двоеточие; ими прятали схему адреса внутри `url()`.
      .replace(/\\([0-9a-fA-F]{1,6})[ \t]?/g, (_whole, hex: string) =>
        codePoint(Number.parseInt(hex, 16)),
      )
      .replace(/\\(.)/g, '$1')
  );
}

/** Ссылки на знаки: `&#104;`, `&#x68;` и те имена, которыми прячут схему адреса. */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  sol: '/',
  num: '#',
  lpar: '(',
  rpar: ')',
  period: '.',
  tab: '\t',
  newline: '\n',
  nbsp: ' ',
};

function decodeRefs(value: string): string {
  return value.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);?/gi, (whole, body: string) => {
    const lowered = body.toLowerCase();
    if (lowered.startsWith('#x')) return codePoint(Number.parseInt(body.slice(2), 16));
    if (lowered.startsWith('#')) return codePoint(Number.parseInt(body.slice(1), 10));
    return NAMED[lowered] ?? whole;
  });
}

function codePoint(code: number): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
}

/**
 * Активное содержимое. Список закрыт и намеренно шире буквального: `<script/>`
 * без пробела, оживление ссылки через `<set>`/`<animate>` и объявление сущности
 * (через него читают файлы с диска) — всё это способы получить в мёртвом файле
 * живое поведение.
 */
function active(probe: string): boolean {
  if (/<\s*\/?\s*(?:script|foreignobject|iframe|object|embed|handler)[\s/>]/i.test(probe)) {
    return true;
  }
  if (/\son[a-z]+\s*=/i.test(probe)) return true;
  if (/javascript\s*:/i.test(probe) || /vbscript\s*:/i.test(probe)) return true;
  if (/<!ENTITY/i.test(probe) || /<!DOCTYPE/i.test(probe)) return true;
  // `<set attributeName="xlink:href" to="javascript:…">` — ссылка, оживлённая
  // анимацией: сам адрес при разборе выглядит безобидным значением атрибута.
  return /<\s*(?:set|animate|animatetransform|animatemotion)\b[^>]*attributename\s*=\s*["']?\s*(?:xlink:)?href/i.test(
    probe,
  );
}

/**
 * Ссылка наружу — теперь БЕЛЫМ списком, а не перечислением опасного.
 *
 * Раньше запрещались `http(s)://` и `//`, то есть проверка перечисляла то, что
 * успела придумать: `file://`, `ftp:`, относительный путь и раскодированная схема
 * проходили. Самодостаточность — свойство положительное: внутрь файла (`#id`) и
 * вшитые байты (`data:` картинки и шрифта) можно, всё остальное — ссылка наружу.
 */
function remoteRef(probe: string): boolean {
  const refs = probe.matchAll(
    /\b(?:xlink:href|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
  );
  for (const found of refs) {
    if (!selfContained(found[1] ?? found[2] ?? found[3] ?? '')) return true;
  }
  const urls = probe.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi);
  for (const found of urls) {
    if (!selfContained(found[2] ?? '')) return true;
  }
  return /@import/i.test(probe);
}

/** Вшитые байты и ссылка внутрь этого же файла. Остальное ведёт наружу. */
function selfContained(value: string): boolean {
  const ref = value.trim();
  if (ref === '' || ref.startsWith('#')) return true;
  // `data:image/svg+xml` не в списке намеренно: что внутри такой вставки, эта
  // проверка не видит, а обещание «самодостаточный и мёртвый» отвечает за всё.
  return /^data:(?:image\/(?:png|jpe?g|gif|webp|avif|bmp)|font\/(?:woff2?|ttf|otf))\s*;/i.test(ref);
}
