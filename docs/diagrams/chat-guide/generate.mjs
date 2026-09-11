/**
 * Схемы путеводителя «Чат». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/chat-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают — высота карточки
 * считается по её тексту, колонка растёт по своим панелям, а место подписи ребра
 * подбирается перебором свободных коридоров. Ни одно из трёх в рукописном XML
 * не держится.
 *
 * Служебный слой (палитра, карточка, колонка, легенда, раскладка рёбер) — тот
 * же, что в `docs/diagrams/platform-guide/generate.mjs`: он и есть принятая в
 * этом репозитории форма схемы справки. Общей библиотеки у наборов нет
 * намеренно — набор целиком читается одним файлом, и правка в одном разделе
 * справки не двигает картинки в другом.
 *
 * Две страницы, и только две: схема здесь появляется там, где снимок бессилен.
 *
 * Страница 1 — путь одного сообщения: где живёт разговор, кто запускает CLI,
 *              почему у панели нет своей базы и почему прогон переживает её
 *              перезапуск. На экране этого не видно ни в одном состоянии.
 * Страница 2 — конвейер разделения: разбор, план, работа, ревью и исправления
 *              по колонкам, и что из этого делает человек, а чего панель не
 *              делает никогда.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

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

/** Палитра: один смысл — один цвет, и каждый цвет попадает в легенду. */
const C = {
  human: { tint: '#E8F5E9', line: '#43A047', ink: '#1B5E20' },
  panel: { tint: '#EDE7F6', line: '#7E57C2', ink: '#4527A0' },
  cli: { tint: '#FCE4EC', line: '#EC407A', ink: '#AD1457' },
  group: { tint: '#E3F2FD', line: '#42A5F5', ink: '#1565C0' },
  check: { tint: '#E0F2F1', line: '#26A69A', ink: '#00695C' },
  store: { tint: '#FFF3E0', line: '#FB8C00', ink: '#EF6C00' },
  note: { tint: '#FFFDE7', line: '#F9A825', ink: '#EF6C00' },
  warn: { tint: '#FFEBEE', line: '#E53935', ink: '#B71C1C' },
};
const FLOW = { fwd: '#1565C0', back: '#78909C', data: '#6D4C41', human: '#2E7D32' };

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
 * Колонка-рамка с вкладкой-заголовком и белыми панелями внутри.
 */
function column(p, id, pal, x, title, subtitle, panes, opts = {}) {
  const COL_W = opts.w ?? 380;
  const COL_Y = opts.y ?? 150;
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
      `${cardStyle({ tint: '#FFFFFF', line: pal.line, ink: pal.ink }, 1)}informational=1;`,
      { x: x + 20, y: cursor, w, h },
      id,
    );
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

/**
 * Маршруты и подписи: сначала ВСЕ маршруты, и только потом подписи.
 *
 * Порядок здесь не косметический. Подпись обязана обходить не только коробки и
 * уже поставленные подписи, но и каждую линию страницы — включая те, которых в
 * момент её постановки ещё не существовало бы, считай мы рёбра по одному.
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
    // залезшая на свою же карточку, читается ничуть не лучше чужой.
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
      edgeStyle(e.colour ?? FLOW.fwd, e.dashed) +
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

// ─── Страница 1: путь одного сообщения ─────────────────────────────────────

const p1 = newPage('1. Путь одного сообщения', 'p1');
heading(
  p1,
  60,
  30,
  'Путь одного сообщения',
  'Сверху вниз — что происходит после Enter. Разговор хранит не панель: она запускает CLI и читает то, что он написал.',
  900,
);

const SX = 300;
const SW = 340;
const RX = 800;
const RW = 320;

const composer = card(p1, 'p1:composer', SX, 140, SW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Поле ввода в браузере',
  lines: [
    'Текст, вложения, выбранная модель и глубина рассуждения.',
    'Enter отправляет, Shift+Enter переносит строку.',
  ],
});

const server = card(p1, 'p1:server', SX, composer.y + composer.h + 110, SW, {
  pal: C.panel,
  icon: 'shape=hexagon',
  iconText: 'API',
  title: 'Сервер панели',
  lines: [
    'POST /api/chat/send. Собирает запуск: каталог проекта, тумблеры прав, правила автоподтверждения, системный промпт.',
  ],
});

const cli = card(p1, 'p1:cli', SX, server.y + server.h + 110, SW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Процесс агентного CLI',
  lines: [
    'Панель запускает claude отдельным процессом в каталоге проекта — своим на каждый разговор.',
    'Длинный системный промпт уезжает файлом, а не аргументом: в командной строке Windows его рвут кавычки.',
  ],
});

const transcript = card(p1, 'p1:transcript', SX, cli.y + cli.h + 110, SW, {
  pal: C.store,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'jsonl',
  title: 'Транскрипт разговора',
  lines: [
    'Строки JSON, дописываемые CLI в свой каталог конфигурации: projects/&lt;каталог проекта&gt;/&lt;разговор&gt;.jsonl.',
    'Пишет его CLI, а не панель. Это и есть источник правды.',
  ],
});

const feed = card(p1, 'p1:feed', SX, transcript.y + transcript.h + 120, SW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'лента',
  title: 'Лента разговора',
  lines: [
    'Идущий прогон приходит потоком GET /api/chat/:id/stream: размышление, вызовы инструментов, расход, текст ответа.',
    'История же читается из транскрипта — поэтому старый разговор открывается и без прогона.',
  ],
});

card(p1, 'p1:perm', RX, cli.y - 40, RW, {
  pal: C.warn,
  title: 'Права спрашивает не панель',
  lines: [
    'Рядом с прогоном поднят мини-сервер прав. Агент спрашивает его, он стучится в панель, и вызов ЖДЁТ решения человека — всё это время агент стоит.',
    'Автоподтверждение и тумблеры правил решают за человека только обратимое.',
  ],
});

card(p1, 'p1:nodb', RX, transcript.y, RW, {
  pal: C.note,
  soft: true,
  title: 'Своей базы у панели нет',
  lines: [
    'Ни разговоров, ни сообщений она не хранит. Своё — только настройки, реестр прогонов и разборы разделения.',
    'Поэтому разговор, начатый в терминале, виден в панели, а начатый в панели — виден в терминале.',
  ],
});

card(p1, 'p1:ledger', RX, server.y - 20, RW, {
  pal: C.store,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'runs',
  title: 'Реестр прогонов',
  lines: [
    'Файл runs.json рядом с настройками панели. Панель перезапустилась — процессы CLI живы, и прогон подхватывается как отдельный: место в списке, карточка прав и Остановить у него есть.',
  ],
});

card(p1, 'p1:live', RX, feed.y, RW, {
  pal: C.note,
  soft: true,
  title: 'Обрыв не теряет ответа',
  lines: [
    'Поток переподключается с последнего полученного кадра, а /api/events шлёт пустой пинг каждые 25 секунд — иначе тихо умерший сокет никто бы не заметил.',
    'Прогон, начатый в другом окне или с телефона, подхватывается опросом /api/chat/active.',
  ],
});

link(p1, 'p1:composer', 'p1:server', 'одно сообщение', { colour: FLOW.fwd });
link(p1, 'p1:server', 'p1:cli', 'запуск процесса в каталоге проекта', { colour: FLOW.fwd });
link(p1, 'p1:cli', 'p1:transcript', 'строка за строкой', { colour: FLOW.data });
link(p1, 'p1:transcript', 'p1:feed', 'история читается отсюда', { colour: FLOW.data });
// Пишет реестр сервер, поэтому стрелка идёт ОТ него: читает он реестр один раз,
// на своём запуске, и это уже другая история, рассказанная в самой карточке.
link(p1, 'p1:server', 'p1:ledger', 'прогон записан', {
  colour: FLOW.data,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p1, 'p1:perm', 'p1:cli', 'решение человека возвращается агенту', {
  colour: FLOW.human,
  exit: [0, 0.5],
  entry: [1, 0.5],
});
link(p1, 'p1:cli', 'p1:feed', 'ответ кадрами, пока идёт прогон', {
  colour: FLOW.back,
  dashed: true,
  exit: [0, 0.5],
  entry: [0, 0.5],
  points: [
    { x: 150, y: cli.cy },
    { x: 150, y: feed.cy },
  ],
  startDir: 'h',
});

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'человек и то, что он видит', fill: C.human.tint, stroke: C.human.line },
  { caption: 'сервер панели', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'процесс агентного CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'файл на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'место, где работа останавливается и ждёт', fill: C.warn.tint, stroke: C.warn.line },
  {
    caption: 'значок формы: карточка, сервер, процесс, файл',
    fill: '#FFFFFF',
    stroke: C.cli.line,
  },
  { caption: 'запрос вперёд', edgeColour: FLOW.fwd },
  { caption: 'ответ обратно', edgeColour: FLOW.back, dashed: true },
  { caption: 'чтение и запись файлов', edgeColour: FLOW.data },
  { caption: 'решение человека', edgeColour: FLOW.human },
]);

// ─── Страница 2: конвейер разделения ───────────────────────────────────────

const p2 = newPage('2. Конвейер разделения', 'p2');
heading(
  p2,
  60,
  30,
  'Что происходит после «Разделить»',
  'Слева направо — четыре стадии. Ни одна из них не сливает ветки: это остаётся человеку, и панель об этом говорит прямо.',
  1560,
);

const COL_W = 380;
// Промежуток между колонками — 120, а не «сколько останется»: в нём стоят
// подписи стрелок, и на узком просвете каждая из них печатается по карточке.
const COL_X = [60, 560, 1060, 1560];

const colParent = column(
  p2,
  'p2:parent',
  C.human,
  COL_X[0],
  'Родитель',
  'разговор, в котором всё началось',
  [
    {
      id: 'p2:proposal',
      title: 'Предложение агента',
      lines: [
        'Блок разделения в ответе панель рисует карточкой: группа, ветка, список задач, род работы и подобранная модель.',
      ],
    },
    {
      id: 'p2:decision',
      title: 'Решение человека',
      lines: [
        'Разделить или делать здесь по очереди — два равных ответа. Тумблер «только завести чаты» заводит группы, не запуская агентов.',
      ],
    },
    {
      id: 'p2:hub',
      title: 'Сводка групп',
      lines: [
        'Карточка в ленте родителя: стадии цепочки, модель, время работы, задержка первой правки. Вопросы и запросы прав детей приходят сюда же.',
      ],
    },
    {
      id: 'p2:pause',
      title: 'Пауза всего дерева',
      lines: [
        '«Остановить всё» гасит разговор вместе с потомками, «Продолжить всё» возвращает их. Считается это от корня дерева, в какой бы его ветке ни нажали.',
      ],
    },
  ],
);

const colTriage = column(
  p2,
  'p2:triage',
  C.panel,
  COL_X[1],
  'Разбор',
  'один прогон в корне репозитория',
  [
    {
      id: 'p2:readonly',
      title: 'Только чтение',
      lines: [
        'Разбор идёт на потолке разговора и не правит ничего, что бы ни говорил тумблер правок: он раскладывает задачи и называет, какие файлы чьи.',
      ],
    },
    {
      id: 'p2:verdict',
      title: 'Ответ блоком',
      lines: [
        'Порядок групп, зависимости «после», владение файлами. Панель ответу не доверяет: потерянная задача возвращается домой, дубль остаётся в первой группе, цикл теряет связь.',
      ],
    },
    {
      id: 'p2:repairs',
      title: 'Починки названы',
      lines: [
        'Каждая правка разбора видна в сводке отдельной пометкой — не «применено», а что именно было поправлено.',
      ],
    },
    {
      id: 'p2:missing',
      title: 'Сбой не блокирует',
      lines: [
        'Разбор упал, остановлен или пришёл без блока — группы стартуют ровно так, как предложил агент, и в ленте об этом сказано.',
      ],
    },
  ],
);

const colGroup = column(
  p2,
  'p2:group',
  C.group,
  COL_X[2],
  'Группа',
  'свой чат, своя копия, своя ветка',
  [
    {
      id: 'p2:worktree',
      title: 'Копия репозитория',
      lines: [
        'Отдельный каталог РЯДОМ с проектом: &lt;репозиторий&gt;-worktrees/&lt;ветка&gt;. Общая история, своя ветка, свой локальный слой и своя установка зависимостей.',
      ],
    },
    {
      id: 'p2:plan',
      title: 'План',
      lines: [
        'Первый прогон группы: на потолке и без правок. Из плана собирается задание работе, и оно уходит в него дословно.',
      ],
    },
    {
      id: 'p2:work',
      title: 'Работа',
      lines: [
        'Модель подбирается под род задачи и никогда не выше потолка. Правки идут только в копии этой группы.',
      ],
    },
    {
      id: 'p2:queue',
      title: 'Очередь и ожидание',
      lines: [
        'Группа с «после» ждёт конца всей цепочки предшественника и ветвится от его ветки. Группа с «hold» не получает чата, пока человек не ответит в родителе.',
      ],
    },
  ],
);

const colCheck = column(p2, 'p2:check', C.check, COL_X[3], 'Проверка', 'цена работы ниже потолка', [
  {
    id: 'p2:review',
    title: 'Ревью',
    lines: [
      'Работа шла ниже потолка — панель поднимает разговор на потолок и просит проверку. Замечания приходят списком; пустой список закрывает цепочку спокойно.',
    ],
  },
  {
    id: 'p2:fix',
    title: 'Исправления',
    lines: [
      'Возвращаются на ту же модель, которой делалась работа. Стадия исправлений последняя: ещё одного круга не будет.',
    ],
  },
  {
    id: 'p2:overlap',
    title: 'Пересечения веток',
    lines: [
      'Считаются на конце цепочки и по кнопке «Сверить ветки»: изменённые файлы каждой ветки плюс несохранённое в копии. Красным — файл вне владения группы.',
    ],
  },
  {
    id: 'p2:merge',
    title: 'Слияние — за человеком',
    lines: [
      'Панель не сливает, не перебазирует и не переключает ветки. Порядок слияния она показывает подсказкой рядом со списком — и на этом останавливается.',
    ],
  },
]);

// Полоса под ВСЕМИ колонками, а не под самой длинной из двух: обратная стрелка
// идёт по ней, и колонка, оказавшаяся выше соседей, всё равно её не поймает.
const RAIL_Y =
  Math.max(
    colParent.y + colParent.h,
    colTriage.y + colTriage.h,
    colGroup.y + colGroup.h,
    colCheck.y + colCheck.h,
  ) + 30;

card(p2, 'p2:note', COL_X[0], RAIL_Y + 50, COL_X[3] + COL_W - COL_X[0], {
  pal: C.note,
  soft: true,
  title: 'Субагентов здесь нет ни одного',
  lines: [
    'Каждая группа — обычный разговор, в который человек может войти и написать сам. Уровни разбора и плана добавляют прогонов, но не создают ни одной сущности, которой нельзя было бы задать вопрос.',
  ],
});

link(p2, 'p2:decision', 'p2:readonly', 'разделить', {
  colour: FLOW.human,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p2, 'p2:verdict', 'p2:plan', 'разбор применён', {
  colour: FLOW.fwd,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p2, 'p2:work', 'p2:review', 'работа закончилась', {
  colour: FLOW.fwd,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p2, 'p2:overlap', 'p2:hub', 'новый факт — в сводку родителя', {
  colour: FLOW.back,
  dashed: true,
  exit: [1, 0.5],
  entry: [0, 0.5],
  // Обратная стрелка обходит страницу по краю: вниз внутри колонки она прошла
  // бы сквозь панель слияния, а к нижнему краю сводки — сквозь панель паузы.
  points: [
    { x: COL_X[3] + COL_W + 30, y: p2.V.get('p2:overlap').cy },
    { x: COL_X[3] + COL_W + 30, y: RAIL_Y },
    { x: 30, y: RAIL_Y },
    { x: 30, y: p2.V.get('p2:hub').cy },
  ],
  startDir: 'h',
});

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'родительский разговор и решения человека', stage: C.human },
  { caption: 'разбор: прогон панели перед работой', stage: C.panel },
  { caption: 'группа: свой чат и своя копия репозитория', stage: C.group },
  { caption: 'проверка работы и сверка веток', stage: C.check },
  { caption: 'что именно происходит на этой стадии', fill: '#FFFFFF', stroke: C.group.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'решение человека', edgeColour: FLOW.human },
  { caption: 'стадия сменилась', edgeColour: FLOW.fwd },
  { caption: 'обратно в сводку родителя', edgeColour: FLOW.back, dashed: true },
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
const xml =
  '<mxfile host="app.diagrams.net" version="24.7.7">\n' +
  `${pageXml(p1, b1.w, b1.h)}\n${pageXml(p2, b2.w, b2.h)}\n` +
  '</mxfile>\n';

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, xml, 'utf8');
console.log(
  `записано ${OUT}: страница 1 ${b1.w}×${b1.h}, страница 2 ${b2.w}×${b2.h}, ` +
    `ячеек ${p1.cells.length + p2.cells.length}`,
);
