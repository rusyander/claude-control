/**
 * Замеры вёрстки для `audit-layout.mjs` — то, что видно глазом, но не ловится
 * типами. Функция `measureLayout` уходит в `page.evaluate` целиком, поэтому она
 * самодостаточна: ни одного внешнего имени внутри, только аргумент `opts`.
 *
 * Метрики (коды — в отчёте и в самопроверке `--selftest`):
 *   W  — рамка раздела уже области контента: справа пустует полоса (bug 3).
 *   WN — высокий блок один в своём ряду и уже 60 % родителя, растянутого на
 *        всю ширину: «узкая колонка внутри широкой страницы» (bug 3).
 *   WE — пустое состояние не по центру своей коробки (bug 3).
 *   H  — внутренняя прокрутка списка, а под ним пустует высота окна (bug 3).
 *   H2 — две прокрутки сразу: страница и крупный блок внутри неё (bug 3). У
 *        страницы со своими прокрутками (`data-page-fill`) не считается блок,
 *        сжатый до своего `min-height`: это объявленный запасной режим низкого
 *        окна («ниже этой высоты прокручивается страница целиком»).
 *   C  — одноимённые действия в соседних строках списка стоят в разных колонках
 *        (строка без тумблера сдвигает кнопки, bug 3).
 *   V  — строка списка выше своего места и заходит под следующую (слот
 *        виртуального списка меньше строки): разделитель режет соседа, строка
 *        стоит не по центру своей полосы (bug 7).
 *   R  — центры содержимого ячеек одной строки таблицы расходятся больше
 *        допуска: значки у верха строки, иконки ниже (bug 7). Текст, спрятанный
 *        для скринридера (коробка в 1px), не считается.
 *   B  — последний элемент прокрученной до конца страницы ближе порога к нижнему
 *        краю окна (bug 10); то же для прокручиваемого тела окна-диалога.
 *   S  — выпадающий список без своей стрелки или без правого отступа под неё (bug 8).
 *   X  — горизонтальная прокрутка документа / элемент за правым краем.
 *   T  — слишком широкая строка переносимого текста.
 *
 * Разметка, на которую опираются замеры: `main` — единственная прокрутка
 * раздела (MainLayout), `[data-layout-page]` — обёртка страницы внутри неё,
 * `[data-page-fill]` — страница, которая сама держит свои прокрутки (чат),
 * `[data-empty-state]` — пустое состояние. Без маркеров замер берёт последнего
 * ребёнка `main`, так что и вёрстка до правки меряется честно.
 */
export function measureLayout(opts = {}) {
  const tol = opts.rowTolerance ?? 2;
  const minBottomGap = opts.minBottomGap ?? 24;
  const minDialogGap = opts.minDialogGap ?? 16;
  const widthSlack = opts.widthSlack ?? 24;
  const issues = [];
  const add = (code, text) => issues.push({ code, text });

  const clip = (value, length = 36) => {
    const flat = String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return flat.length > length ? `${flat.slice(0, length)}…` : flat;
  };
  // Имя модульного класса без хэша сборки: `_row_1x2y3_12` → `row`.
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const cls = String(el.className?.baseVal ?? el.className ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => name.replace(/^_/, '').replace(/_[a-z0-9]{5}(_\d+)?$/i, ''))
      .slice(0, 2)
      .join('.');
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    const text = label || clip(el.textContent, 28);
    return `${tag}${cls ? `.${cls}` : ''}${text ? ` «${clip(text, 28)}»` : ''}`;
  };
  // Цепочка модульных классов до трёх предков: по ней видно, какой компонент
  // рисует найденное, без текста (текст уже есть в сообщении).
  const trail = (el) => {
    const parts = [];
    for (let node = el, depth = 0; node && node !== document.body && depth < 3; depth += 1) {
      const cls = String(node.className?.baseVal ?? node.className ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((name) => name.replace(/^_/, '').replace(/_[a-z0-9]{5}(_\d+)?$/i, ''))[0];
      parts.unshift(`${node.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  // Содержимое закрытого <details> (и любое под `content-visibility: hidden`)
  // возвращает коробки, хотя его не видно: без `checkVisibility` оно попадало
  // в замеры — «текст шире 900px» и «последний элемент в −5452px от низа».
  const rendered = (el) =>
    el.checkVisibility?.({ contentVisibilityAuto: true, visibilityProperty: true }) ?? true;
  const isShown = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && rendered(el);
  };
  const px = (value) => Number.parseFloat(value) || 0;
  const round = (value) => Math.round(value);

  const main = document.querySelector('main');
  if (!main) return { issues: [{ code: 'E', text: 'нет <main>' }], facts: {} };
  const wrapper =
    main.querySelector(':scope > [data-layout-page]') ??
    main.querySelector('[data-layout-page]') ??
    main.lastElementChild;
  if (!wrapper) return { issues: [{ code: 'E', text: 'пустой <main>' }], facts: {} };

  const mainStyle = getComputedStyle(main);
  const mainRect = main.getBoundingClientRect();
  const clientLeft = mainRect.left + main.clientLeft;
  const clientTop = mainRect.top + main.clientTop;
  const availLeft = clientLeft + px(mainStyle.paddingLeft);
  const availRight = clientLeft + main.clientWidth - px(mainStyle.paddingRight);
  const availWidth = availRight - availLeft;
  const clientBottom = clientTop + main.clientHeight;
  const isFill =
    wrapper.matches('[data-page-fill]') || Boolean(wrapper.querySelector('[data-page-fill]'));
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(
    isShown,
  );
  const inDialog = (el) => Boolean(el.closest('[role="dialog"], [role="alertdialog"]'));

  // Первый предок, который обрезает содержимое (прокрутка или hidden/clip), —
  // до границы `stop`. Элемент внутри такого предка виден только в его окне.
  const clippingAncestor = (el, stop) => {
    for (let node = el.parentElement; node && node !== stop; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowY !== 'visible' || style.overflowX !== 'visible') return node;
    }
    return null;
  };

  // ── X: горизонтальное переполнение ────────────────────────────────────────
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    add('X', `страница шире окна на ${doc.scrollWidth - doc.clientWidth}px`);
  }
  for (const el of main.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.right <= clientLeft + main.clientWidth + 1) continue;
    if (clippingAncestor(el, main)) continue;
    add('X', `выходит за правый край: ${describe(el)} (+${round(rect.right - mainRect.right)}px)`);
  }

  // ── S: стрелка выпадающего списка с отступом от рамки ─────────────────────
  // Системная стрелка стоит вплотную к правой рамке и под неё заезжает текст.
  // Своя стрелка — фон-картинка, и под неё оставлен правый отступ.
  for (const select of document.querySelectorAll('select')) {
    if (select.multiple || select.size > 1 || !isShown(select)) continue;
    const style = getComputedStyle(select);
    const own = style.appearance === 'none' && style.backgroundImage.includes('url(');
    const inset = px(style.paddingRight);
    if (!own || inset < 24) {
      const what = own ? '' : 'системная стрелка, ';
      add(
        'S',
        `выпадающий список ${describe(select)}: ${what}справа ${round(inset)}px (нужна своя стрелка и ≥ 24)`,
      );
    }
  }

  // ── T: слишком широкая строка переносимого текста ─────────────────────────
  for (const el of main.querySelectorAll('p, span')) {
    if (!rendered(el)) continue;
    const rect = el.getBoundingClientRect();
    const text = el.textContent ?? '';
    const style = getComputedStyle(el);
    const wraps = style.whiteSpace !== 'nowrap' && style.whiteSpace !== 'pre';
    // Проза — это слова: перечень без пробелов («Bash|Write|Edit|…») — данные,
    // он переносится по любому месту и мерой строки не меряется.
    const words = text.trim().split(/\s+/).length;
    if (wraps && text.length > 120 && words >= 12 && rect.width > 900) {
      add(
        'T',
        `слишком широкий текст (${round(rect.width)}px) в ${trail(el)}: «${clip(text, 45)}»`,
      );
    }
  }

  // ── W: рамка раздела во всю область контента ──────────────────────────────
  // Рамка — самый широкий блочный бокс среди обёртки и двух уровней под ней.
  // Уже области больше чем на `widthSlack` — справа пустая полоса.
  const blockish = (el) => {
    const display = getComputedStyle(el).display;
    return !display.startsWith('inline') && display !== 'contents' && display !== 'none';
  };
  let frame = 0;
  let frameEl = wrapper;
  const levelOne = [...wrapper.children];
  const levelTwo = levelOne.flatMap((el) => [...el.children]);
  for (const el of [wrapper, ...levelOne, ...levelTwo]) {
    if (!isShown(el) || !blockish(el) || inDialog(el)) continue;
    const width = el.getBoundingClientRect().width;
    if (width > frame) {
      frame = width;
      frameEl = el;
    }
  }
  // Обёртку `main` растягивает сама; решает то, что лежит внутри неё.
  const pageRoot = levelOne.filter((el) => isShown(el) && blockish(el));
  const rootWidth = Math.max(0, ...pageRoot.map((el) => el.getBoundingClientRect().width));
  if (pageRoot.length > 0 && availWidth - rootWidth > widthSlack) {
    add(
      'W',
      `рамка раздела ${round(rootWidth)}px из ${round(availWidth)}px — справа пусто ${round(availWidth - rootWidth)}px`,
    );
  }

  // ── WN: узкий высокий блок один в своём ряду ──────────────────────────────
  const SKIP_NARROW = new Set([
    'P',
    'PRE',
    'BLOCKQUOTE',
    'TEXTAREA',
    'IMG',
    'SVG',
    'CANVAS',
    'VIDEO',
    'H1',
    'H2',
    'H3',
    'H4',
    'LABEL',
    'BUTTON',
    'A',
  ]);
  const aloneInRow = (el, rect) => {
    const parent = el.parentElement;
    if (!parent) return true;
    for (const sibling of parent.children) {
      if (sibling === el || !isShown(sibling)) continue;
      const other = sibling.getBoundingClientRect();
      const overlap = Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top);
      if (overlap > rect.height * 0.5 || overlap > other.height * 0.5) return false;
    }
    return true;
  };
  const narrowSeen = [];
  const walkNarrow = (el, depth) => {
    if (depth > 7 || !isShown(el) || inDialog(el)) return;
    const rect = el.getBoundingClientRect();
    const parent = el.parentElement;
    if (
      depth > 0 &&
      parent &&
      !SKIP_NARROW.has(el.tagName) &&
      blockish(el) &&
      rect.height >= 160 &&
      !el.closest('[data-empty-state]')
    ) {
      const parentStyle = getComputedStyle(parent);
      // Сетка в несколько колонок (правило W3) сама решает ширину карточки:
      // одна карточка в последнем ряду — её обычное состояние, а не узкая колонка.
      const tracks = parentStyle.display.includes('grid')
        ? parentStyle.gridTemplateColumns.split(/\s+/).filter(Boolean).length
        : 0;
      const parentRect = parent.getBoundingClientRect();
      const parentContent =
        parentRect.width -
        px(parentStyle.paddingLeft) -
        px(parentStyle.paddingRight) -
        px(parentStyle.borderLeftWidth) -
        px(parentStyle.borderRightWidth);
      // Пустует именно правая сторона (bug 3). Блок по центру ряда — намеренная
      // композиция (пустое состояние, заставка): его центровку меряет WE.
      const contentLeft =
        parentRect.left + px(parentStyle.paddingLeft) + px(parentStyle.borderLeftWidth);
      const leftGap = rect.left - contentLeft;
      const rightGap = contentLeft + parentContent - rect.right;
      if (
        tracks < 2 &&
        rightGap > leftGap + 2 * widthSlack &&
        parentContent >= availWidth * 0.85 &&
        rect.width < parentContent * 0.6 &&
        aloneInRow(el, rect)
      ) {
        narrowSeen.push(
          `${describe(el)} ${round(rect.width)}×${round(rect.height)} в ряду ${round(parentContent)}px`,
        );
        return; // вложенное внутри уже названного — тот же случай
      }
    }
    for (const child of el.children) walkNarrow(child, depth + 1);
  };
  if (!isFill) walkNarrow(wrapper, 0);
  for (const text of narrowSeen.slice(0, 4)) add('WN', `узкий блок: ${text}`);

  // ── WE: пустое состояние по центру своей коробки ──────────────────────────
  for (const empty of wrapper.querySelectorAll('[data-empty-state]')) {
    if (!isShown(empty)) continue;
    const rect = empty.getBoundingClientRect();
    // Коробка — ближайший предок с рамкой или фоном, иначе рамка раздела.
    let box = null;
    for (let node = empty.parentElement; node && node !== main; node = node.parentElement) {
      const style = getComputedStyle(node);
      const painted =
        px(style.borderLeftWidth) > 0 ||
        (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent');
      if (painted) {
        box = node;
        break;
      }
    }
    let left = availLeft;
    let right = availRight;
    if (box) {
      const boxRect = box.getBoundingClientRect();
      const style = getComputedStyle(box);
      left = boxRect.left + px(style.borderLeftWidth) + px(style.paddingLeft);
      right = boxRect.right - px(style.borderRightWidth) - px(style.paddingRight);
    }
    // Центр содержимого, а не бокса: бокс блочный и растянут, а съехать может
    // сама колонка значка и текста.
    const kids = [...empty.children].filter(isShown).map((el) => el.getBoundingClientRect());
    const contentLeft = Math.min(...kids.map((r) => r.left), rect.right);
    const contentRight = Math.max(...kids.map((r) => r.right), contentLeft);
    const centre = kids.length ? (contentLeft + contentRight) / 2 : (rect.left + rect.right) / 2;
    const target = (left + right) / 2;
    if (Math.abs(centre - target) > tol + 1) {
      add(
        'WE',
        `пустое состояние ${describe(empty)} смещено от центра на ${round(centre - target)}px`,
      );
    }
  }

  // ── H / H2: одна прокрутка на раздел ──────────────────────────────────────
  const mainOverflows = main.scrollHeight > main.clientHeight + 2;
  const availBottom = clientBottom - px(mainStyle.paddingBottom);
  // Обёртка может быть растянута колонкой — важен низ того, что в ней лежит.
  let contentBottom = -Infinity;
  for (const el of levelOne.length ? [...levelOne, ...levelTwo] : [wrapper]) {
    if (!isShown(el) || clippingAncestor(el, wrapper)) continue;
    contentBottom = Math.max(contentBottom, el.getBoundingClientRect().bottom);
  }
  const unusedBelow = availBottom - contentBottom;
  const SKIP_SCROLL = 'textarea, pre, code, .cm-editor, .cm-editor *, [data-scroll-own]';
  const scrollers = [...wrapper.querySelectorAll('*')].filter((el) => {
    if (el.matches(SKIP_SCROLL) || inDialog(el) || !isShown(el)) return false;
    const style = getComputedStyle(el);
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') return false;
    return el.scrollHeight > el.clientHeight + 2 && el.clientHeight >= 100;
  });
  for (const scroller of scrollers) {
    const hidden = scroller.scrollHeight - scroller.clientHeight;
    if (!mainOverflows && unusedBelow > 48) {
      add(
        'H',
        `внутренняя прокрутка ${describe(scroller)} (${round(scroller.clientHeight)}px, скрыто ${round(hidden)}px), а под ней пусто ${round(unusedBelow)}px`,
      );
    } else if (mainOverflows && scroller.clientHeight >= main.clientHeight * 0.3) {
      const floor = px(getComputedStyle(scroller).minHeight);
      if (isFill && floor > 0 && scroller.getBoundingClientRect().height <= floor + 2) continue;
      add(
        'H2',
        `две прокрутки: страница и ${describe(scroller)} (${round(scroller.clientHeight)}px, скрыто ${round(hidden)}px)`,
      );
    }
  }

  // ── C: одноимённые действия соседних строк — в одной колонке ──────────────
  // Действия и выбор, но не поля ввода: поле формы тянется на свою ширину
  // (рядом бывает кнопка «+»), это не колонка действий списка.
  const CONTROL =
    'button, [role="switch"], [role="checkbox"], a[href], select, input[type="checkbox"], input[type="radio"]';
  const controlKey = (el) => {
    const role = el.getAttribute('role');
    if (role === 'switch' || role === 'checkbox') return role;
    if (el.tagName === 'INPUT') return `input:${el.type}`;
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
      .trim()
      .split(/[\s:«"(]/)[0];
    return name ? `${el.tagName.toLowerCase()}:${name}` : null;
  };
  const listSeen = new Set();
  const scopes = [wrapper, ...dialogs];
  for (const scope of scopes) {
    for (const parent of [scope, ...scope.querySelectorAll('*')]) {
      if (listSeen.has(parent)) continue;
      const groups = new Map();
      for (const child of parent.children) {
        const cls = String(child.className?.baseVal ?? child.className ?? '');
        if (!cls || !isShown(child)) continue;
        const key = `${child.tagName}|${cls}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(child);
      }
      for (const group of groups.values()) {
        if (group.length < 3) continue;
        // Колонка действий общая только у строк, стоящих столбиком: тот же левый
        // край и та же ширина. Чипы в строке с переносом (цели контура: имя и
        // пометка в конце каждого) — одного класса, но ширина у каждого своя, и
        // пометка по праву стоит у своего правого края, а не в общей колонке.
        const stacks = [];
        for (const row of group) {
          const { left, width } = row.getBoundingClientRect();
          const stack = stacks.find(
            (s) => Math.abs(s.left - left) <= 2 && Math.abs(s.width - width) <= 2,
          );
          if (stack) stack.rows.push(row);
          else stacks.push({ left, width, rows: [row] });
        }
        const rows = stacks.sort((a, b) => b.rows.length - a.rows.length)[0].rows;
        if (rows.length < 2) continue;
        const columns = new Map();
        for (const row of rows) {
          const rowRect = row.getBoundingClientRect();
          // Строка — одна линия (не карточка сетки): иначе колонки не общие.
          if (rowRect.height > 120) continue;
          const perRow = new Map();
          for (const control of row.querySelectorAll(CONTROL)) {
            if (!isShown(control)) continue;
            const key = controlKey(control);
            if (!key || perRow.has(key)) continue;
            const rect = control.getBoundingClientRect();
            const centre = (rect.left + rect.right) / 2 - rowRect.left;
            // Действия строки живут в правой половине (правило R2). Кнопка-пометка
            // сразу за названием («4 файла») едет за его длиной — это содержимое.
            if (centre < rowRect.width / 2) continue;
            perRow.set(key, centre);
          }
          for (const [key, centre] of perRow) {
            if (!columns.has(key)) columns.set(key, []);
            columns.get(key).push(centre);
          }
        }
        for (const [key, centres] of columns) {
          if (centres.length < 2) continue;
          const spread = Math.max(...centres) - Math.min(...centres);
          if (spread > tol) {
            listSeen.add(parent);
            add(
              'C',
              `«${key.split(':').slice(1).join(':') || key}» пляшет по строкам ${describe(rows[0])} на ${round(spread)}px`,
            );
            break;
          }
        }
      }
    }
  }

  // ── V: строка заходит под следующую ───────────────────────────────────────
  // Только вертикальные стопки одинаковых соседей (один левый край, растущий
  // верх) и только дети строки в потоке: всплывающее абсолютное меню не в счёт.
  // Строка, которая обрезает лишнее (`overflow: hidden`), тоже попадает: её
  // содержимое срезано — тот же дефект, спрятанный от глаза.
  for (const scope of scopes) {
    for (const parent of [scope, ...scope.querySelectorAll('*')]) {
      const groups = new Map();
      for (const child of parent.children) {
        const cls = String(child.className?.baseVal ?? child.className ?? '');
        if (!cls || !isShown(child)) continue;
        const key = `${child.tagName}|${cls}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(child);
      }
      for (const rows of groups.values()) {
        if (rows.length < 3) continue;
        const sorted = rows
          .map((row) => ({ row, rect: row.getBoundingClientRect() }))
          .sort((a, b) => a.rect.top - b.rect.top);
        let count = 0;
        let worst = { over: 0, row: null };
        for (let index = 0; index < sorted.length - 1; index += 1) {
          const { row, rect } = sorted[index];
          const next = sorted[index + 1].rect;
          if (Math.abs(rect.left - next.left) > 1 || next.top <= rect.top + 1) continue;
          let bottom = rect.bottom;
          for (const child of row.children) {
            const position = getComputedStyle(child).position;
            if (!isShown(child) || (position !== 'static' && position !== 'relative')) continue;
            bottom = Math.max(bottom, child.getBoundingClientRect().bottom);
          }
          const over = bottom - next.top;
          if (over <= tol) continue;
          count += 1;
          if (over > worst.over) worst = { over, row };
        }
        if (count > 0) {
          add(
            'V',
            `строки ${describe(worst.row)} выше своего места: ${count} заходят под следующую, худшая на ${round(worst.over)}px`,
          );
        }
      }
    }
  }

  // ── R: центры ячеек одной строки таблицы ──────────────────────────────────
  // Коробка содержимого ячейки: текст и элементы управления, которые видно.
  // Текст внутри коробки в 1–2px — подпись для скринридера, её глаз не видит.
  const SOLID = 'img, svg, input, select, textarea, button, [role="switch"], [role="checkbox"]';
  const contentBox = (cell) => {
    let top = Infinity;
    let bottom = -Infinity;
    const take = (rect) => {
      if (rect.width <= 0 || rect.height <= 0) return;
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
    };
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.textContent.trim()) continue;
        const host = node.parentElement.getBoundingClientRect();
        if (host.width <= 2 || host.height <= 2) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) take(rect);
      } else if (node.matches(SOLID) && isShown(node)) {
        take(node.getBoundingClientRect());
      }
    }
    return top <= bottom ? { top, bottom } : null;
  };
  const CELL =
    'td, th, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]';
  const byTable = new Map();
  for (const scope of scopes) {
    for (const row of scope.querySelectorAll('tr, [role="row"]')) {
      if (!isShown(row)) continue;
      let cells = [...row.children].filter((el) => el.matches(CELL));
      if (cells.length === 0) cells = [...row.children];
      const centres = [];
      for (const cell of cells) {
        if (!isShown(cell)) continue;
        const box = contentBox(cell);
        if (!box) continue;
        centres.push({ cell, centre: (box.top + box.bottom) / 2 });
      }
      if (centres.length < 2) continue;
      const values = centres.map((entry) => entry.centre);
      const spread = Math.max(...values) - Math.min(...values);
      if (spread <= tol) continue;
      const table = row.closest('table, [role="table"], [role="grid"], [role="treegrid"]') ?? row;
      const worst = byTable.get(table);
      if (!worst) byTable.set(table, { row, spread, count: 1 });
      else {
        worst.count += 1;
        if (spread > worst.spread) Object.assign(worst, { row, spread });
      }
    }
  }
  for (const [table, worst] of byTable) {
    add(
      'R',
      `таблица ${describe(table)}: в ${worst.count} строк(ах) центры ячеек расходятся, худшая на ${round(worst.spread)}px («${clip(worst.row.textContent, 30)}»)`,
    );
  }

  // ── B: зазор под последним элементом у дна прокрутки ─────────────────────
  const lowestIn = (root, stop) => {
    let lowest = -Infinity;
    let lowestEl = null;
    for (const el of root.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.visibility === 'hidden') continue;
      // Показанная подсказка висит поверх содержимого, а не завершает его: у
      // последней строки она свисает к самому дну, и «Порядок работы» краснел
      // только тогда, когда наведение успевало до замера (28.09).
      if (el.closest('[role="tooltip"]')) continue;
      if (!rendered(el) || clippingAncestor(el, stop)) continue;
      if (rect.bottom > lowest) {
        lowest = rect.bottom;
        lowestEl = el;
      }
    }
    return { lowest, lowestEl };
  };
  const facts = {
    availWidth: round(availWidth),
    frame: round(frame),
    frameEl: describe(frameEl),
    mainOverflows,
    unusedBelow: round(unusedBelow),
    fill: isFill,
  };
  if (mainOverflows && !isFill) {
    const saved = main.scrollTop;
    main.scrollTop = main.scrollHeight;
    const { lowest, lowestEl } = lowestIn(wrapper, main);
    const gap = clientBottom - lowest;
    facts.bottomGap = round(gap);
    // Допуск 1px: дробные высоты строк дают 23,6 при честных 24 (узкий экран).
    if (gap < minBottomGap - 1) {
      add(
        'B',
        `последний элемент ${lowestEl ? describe(lowestEl) : '?'} в ${round(gap)}px от низа окна (нужно ≥ ${minBottomGap})`,
      );
    }
    main.scrollTop = saved;
  }
  for (const dialog of dialogs) {
    const bodies = [dialog, ...dialog.querySelectorAll('*')].filter((el) => {
      const style = getComputedStyle(el);
      if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') return false;
      if (el.matches(SKIP_SCROLL)) return false;
      // Список в рамке (своя нижняя граница): конец виден по рамке, а отступ
      // внутри — его собственный, как у списка выбора. Меряются тела окон и
      // списки без рамки — у них низ ничем не отмечен.
      if (px(style.borderBottomWidth) > 0 && style.borderBottomStyle !== 'none') return false;
      return el.scrollHeight > el.clientHeight + 2 && el.clientHeight >= 100;
    });
    for (const body of bodies) {
      const saved = body.scrollTop;
      body.scrollTop = body.scrollHeight;
      const rect = body.getBoundingClientRect();
      const bottom = rect.top + body.clientTop + body.clientHeight;
      const { lowest, lowestEl } = lowestIn(body, body);
      const gap = bottom - lowest;
      if (gap < minDialogGap - 1) {
        add(
          'B',
          `тело окна ${describe(dialog)}, прокрутка ${trail(body)}: последний элемент ${lowestEl ? describe(lowestEl) : '?'} в ${round(gap)}px от низа (нужно ≥ ${minDialogGap})`,
        );
      }
      body.scrollTop = saved;
    }
  }

  return { issues, facts };
}
