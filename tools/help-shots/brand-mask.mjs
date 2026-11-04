/**
 * Марка чужой платформы в кадре справки: закрыть ДО снимка и не снять кадр, если она осталась видна.
 *
 * Справка публичная, а раздел «Контур» снимается на стенде платформы компании — её логотип, имя и
 * домены в кадр не уезжают. Список слов НЕ живёт в репозитории (репозиторий о платформе не знает):
 * файл `GUIDE_BRAND_FILE` (по умолчанию `.agent/private/brand-mask.txt`, вне git), строка на слово,
 * регистр не важен; `logo: <селектор>` — дополнительный селектор логотипа; `replace: <текст>` —
 * чем заменить слово (по умолчанию «Platform»); `#` — комментарий.
 *
 * Закрывается в разметке, не в пикселях: текстовые узлы, значения и подсказки полей, атрибуты
 * `alt`/`title`/`aria-label`; логотип — `visibility: hidden` (место остаётся, марки нет). Проверка
 * после закрытия смотрит ТО ЖЕ, что увидит снимок: видимый текст, поля, атрибуты и видимые элементы,
 * похожие на логотип, — и любая находка роняет кадр (`brandLeaks`), а не пишет предупреждение.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_FILE = join(
  resolve(import.meta.dirname, '../..'),
  '.agent',
  'private',
  'brand-mask.txt',
);

/** Список марки из файла; файла нет — `null` (вызывающий решает, можно ли снимать без него). */
export function readBrandMask(env = process.env) {
  const file = env.GUIDE_BRAND_FILE || DEFAULT_FILE;
  if (!existsSync(file)) return null;
  const words = [];
  const logos = [];
  let replace = 'Platform';
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const logo = /^logo:\s*(.+)$/i.exec(line);
    const swap = /^replace:\s*(.+)$/i.exec(line);
    if (logo) logos.push(logo[1].trim());
    else if (swap) replace = swap[1].trim();
    else words.push(line);
  }
  return words.length ? { words, logos, replace } : null;
}

/**
 * Один проход по странице: закрыть марку (`mask: true`) и найти, что осталось видно.
 * Возвращает `{ masked, leaks }`; `leaks` — короткие описания, без самих слов марки.
 */
export async function brandPass(page, brand, { mask = true, anyLogo = true } = {}) {
  return page.evaluate(
    ([words, logos, replace, doMask, wideLogo]) => {
      const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const pattern = new RegExp(escaped.join('|'), 'gi');
      const hit = (text) => {
        pattern.lastIndex = 0;
        return pattern.test(text ?? '');
      };
      const swap = (text) => (text ?? '').replace(pattern, replace);
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
          return false;
        }
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      // Любой «логотип» по имени класса — только у чужого приложения: у панели он свой, и его марка
      // в справке на месте. У панели закрываются только картинки, названные словом марки.
      const logoSelector =
        [
          ...(wideLogo
            ? ['[class*="logo" i]', '[id*="logo" i]', '[alt*="logo" i]', '[aria-label*="logo" i]']
            : []),
          ...logos,
        ].join(', ') || ':not(*)';
      const branded = (element) =>
        ['alt', 'title', 'aria-label', 'src', 'href', 'class', 'id', 'data-testid'].some((name) =>
          hit(element.getAttribute(name)),
        );
      const imageLike = 'img, svg, picture, image, [role="img"], object, embed';
      let masked = 0;
      if (doMask) {
        // Знаки ищутся ДО замены подписей: знак, названный маркой только в `aria-label`
        // (`<svg role="img" aria-label="…">`), после замены подписи маркой уже не выглядит, и
        // проверка после закрытия его не видит (живой стенд 03.11: знак уехал в кадр).
        const logosFound = new Set(document.querySelectorAll(logoSelector));
        for (const element of document.querySelectorAll(imageLike)) {
          if (branded(element)) logosFound.add(element);
        }
        // Плашка-обёртка знака (единственный ребёнок, размер того же порядка) скрывается вместе
        // с ним: цветной квадрат на месте марки — тоже её примета.
        const tileOf = (element) => {
          const parent = element.parentElement;
          if (!parent || parent === document.body || parent.children.length !== 1) return element;
          const own = element.getBoundingClientRect();
          const box = parent.getBoundingClientRect();
          const close =
            box.width <= Math.max(own.width * 2.5, own.width + 32) &&
            box.height <= Math.max(own.height * 2.5, own.height + 32);
          return close ? parent : element;
        };
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode())
          if (hit(walker.currentNode.textContent)) nodes.push(walker.currentNode);
        for (const node of nodes) {
          node.textContent = swap(node.textContent);
          masked += 1;
        }
        for (const field of document.querySelectorAll('input, textarea')) {
          if (hit(field.value)) {
            field.value = swap(field.value);
            masked += 1;
          }
          if (hit(field.placeholder)) {
            field.placeholder = swap(field.placeholder);
            masked += 1;
          }
        }
        for (const element of document.querySelectorAll('[alt], [title], [aria-label]')) {
          for (const name of ['alt', 'title', 'aria-label']) {
            const value = element.getAttribute(name);
            if (value && hit(value)) {
              element.setAttribute(name, swap(value));
              masked += 1;
            }
          }
        }
        for (const element of logosFound) {
          const target = tileOf(element);
          target.style.setProperty('visibility', 'hidden', 'important');
          element.style.setProperty('visibility', 'hidden', 'important');
          masked += 1;
        }
      }
      const leaks = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let textLeaks = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (hit(node.textContent) && visible(node.parentElement)) textLeaks += 1;
      }
      if (textLeaks) leaks.push(`текст марки (${textLeaks})`);
      let fieldLeaks = 0;
      for (const field of document.querySelectorAll('input, textarea')) {
        if (visible(field) && (hit(field.value) || hit(field.placeholder))) fieldLeaks += 1;
      }
      if (fieldLeaks) leaks.push(`поле с маркой (${fieldLeaks})`);
      let logoLeaks = 0;
      for (const element of document.querySelectorAll(logoSelector)) {
        if (visible(element)) logoLeaks += 1;
      }
      for (const element of document.querySelectorAll(imageLike)) {
        if (visible(element) && branded(element)) logoLeaks += 1;
      }
      if (logoLeaks) leaks.push(`логотип (${logoLeaks})`);
      return { masked, leaks };
    },
    [brand.words, brand.logos, brand.replace, mask, anyLogo],
  );
}

/** Текст кадра (опись) с маркой — для `check-help-shots.mjs`: те же слова, тот же регистр. */
export function brandInText(text, brand) {
  if (!brand) return 0;
  const escaped = brand.words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return (text.match(new RegExp(escaped.join('|'), 'gi')) ?? []).length;
}
