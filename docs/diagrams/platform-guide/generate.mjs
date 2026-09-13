/**
 * Схемы путеводителя «Контур». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/platform-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают — ширина коробки
 * считается по её тексту, высота строки ряда выравнивается по самой высокой
 * карточке, а положение подписи ребра решается перебором свободных мест. Ни
 * одно из трёх в рукописном XML не держится.
 *
 * Четыре страницы, и все компактные по ширине намеренно: экспорт уезжает в
 * документ справки, который читают в том числе с телефона. Плотный
 * информационный лист того же скилла здесь был бы нечитаем — это осознанное
 * отступление от его умолчания, а не забывчивость.
 *
 * Страница 1 — путь запроса сверху вниз: CLI → шлюз панели → контур → модель.
 * Страница 2 — что заводится в админке контура, а что в панели.
 * Страница 3 — две системы рядом: части панели против сервисов инстанса
 *              платформа компании и три стрелки, которые переходят границу между ними.
 * Страница 4 — вызов инструмента через прослойку шлюза: туда текстом, обратно
 *              вызовом, и что не исполняется никогда.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const geom = await import(
  pathToFileURL(join(homedir(), '.claude/skills/drawio-architect/scripts/geom.mjs')).href
);
const { labelSize, placeLabel, orthogonalize } = geom;

const OUT = process.argv[2];
if (!OUT) throw new Error('нужен абсолютный путь к .drawio первым аргументом');

const G = 10;
const r10 = (n) => Math.round(n / G) * G;
const safe = (s) => String(s).replace(/[<>&]/g, ' ');
const esc = (s) =>
  String(s)
    .replace(/&(?![a-z#]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Палитра скилла: один смысл — один цвет, и каждый цвет попадает в легенду. */
const C = {
  actor: { tint: '#E8F5E9', line: '#43A047', ink: '#1B5E20' },
  front: { tint: '#EDE7F6', line: '#7E57C2', ink: '#4527A0' },
  edge: { tint: '#FCE4EC', line: '#EC407A', ink: '#AD1457' },
  svc: { tint: '#E3F2FD', line: '#42A5F5', ink: '#1565C0' },
  ext: { tint: '#ECEFF1', line: '#78909C', ink: '#37474F' },
  store: { tint: '#FFF3E0', line: '#FB8C00', ink: '#EF6C00' },
  note: { tint: '#FFFDE7', line: '#F9A825', ink: '#EF6C00' },
  warn: { tint: '#FFEBEE', line: '#E53935', ink: '#B71C1C' },
};
const FLOW = { client: '#1565C0', back: '#78909C', data: '#6D4C41', admin: '#EF6C00' };

const cardStyle = (pal, weight = 2) =>
  `rounded=1;arcSize=12;fillColor=${pal.tint};strokeColor=${pal.line};strokeWidth=${weight};` +
  'html=1;whiteSpace=wrap;align=left;verticalAlign=top;spacing=6;fontSize=9;fontColor=#37474F;';
const iconStyle = (shape, pal) =>
  `${shape};fillColor=#FFFFFF;strokeColor=${pal.line};html=1;whiteSpace=wrap;align=center;` +
  `verticalAlign=bottom;fontSize=7;fontColor=${pal.ink};informational=1;`;
const frameStyle = (pal) =>
  `rounded=1;arcSize=2;fillColor=${pal.tint};strokeColor=${pal.line};strokeWidth=3;html=1;` +
  'verticalAlign=top;align=left;container=1;collapsible=0;informational=1;';
const tabStyle = (pal) =>
  `rounded=0;fillColor=${pal.line};strokeColor=none;html=1;whiteSpace=wrap;align=left;` +
  'verticalAlign=middle;spacingLeft=10;fontSize=12;fontStyle=1;fontColor=#FFFFFF;informational=1;';
const textStyle = (size, colour, bold) =>
  `text;html=1;whiteSpace=wrap;align=left;verticalAlign=middle;fontSize=${size};` +
  `fontColor=${colour};${bold ? 'fontStyle=1;' : ''}`;
const edgeStyle = (colour, dashed) =>
  'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;fontSize=9;fontColor=#37474F;' +
  `labelBackgroundColor=#FFFFFF;endArrow=blockThin;endFill=1;jettySize=auto;strokeWidth=2;strokeColor=${colour};` +
  (dashed ? 'dashed=1;dashPattern=6 4;' : '');

/** Одна страница = свой набор ячеек и свой указатель. */
function newPage(name, id) {
  return { name, id, cells: [], V: new Map(), edges: [], solids: [] };
}

function put(p, id, value, style, rect, parent) {
  const r = { x: r10(rect.x), y: r10(rect.y), w: r10(rect.w), h: r10(rect.h) };
  const base = parent ? p.V.get(parent) : null;
  // Значение уезжает в атрибут XML целиком экранированным: разметка карточки —
  // это HTML ВНУТРИ атрибута, и незакрытый по правилам XML `<div>` ломает файл
  // на разборе, хотя в редакторе выглядит нормально.
  p.cells.push(
    `        <mxCell id="${id}" value="${esc(value)}" style="${style}" vertex="1" parent="${parent ?? '1'}">\n` +
      `          <mxGeometry x="${r.x - (base?.x ?? 0)}" y="${r.y - (base?.y ?? 0)}" width="${r.w}" height="${r.h}" as="geometry"/>\n` +
      '        </mxCell>',
  );
  const v = { id, ...r, cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
  p.V.set(id, v);
  return v;
}

/** Символов в строке при ширине w и кегле fs — метрика та же, что в скилле. */
const cpl = (w, fs) => Math.max(10, Math.floor((w - 22) / (fs * 0.5)));
const linesH = (arr, w, fs) =>
  arr.reduce((a, l) => a + Math.max(1, Math.ceil(safe(l).length / cpl(w, fs))) * (fs + 4), 0);
const bodyHtml = (title, lines, ink) =>
  `<div style="font-size:10px;font-weight:600;color:${ink};text-align:left">${title}</div>` +
  lines.map((l) => `<div style="font-size:9px;text-align:left;margin-top:4px">${l}</div>`).join('');

/** Высота карточки считается по тексту, а не назначается на глаз. */
const cardH = (spec, w) =>
  Math.max(
    spec.icon ? 70 : 40,
    Math.ceil((12 + 16 + linesH(spec.lines, w - (spec.icon ? 56 : 12), 9) + 10) / G) * G,
  );

function card(p, id, x, y, w, spec) {
  const pal = spec.pal;
  const h = spec.h ?? cardH(spec, w);
  const style =
    cardStyle(pal, spec.weight) + (spec.icon ? 'spacingLeft=50;' : '') + 'informational=1;';
  const v = put(p, id, bodyHtml(spec.title, spec.lines, pal.ink), style, { x, y, w, h });
  if (spec.icon) {
    put(p, `${id}:icon`, spec.iconText ?? '', iconStyle(spec.icon, pal), {
      x: x + 10,
      y: y + 10,
      w: 36,
      h: 46,
    });
    // Иконка — ребёнок карточки: иначе проверка увидит две коробки, лежащие
    // одна на другой, и будет права.
    p.cells[p.cells.length - 1] = p.cells[p.cells.length - 1].replace(
      `parent="1"`,
      `parent="${id}"`,
    );
    const iv = p.V.get(`${id}:icon`);
    p.cells[p.cells.length - 1] = p.cells[p.cells.length - 1].replace(
      /<mxGeometry x="\d+" y="\d+"/,
      `<mxGeometry x="${iv.x - v.x}" y="${iv.y - v.y}"`,
    );
  }
  if (!spec.soft) p.solids.push(v);
  return v;
}

/** Нижний край всего, что уже стоит на странице: под ним начинается легенда. */
const bottomOf = (p) => Math.max(...[...p.V.values()].map((v) => v.y + v.h));

function link(p, from, to, label, opts = {}) {
  p.edges.push({ from, to, label, ...opts });
}

/**
 * Легенда строгой сеткой: плашка 50×20, подпись на той же строке, шаг 30.
 * Каждая ячейка помечена `sample=1` — это и есть признак ключа для проверки.
 */
function legend(p, x, y, items) {
  const capW = Math.max(...items.map((it) => safe(it.caption).length)) * 5.6 + 16;
  put(p, `${p.id}:legend:title`, 'Обозначения', textStyle(11, '#37474F', true), {
    x,
    y,
    w: 60 + capW,
    h: 20,
  });
  items.forEach((it, i) => {
    const ry = y + 30 + i * 30;
    if (it.edgeColour) {
      p.cells.push(
        `        <mxCell id="${p.id}:legend:sw${i}" value="" style="${edgeStyle(it.edgeColour, it.dashed)}sample=1;" edge="1" parent="1">\n` +
          `          <mxGeometry relative="1" as="geometry">\n` +
          `            <mxPoint x="${x}" y="${ry + 10}" as="sourcePoint"/>\n` +
          `            <mxPoint x="${x + 50}" y="${ry + 10}" as="targetPoint"/>\n` +
          `          </mxGeometry>\n` +
          '        </mxCell>',
      );
    } else if (it.stage) {
      // Ключ колонки показывает ДВЕ плашки: заливку рамки и её акцент. Оба
      // цвета на странице есть, и проверка требует ключ на каждый.
      put(
        p,
        `${p.id}:legend:sw${i}`,
        '',
        `rounded=1;arcSize=12;fillColor=${it.stage.tint};strokeColor=${it.stage.line};strokeWidth=2;html=1;sample=1;`,
        { x, y: ry, w: 30, h: 20 },
      );
      put(
        p,
        `${p.id}:legend:sw${i}b`,
        '',
        `rounded=0;fillColor=${it.stage.line};strokeColor=none;html=1;sample=1;`,
        { x: x + 30, y: ry, w: 20, h: 20 },
      );
    } else {
      put(
        p,
        `${p.id}:legend:sw${i}`,
        '',
        `rounded=1;arcSize=12;fillColor=${it.fill};strokeColor=${it.stroke};strokeWidth=2;html=1;sample=1;`,
        { x, y: ry, w: 50, h: 20 },
      );
    }
    put(
      p,
      `${p.id}:legend:cap${i}`,
      it.caption,
      `${textStyle(9, '#546E7A')}verticalAlign=middle;sample=1;`,
      { x: x + 60, y: ry, w: capW, h: 20 },
    );
  });
  return y + 30 + items.length * 30;
}

/** Заголовок страницы. */
function heading(p, x, y, title, subtitle, w) {
  put(p, `${p.id}:title`, title, textStyle(20, '#1A237E', true), { x, y, w, h: 30 });
  put(p, `${p.id}:sub`, subtitle, textStyle(11, '#546E7A'), { x, y: y + 34, w, h: 30 });
}

/**
 * Маршруты и подписи: сначала ВСЕ маршруты, и только потом подписи.
 *
 * Порядок здесь не косметический. Подпись обязана обходить не только коробки и
 * уже поставленные подписи, но и каждую линию страницы — включая те, которых в
 * момент её постановки ещё не существовало бы, считай мы рёбра по одному.
 * Именно так проверяет сторож: он видит готовый файл целиком.
 */
function routeEdges(p) {
  const placed = [];
  const laid = p.edges.map((e) => {
    const s = p.V.get(e.from);
    const t = p.V.get(e.to);
    const start = { x: s.x + (e.exit?.[0] ?? 0.5) * s.w, y: s.y + (e.exit?.[1] ?? 1) * s.h };
    const end = { x: t.x + (e.entry?.[0] ?? 0.5) * t.w, y: t.y + (e.entry?.[1] ?? 0) * t.h };
    return { e, route: orthogonalize([start, ...(e.points ?? []), end], e.startDir) };
  });

  for (const { e, route } of laid) {
    // Препятствия — ВСЕ коробки страницы, включая концы самого ребра: подпись,
    // залезшая на свою же карточку, читается ничуть не лучше чужой. Рамка-
    // контейнер считается только своей шапкой в 34 пикселя — ровно так же
    // считает сторож, и два счёта обязаны совпадать.
    const obstacles = [...p.V.values()]
      .map((v) => (v.container ? { id: v.id, x: v.x, y: v.y, w: v.w, h: 34 } : v))
      .concat(placed);
    const others = laid.filter((other) => other.route !== route).map((other) => other.route);
    let pick = null;
    for (const width of [34, 26, 20, 15]) {
      const text = wrap(e.label, width);
      const size = labelSize(text.split('\n').join('<br>'), 9);
      const spot = placeLabel(route, size, { rects: obstacles, lines: others });
      if (spot?.clear) {
        pick = { text, spot };
        break;
      }
      if (!pick) pick = { text, spot };
    }
    placed.push({ id: `label:${e.from}`, ...pick.spot.rect });
    const points = route
      .slice(1, -1)
      .map((q) => `            <mxPoint x="${Math.round(q.x)}" y="${Math.round(q.y)}"/>`)
      .join('\n');
    const style =
      edgeStyle(e.colour ?? FLOW.client, e.dashed) +
      `exitX=${e.exit?.[0] ?? 0.5};exitY=${e.exit?.[1] ?? 1};exitDx=0;exitDy=0;` +
      `entryX=${e.entry?.[0] ?? 0.5};entryY=${e.entry?.[1] ?? 0};entryDx=0;entryDy=0;`;
    p.cells.push(
      `        <mxCell id="edge:${e.from}:${e.to}" value="${esc(pick.text).replace(/\n/g, '&lt;br&gt;')}" style="${style}" edge="1" parent="1" source="${e.from}" target="${e.to}">\n` +
        `          <mxGeometry relative="1" x="${pick.spot.x}" y="${pick.spot.y}" as="geometry">\n` +
        (points ? `            <Array as="points">\n${points}\n            </Array>\n` : '') +
        '          </mxGeometry>\n' +
        '        </mxCell>',
    );
    if (!pick.spot.clear) {
      console.error(`подпись «${e.label}» поставлена с наложением — поправь коридор`);
    }
  }
}

function wrap(text, width) {
  const words = String(text).split(' ');
  const lines = [''];
  for (const word of words) {
    const line = lines[lines.length - 1];
    if (line && (line + ' ' + word).length > width) lines.push(word);
    else lines[lines.length - 1] = line ? `${line} ${word}` : word;
  }
  return lines.join('\n');
}

// ─── Страница 1: путь запроса ──────────────────────────────────────────────

const p1 = newPage('1. Путь запроса через контур', 'p1');
heading(
  p1,
  60,
  30,
  'Путь запроса через контур',
  'Сверху вниз — то, что происходит с одним сообщением. Ключ на этом пути есть ровно в одном месте.',
  760,
);

const SPINE_X = 260;
const SPINE_W = 300;
const RIGHT_X = 760;
const RIGHT_W = 290;

const cli = card(p1, 'p1:cli', SPINE_X, 130, SPINE_W, {
  pal: C.actor,
  icon: 'shape=card',
  iconText: 'CLI',
  title: 'Агентный CLI или ассистент панели',
  lines: [
    'Claude Code, Codex, Qwen Code и ещё шесть.',
    'В конфигурации CLI стоит адрес шлюза, ключа контура там нет.',
  ],
});

const gw = card(p1, 'p1:gw', SPINE_X, cli.y + cli.h + 110, SPINE_W, {
  pal: C.edge,
  icon: 'shape=hexagon',
  iconText: 'API',
  title: 'Локальный шлюз панели',
  lines: [
    'Слушатель процесса самой панели на 127.0.0.1.',
    'Адрес — /<идентификатор контура>/v1, отсюда требование к латинице.',
  ],
});

const contour = card(p1, 'p1:contour', SPINE_X, gw.y + gw.h + 110, SPINE_W, {
  pal: C.ext,
  icon: 'shape=cloud',
  iconText: 'вне',
  title: 'Контур: публичный API платформы',
  lines: [
    '/v1/models, /v1/chat/completions, /v1/embeddings.',
    'Проверки контента работают в полосе запроса: отказ приходит статусом 451.',
  ],
});

const model = card(p1, 'p1:model', SPINE_X, contour.y + contour.h + 110, SPINE_W, {
  pal: C.svc,
  icon: 'shape=process',
  iconText: 'LLM',
  title: 'Модель контура',
  lines: [
    'Та, что разрешена правами ключа: список приходит уже суженным.',
    'Расход считает контур; панель показывает свою оценку и называет её оценкой.',
  ],
});

card(p1, 'p1:key', RIGHT_X, gw.y - 10, RIGHT_W, {
  pal: C.store,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'key',
  title: 'Ключ контура',
  lines: [
    'Лежит в панели зашифрованным. Ни в ответе API, ни в промпте, ни в логе, ни в конфигурации CLI его нет — наружу уходит маска.',
  ],
});

card(p1, 'p1:off', RIGHT_X, contour.y, RIGHT_W, {
  pal: C.warn,
  soft: true,
  title: 'Панель выключена — шлюз закрыт',
  lines: [
    'CLI, направленный на шлюз, останется без модели: он получит отказ. Тихого возврата в облако вендора не будет — это подписанный компромисс, а не сбой.',
  ],
});

card(p1, 'p1:dialect', RIGHT_X, model.y, RIGHT_W, {
  pal: C.note,
  soft: true,
  title: 'Не всякий CLI умеет говорить со шлюзом',
  lines: [
    'Gemini CLI говорит на своём диалекте. В списке потребителей он стоит с этой причиной, а не молча не работает.',
  ],
});

link(p1, 'p1:cli', 'p1:gw', 'запрос по OpenAI-совместимому протоколу', { colour: FLOW.client });
link(p1, 'p1:gw', 'p1:contour', 'тот же запрос, ключ подставлен шлюзом', { colour: FLOW.client });
link(p1, 'p1:contour', 'p1:model', 'маршрут по имени модели', { colour: FLOW.client });
link(p1, 'p1:key', 'p1:gw', 'ключ из хранилища', {
  colour: FLOW.data,
  exit: [0, 0.5],
  entry: [1, 0.5],
});
link(p1, 'p1:model', 'p1:cli', 'ответ возвращается тем же путём', {
  colour: FLOW.back,
  dashed: true,
  exit: [0, 0.5],
  entry: [0, 0.5],
  points: [
    { x: 110, y: model.cy },
    { x: 110, y: cli.cy },
  ],
  startDir: 'h',
});

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'потребитель: CLI или ассистент панели', fill: C.actor.tint, stroke: C.actor.line },
  {
    caption: 'шлюз панели — единственное место, где ключ подставляется',
    fill: C.edge.tint,
    stroke: C.edge.line,
  },
  { caption: 'внешняя система: контур компании', fill: C.ext.tint, stroke: C.ext.line },
  { caption: 'модель и другие службы контура', fill: C.svc.tint, stroke: C.svc.line },
  { caption: 'хранилище панели', fill: C.store.tint, stroke: C.store.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'ограничение, о котором сказано прямо', fill: C.warn.tint, stroke: C.warn.line },
  {
    caption: 'значок формы: карточка, шлюз, облако, служба, хранилище',
    fill: '#FFFFFF',
    stroke: C.ext.line,
  },
  { caption: 'запрос вперёд', edgeColour: FLOW.client },
  { caption: 'ответ обратно', edgeColour: FLOW.back, dashed: true },
  { caption: 'чтение из хранилища', edgeColour: FLOW.data },
]);

// ─── Страница 2: что где заводится ─────────────────────────────────────────

const p2 = newPage('2. Что заводится в админке, а что в панели', 'p2');
heading(
  p2,
  60,
  30,
  'Что заводится в админке контура, а что в панели',
  'Панель не пишет в контур ничего: всё, что слева, делает администратор руками. Через границу переходят две строки.',
  900,
);

const COL_W_DEFAULT = 420;
const COL_A_X = 60;
const COL_B_X = 700;
const COL_Y_DEFAULT = 130;

/**
 * Колонка-рамка с вкладкой-заголовком и белыми панелями внутри.
 *
 * Ширина и верх по умолчанию взяты со второй страницы; третья задаёт свои
 * через `opts` — колонки там шире и стоят ниже, потому что в них не по четыре
 * панели, а по шесть.
 */
function column(p, id, pal, x, title, subtitle, panes, opts = {}) {
  const COL_W = opts.w ?? COL_W_DEFAULT;
  const COL_Y = opts.y ?? COL_Y_DEFAULT;
  const frame = put(p, id, '', frameStyle(pal), { x, y: COL_Y, w: COL_W, h: 9990 });
  frame.container = true;
  const frameIdx = p.cells.length - 1;
  put(p, `${id}:tab`, `${title}<div style="font-size:9px">${subtitle}</div>`, tabStyle(pal), {
    x: x + 10,
    y: COL_Y + 10,
    w: COL_W - 20,
    h: 44,
  });
  // Вкладка — ребёнок рамки: положенная поверх соседом, она была бы наложением.
  p.cells[p.cells.length - 1] = p.cells[p.cells.length - 1].replace('parent="1"', `parent="${id}"`);
  const tv = p.V.get(`${id}:tab`);
  p.cells[p.cells.length - 1] = p.cells[p.cells.length - 1].replace(
    /<mxGeometry x="-?\d+" y="-?\d+"/,
    `<mxGeometry x="${tv.x - frame.x}" y="${tv.y - frame.y}"`,
  );

  let cursor = COL_Y + 70;
  for (const pane of panes) {
    const w = COL_W - 40;
    const h = cardH(pane, w);
    const v = put(
      p,
      pane.id,
      bodyHtml(pane.title, pane.lines, pal.ink),
      `${cardStyle({ tint: '#FFFFFF', line: pal.line, ink: pal.ink }, 1)}` +
        (pane.icon ? 'spacingLeft=50;' : '') +
        'informational=1;',
      { x: x + 20, y: cursor, w, h },
      id,
    );
    // Хранилище остаётся цилиндром и внутри колонки: форма здесь несёт смысл,
    // и подменять её прямоугольником ради удобства раскладки нельзя.
    if (pane.icon) {
      const iv = put(p, `${pane.id}:icon`, pane.iconText ?? '', iconStyle(pane.icon, pal), {
        x: v.x + 10,
        y: v.y + 10,
        w: 36,
        h: 46,
      });
      p.cells[p.cells.length - 1] = p.cells[p.cells.length - 1]
        .replace('parent="1"', `parent="${pane.id}"`)
        .replace(
          /<mxGeometry x="-?\d+" y="-?\d+"/,
          `<mxGeometry x="${iv.x - v.x}" y="${iv.y - v.y}"`,
        );
    }
    p.solids.push(v);
    cursor += h + 20;
  }
  const height = cursor - COL_Y;
  p.cells[frameIdx] = p.cells[frameIdx].replace('height="9990"', `height="${r10(height)}"`);
  const fv = p.V.get(id);
  fv.h = r10(height);
  fv.cy = fv.y + fv.h / 2;
  return fv;
}

const colA = column(
  p2,
  'p2:admin',
  C.edge,
  COL_A_X,
  'Админка контура',
  'делает администратор инстанса',
  [
    {
      id: 'p2:model',
      title: 'Модель',
      lines: [
        'Название, ссылка на модель у провайдера, длина контекста. Нативный API провайдера указывается без /v1 — лишний хвост отвечает «404 page not found» уже внутри ответа модели.',
      ],
    },
    {
      id: 'p2:key',
      title: 'Ключ',
      lines: [
        'Выпускается с бюджетом и лимитами RPM и TPM. Показывается ровно один раз: потерян — значит выпустить новый.',
      ],
    },
    {
      id: 'p2:access',
      title: 'Доступ ключа к моделям',
      lines: [
        'Сужает то, что панель увидит пробой. Ключ получает не весь каталог инстанса, а свой список.',
      ],
    },
    {
      id: 'p2:usage',
      title: 'Использование',
      lines: [
        'Расход по моделям и ключам считает контур. Это исходные цифры, с которыми сверяется оценка панели.',
      ],
    },
  ],
);

const colB = column(p2, 'p2:panel', C.front, COL_B_X, 'Панель', 'делает тот, кто ей пользуется', [
  {
    id: 'p2:wizard',
    title: 'Мастер: адрес и ключ',
    lines: [
      'Два поля из админки и больше ничего. Идентификатор собирается латиницей — из него строится адрес локального шлюза.',
    ],
  },
  {
    id: 'p2:probe',
    title: 'Проба',
    lines: [
      'К контуру ходит сервер панели по сохранённому черновику, а не браузер. Контур остаётся выключенным до последнего шага.',
    ],
  },
  {
    id: 'p2:gateway',
    title: 'Шлюз',
    lines: [
      'Поднимается кнопкой мастера. Пока не поднят, применять к CLI нечего — у каждого потребителя стоит прочерк с этой причиной.',
    ],
  },
  {
    id: 'p2:targets',
    title: 'Потребители',
    lines: [
      'Ассистент панели, Claude Code и восемь CLI. Применение правит их конфигурации, копия «до» уходит в раздел «История».',
    ],
  },
]);

card(p2, 'p2:note', COL_A_X, Math.max(colA.y + colA.h, colB.y + colB.h) + 40, COL_W_DEFAULT + 600, {
  pal: C.note,
  soft: true,
  title: 'Границу переходят ровно две строки',
  lines: [
    'Адрес публичного API и ключ. Всё остальное панель выясняет пробой и показывает как ответ контура, а не как собственное знание: непроверенное стоит словами «не объявлено», а не галкой.',
  ],
});

link(p2, 'p2:key', 'p2:wizard', 'ключ переносится один раз', {
  colour: FLOW.admin,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p2, 'p2:access', 'p2:probe', 'проба спрашивает список ключа', {
  colour: FLOW.client,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p2, 'p2:gateway', 'p2:usage', 'запросы попадают в учёт контура', {
  colour: FLOW.data,
  exit: [0, 0.5],
  entry: [1, 0.5],
  // Точка в середине коридора: без неё обратный путь спускается вплотную к
  // правой границе карточки и стрелка читается как оборванная.
  points: [
    { x: (COL_A_X + COL_W_DEFAULT + COL_B_X) / 2, y: p2.V.get('p2:gateway').cy },
    { x: (COL_A_X + COL_W_DEFAULT + COL_B_X) / 2, y: p2.V.get('p2:usage').cy },
  ],
  startDir: 'h',
});

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'сторона контура: админка инстанса', stage: C.edge },
  { caption: 'сторона панели', stage: C.front },
  { caption: 'что именно заводится на этой стороне', fill: '#FFFFFF', stroke: C.edge.line },
  { caption: 'то же самое на стороне панели', fill: '#FFFFFF', stroke: C.front.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'переносится руками, один раз', edgeColour: FLOW.admin },
  { caption: 'спрашивает панель', edgeColour: FLOW.client },
  { caption: 'учёт расхода', edgeColour: FLOW.data },
]);

// ─── Страница 3: две системы рядом ─────────────────────────────────────────

/**
 * Названия сервисов контура — настоящие, из `docs/SERVICE_INVENTORY.md` самой
 * платформа компании, а не придуманные для картинки. Это важно ровно по той же причине,
 * по которой в панели не показывается «угаданная» возможность: человек, у
 * которого контур не отвечает, идёт с этой схемой к своему администратору, и
 * названия должны совпасть с тем, что тот видит у себя.
 */
const p3 = newPage('3. Две системы рядом', 'p3');
heading(
  p3,
  60,
  30,
  'Панель и контур: кто чем занят',
  'Слева — всё, что происходит на вашей машине. Справа — сервисы инстанса платформа компании. Границу переходят три стрелки, и ни одна из них не ведёт в обратную сторону сама.',
  1160,
);

const P3_Y = 150;
const P3_W = 520;
const P3_A_X = 60;
const P3_B_X = 860;

const zonePanel = column(
  p3,
  'p3:panel',
  C.front,
  P3_A_X,
  'Ваша машина',
  'один процесс панели, 127.0.0.1',
  [
    {
      id: 'p3:cli',
      title: 'Потребители: девять CLI и ассистент панели',
      lines: [
        'В их конфигурации стоит только адрес локального шлюза вида http://127.0.0.1:5179/&lt;контур&gt;/v1. Ключа контура там нет.',
      ],
    },
    {
      id: 'p3:gwl',
      title: 'Локальный шлюз панели',
      lines: [
        'Слушатель процесса самой панели. Принимает запрос по OpenAI-совместимому протоколу, подставляет ключ и считает токены обеих сторон.',
      ],
    },
    {
      id: 'p3:driver',
      title: 'Реестр контуров и драйвер enterprise-platform',
      lines: [
        'Помнит адрес, режим и возможности контура. Драйвер знает диалект платформы: где у неё каталог моделей, эмбеддинги и агенты и как она отвечает на отказ.',
      ],
    },
    {
      id: 'p3:keys',
      title: 'Зашифрованное хранилище ключей',
      lines: [
        'Ключ лежит здесь и только здесь. Ни в ответе API, ни в промпте, ни в логе, ни в конфигурации CLI его нет — наружу уходит маска.',
      ],
    },
    {
      id: 'p3:spend',
      title: 'Расход и бюджет',
      lines: [
        'Расход — ОЦЕНКА по нашему справочнику цен, со знаком «≈». Бюджет вводится руками: маршрута для остатка у платформы нет.',
      ],
    },
    {
      id: 'p3:apply',
      title: 'Применение к конфигурациям',
      lines: [
        'Правит файлы потребителей, копию «до» кладёт в раздел «История», у каждой записи своя кнопка отката.',
      ],
    },
  ],
  { y: P3_Y, w: P3_W },
);

const zoneContour = column(
  p3,
  'p3:contour',
  C.edge,
  P3_B_X,
  'Контур компании',
  'инстанс платформа компании, развёрнутый у вас',
  [
    {
      id: 'p3:ui',
      title: 'inst-admin-ui — админка инстанса',
      lines: [
        'Здесь администратор заводит модель, выпускает ключ и смотрит «Использование». Панель в админку не ходит вовсе: всё, что из неё нужно, переносится руками.',
      ],
    },
    {
      id: 'p3:gwi',
      title: 'inst-gateway — единая точка входа',
      lines: [
        'Раскладывает пути по сервисам инстанса: /v1/* — публичный API, /api/v1/* — админский, /user/v1/* — пользовательский.',
      ],
    },
    {
      id: 'p3:api',
      title: 'inst-api — публичный API /v1/*',
      lines: [
        'Совместим с OpenAI: chat/completions, embeddings, models. Разбирает ключ, сверяет его лимиты и отвечает 401 сразу пятью возможными причинами — какая именно, снаружи не различить.',
      ],
    },
    {
      id: 'p3:admin',
      title: 'inst-admin-api — модели, ключи, учёт',
      lines: [
        'Держит каталог моделей и ключи, принимает расход от mod-llmbox. Именно его список видит проба панели — суженный правами вашего ключа.',
      ],
    },
    {
      id: 'p3:llm',
      title: 'mod-llmbox — вызов модели',
      lines: [
        'LiteLLM Router: ходит к провайдеру и считает стоимость по ценам реестра инстанса. С нашей оценкой сходится как порядок величины, а не копейка в копейку.',
      ],
    },
    {
      id: 'p3:boxes',
      title: 'mod-guardrailsbox, mod-kbbox, mod-agentbox',
      lines: [
        'Проверки контента, базы знаний и агенты платформы. Их вызывает сам контур на своей стороне; панель показывает результат, но ни одного из них не вызывает.',
      ],
    },
    {
      id: 'p3:store',
      title: 'Хранилища инстанса',
      icon: 'shape=cylinder3;boundedLbl=1;backgroundOutline=1',
      iconText: 'DB',
      lines: [
        'Postgres, Redis, MinIO, Qdrant. Панель в них не ходит и об их существовании ничего не предполагает.',
      ],
    },
  ],
  { y: P3_Y, w: P3_W },
);

card(p3, 'p3:vendor', P3_B_X + P3_W + 60, p3.V.get('p3:llm').y, 280, {
  pal: C.ext,
  icon: 'shape=cloud',
  iconText: 'LLM',
  title: 'Провайдеры моделей',
  lines: ['vLLM, Ollama, вендорское облако. Это уже не контур: до них доходит его ключ, а не ваш.'],
});

card(
  p3,
  'p3:note',
  P3_A_X,
  Math.max(zonePanel.y + zonePanel.h, zoneContour.y + zoneContour.h) + 40,
  P3_W + 60 + P3_W + 60 + 280 - 60,
  {
    pal: C.note,
    soft: true,
    title: 'Что НЕ переходит границу',
    lines: [
      'Остаток бюджета и расход контура панель не читает — их маршрута у платформы нет, поэтому бюджет вводится руками, а расход панель считает сама и помечает «≈». Инструменты и MCP-серверы вашей машины контуру не отдаются: платформа собирает набор инструментов сама, по модели и правам ключа. И ни одна правка не уходит в контур: панель не создаёт в нём ни моделей, ни ключей.',
    ],
  },
);

// У каждой пересекающей границу стрелки своя полоса в коридоре между зонами:
// пущенные по одной, они ложатся друг на друга, и различить их можно только по
// цвету — а на распечатке уже никак.
const LANE_HAND = P3_A_X + P3_W + 40;
const LANE_BACK = P3_A_X + P3_W + 240;

link(p3, 'p3:ui', 'p3:driver', 'адрес и ключ — переносятся руками, один раз', {
  colour: FLOW.admin,
  exit: [0, 0.5],
  entry: [1, 0.5],
  points: [
    { x: LANE_HAND, y: p3.V.get('p3:ui').cy },
    { x: LANE_HAND, y: p3.V.get('p3:driver').cy },
  ],
  startDir: 'h',
});
link(p3, 'p3:gwl', 'p3:gwi', 'запрос по ключу контура', {
  colour: FLOW.client,
  exit: [1, 0.5],
  entry: [0, 0.5],
  startDir: 'h',
});
// Ответ возвращается ровно туда, откуда ушёл запрос, — в шлюз панели. Довести
// эту стрелку сразу до «Расхода» было бы короче и неправдой: токены считает
// шлюз, а расход из них складывает уже панель, у себя.
link(p3, 'p3:api', 'p3:gwl', 'ответ модели и число токенов', {
  colour: FLOW.back,
  dashed: true,
  exit: [0, 0.8],
  entry: [1, 0.8],
  points: [
    { x: LANE_BACK, y: p3.V.get('p3:api').y + p3.V.get('p3:api').h * 0.8 },
    { x: LANE_BACK, y: p3.V.get('p3:gwl').y + p3.V.get('p3:gwl').h * 0.8 },
  ],
  startDir: 'h',
});
link(p3, 'p3:gwi', 'p3:api', 'путь /v1/*', {
  colour: FLOW.client,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p3, 'p3:api', 'p3:llm', 'вызов модели', {
  colour: FLOW.client,
  exit: [1, 0.5],
  entry: [1, 0.5],
  points: [
    { x: P3_B_X + P3_W + 30, y: p3.V.get('p3:api').cy },
    { x: P3_B_X + P3_W + 30, y: p3.V.get('p3:llm').cy },
  ],
  startDir: 'h',
});
link(p3, 'p3:llm', 'p3:vendor', 'по ключу провайдера', {
  colour: FLOW.client,
  exit: [1, 0.5],
  entry: [0, 0.5],
  startDir: 'h',
});
link(p3, 'p3:cli', 'p3:gwl', 'обычный запрос к модели', {
  colour: FLOW.client,
  exit: [0.5, 1],
  entry: [0.5, 0],
});

routeEdges(p3);
legend(p3, 60, bottomOf(p3) + 60, [
  { caption: 'сторона панели: ваша машина', stage: C.front },
  { caption: 'сторона контура: инстанс платформа компании', stage: C.edge },
  { caption: 'составная часть панели', fill: '#FFFFFF', stroke: C.front.line },
  { caption: 'сервис инстанса', fill: '#FFFFFF', stroke: C.edge.line },
  { caption: 'то, что уже вне контура', fill: C.ext.tint, stroke: C.ext.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'переносится руками, один раз', edgeColour: FLOW.admin },
  { caption: 'запрос вперёд', edgeColour: FLOW.client },
  { caption: 'ответ обратно', edgeColour: FLOW.back, dashed: true },
]);

// ─── Страница 4: вызов инструмента через прослойку ─────────────────────────

const p4 = newPage('4. Вызов инструмента через прослойку', 'p4');
heading(
  p4,
  60,
  30,
  'Вызов инструмента через прослойку',
  'Контур отбрасывает поле инструментов, поэтому шлюз панели объявляет их текстом и собирает вызов обратно из ответа.',
  760,
);

const cli4 = card(p4, 'p4:cli', SPINE_X, 130, SPINE_W, {
  pal: C.actor,
  icon: 'shape=card',
  iconText: 'CLI',
  title: 'Claude Code в чате панели',
  lines: [
    'Шлёт запрос с полем инструментов, как вендору.',
    'Вызов исполняет сам CLI: Write пишет файл, права спрашиваются как обычно.',
  ],
});

const shimIn = card(p4, 'p4:in', SPINE_X, cli4.y + cli4.h + 110, SPINE_W, {
  pal: C.edge,
  icon: 'shape=hexagon',
  iconText: 'in',
  title: 'Шлюз: прослойка на входе',
  lines: [
    'Поле инструментов снимается, их схемы уходят системным текстом протокола.',
    'Схемы едут в каждом ходе: кэша промпта у контура нет.',
  ],
});

const model4 = card(p4, 'p4:model', SPINE_X, shimIn.y + shimIn.h + 110, SPINE_W, {
  pal: C.ext,
  icon: 'shape=cloud',
  iconText: 'LLM',
  title: 'Контур и его модель',
  lines: ['Видит только текст.', 'Отвечает текстом — вызовом по протоколу или словами.'],
});

const shimOut = card(p4, 'p4:out', SPINE_X, model4.y + model4.h + 110, SPINE_W, {
  pal: C.edge,
  icon: 'shape=hexagon',
  iconText: 'out',
  title: 'Шлюз: прослойка на выходе',
  lines: [
    'Исполняется блок в тегах протокола и ответ, который целиком — один вызов.',
    'Он становится вызовом инструмента в том виде, какой CLI ждёт от вендора.',
  ],
});

card(p4, 'p4:fence', RIGHT_X, shimOut.y - 10, RIGHT_W, {
  pal: C.warn,
  soft: true,
  title: 'Не исполняется никогда',
  lines: [
    'Вызов в заборе кода и объект с текстом вокруг. Забором приходят цитата протокола и пример из прочитанной документации.',
    'Каждый такой блок назван в следе запроса.',
  ],
});

card(p4, 'p4:said', RIGHT_X, model4.y, RIGHT_W, {
  pal: C.note,
  soft: true,
  title: 'Модель описала, но не сделала',
  lines: [
    'Ход кончился удачно, файла нет. Панель ставит пометку на карточке «Инструменты через контур», прогон не останавливает.',
  ],
});

card(p4, 'p4:cost', RIGHT_X, shimIn.y, RIGHT_W, {
  pal: C.store,
  soft: true,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'KB',
  title: 'Цена хода в цифрах',
  lines: [
    'Замер на настоящих прогонах: 24 инструмента — 58 тысяч знаков системного текста и 86 КБ запроса на каждом ходе.',
  ],
});

link(p4, 'p4:cli', 'p4:in', 'запрос с полем инструментов', { colour: FLOW.client });
link(p4, 'p4:in', 'p4:model', 'схемы текстом, поля нет', { colour: FLOW.client });
link(p4, 'p4:model', 'p4:out', 'ответ текстом', { colour: FLOW.back, dashed: true });
link(p4, 'p4:out', 'p4:cli', 'вызов инструмента, результат — следующим ходом', {
  colour: FLOW.back,
  dashed: true,
  exit: [0, 0.5],
  entry: [0, 0.5],
  points: [
    { x: 110, y: shimOut.cy },
    { x: 110, y: cli4.cy },
  ],
  startDir: 'h',
});

routeEdges(p4);
legend(p4, 60, bottomOf(p4) + 60, [
  { caption: 'CLI: он же исполняет вызов', fill: C.actor.tint, stroke: C.actor.line },
  { caption: 'шлюз панели и его прослойка', fill: C.edge.tint, stroke: C.edge.line },
  { caption: 'внешняя система: контур компании', fill: C.ext.tint, stroke: C.ext.line },
  { caption: 'цена, измеренная на прогонах', fill: C.store.tint, stroke: C.store.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'чего прослойка не делает', fill: C.warn.tint, stroke: C.warn.line },
  {
    caption: 'значок формы: карточка, шлюз, облако, хранилище',
    fill: '#FFFFFF',
    stroke: C.ext.line,
  },
  { caption: 'запрос вперёд', edgeColour: FLOW.client },
  { caption: 'ответ обратно', edgeColour: FLOW.back, dashed: true },
]);

// ─── Вывод ─────────────────────────────────────────────────────────────────

function pageXml(p, width, height) {
  return (
    `  <diagram id="${p.id}" name="${esc(p.name)}">\n` +
    `    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${width}" pageHeight="${height}" math="0" shadow="0">\n` +
    '      <root>\n' +
    '        <mxCell id="0"/>\n' +
    '        <mxCell id="1" parent="0"/>\n' +
    `${p.cells.join('\n')}\n` +
    '      </root>\n' +
    '    </mxGraphModel>\n' +
    '  </diagram>'
  );
}

const bounds = (p) => {
  let w = 0;
  let h = 0;
  for (const v of p.V.values()) {
    w = Math.max(w, v.x + v.w);
    h = Math.max(h, v.y + v.h);
  }
  return { w: w + 60, h: h + 60 };
};

const b1 = bounds(p1);
const b2 = bounds(p2);
const b3 = bounds(p3);
const b4 = bounds(p4);
const xml =
  '<mxfile host="app.diagrams.net" version="24.7.7">\n' +
  `${pageXml(p1, b1.w, b1.h)}\n${pageXml(p2, b2.w, b2.h)}\n${pageXml(p3, b3.w, b3.h)}\n` +
  `${pageXml(p4, b4.w, b4.h)}\n` +
  '</mxfile>\n';

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, xml, 'utf8');
console.log(
  `записано ${OUT}: страница 1 ${b1.w}×${b1.h}, страница 2 ${b2.w}×${b2.h}, ` +
    `страница 3 ${b3.w}×${b3.h}, страница 4 ${b4.w}×${b4.h}, ` +
    `ячеек ${p1.cells.length + p2.cells.length + p3.cells.length + p4.cells.length}`,
);
