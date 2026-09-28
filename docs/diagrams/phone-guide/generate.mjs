/**
 * Схема путеводителя «Телефон». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/phone-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают — высота карточки
 * считается по её тексту, а место подписи ребра подбирается перебором свободных
 * коридоров. Ни то, ни другое в рукописном XML не держится.
 *
 * Служебный слой — тот же, что в `docs/diagrams/endpoints-guide/generate.mjs`: это
 * принятая в репозитории форма схемы справки. Общей библиотеки у наборов нет
 * намеренно — набор читается одним файлом.
 *
 * Страница одна. Главное, что она объясняет: телефон ходит в ТУ ЖЕ панель через
 * Tailscale и токен, своих данных у него нет, а уведомления идут отдельной
 * дорогой через Expo и несут только вид события и имя папки.
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
// ─── Страница: путь запроса с телефона ─────────────────────────────────────

const p1 = newPage('Путь запроса с телефона', 'p1');
heading(
  p1,
  60,
  30,
  'Телефон — окно в ту же панель',
  'Своих данных у приложения нет: каждый экран — запрос к серверу панели на вашем компьютере через Tailscale. Порт наружу не открывается.',
  1560,
);

const AX = 60;
const AW = 360;
const BX = 540;
const BW = 380;
const CX = 1020;
const CW = 400;
const DX = 1540;
const DW = 360;
const ROW1 = 150;

const app = card(p1, 'ph:app', AX, ROW1, AW, {
  pal: C.human,
  icon: 'rounded=1;arcSize=25',
  iconText: 'APK',
  title: 'Приложение на телефоне',
  lines: [
    'Главная, вопросы, чат, агент панели, проекты, тесты, аналитика, настройки.',
    'Каждый экран спрашивает сервер панели; копии разговоров на телефоне нет.',
  ],
});

const net = card(p1, 'ts:net', BX, ROW1, BW, {
  pal: C.group,
  icon: 'shape=cloud',
  iconText: 'tailnet',
  title: 'Сеть Tailscale',
  lines: [
    'Шифрованный канал между вашими устройствами. Адрес https://машина.tailnet.ts.net видят только устройства этого tailnet.',
  ],
});

const ROW2 = Math.max(app.y + app.h, net.y + net.h) + 70;

const gate = card(p1, 'pn:gate', CX, ROW2, CW, {
  pal: C.check,
  icon: 'shape=hexagon',
  iconText: 'токен',
  title: 'Проверка доступа',
  lines: [
    'При «Пускать по токену» каждый запрос обязан нести Authorization: Bearer <токен>. Нет или не тот — 401, на телефоне «Токен не принят».',
    'Браузеру на этой машине токен подставляет сама панель.',
  ],
});

const token = card(p1, 'pn:token', DX, ROW2, DW, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: '0600',
  title: '~/.agentdeck/api-token',
  lines: [
    'Один токен на все телефоны. «Сменить токен» — старый перестаёт работать сразу, спаренные подключаются заново.',
  ],
});

const secure = card(p1, 'ph:secure', AX, ROW2, AW, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'secure',
  title: 'Защищённое хранилище телефона',
  lines: [
    'Адрес панели и токен — после QR-кода из карточки «Удалённый доступ» или ввода руками.',
    'Очередь сообщений — там же, живёт 2 часа.',
  ],
});

const serve = card(p1, 'ts:serve', BX, ROW2, BW, {
  pal: C.group,
  icon: 'shape=process',
  iconText: 'serve',
  title: 'tailscale serve на этой машине',
  lines: [
    'Принимает https на 443 и передаёт на 127.0.0.1:5178. Включается pnpm remote, выключается pnpm remote:off.',
  ],
});

const ROW3 =
  Math.max(secure.y + secure.h, serve.y + serve.h, gate.y + gate.h, token.y + token.h) + 70;

const server = card(p1, 'pn:server', CX, ROW3, CW, {
  pal: C.panel,
  icon: 'shape=process',
  iconText: ':5178',
  title: 'Сервер панели на 127.0.0.1',
  lines: [
    'Те же маршруты, что у браузера: главная телефона спрашивает /api/chat/inbox раз в 5 секунд, ход чата идёт потоком событий с номерами.',
    'Оборвался поток — телефон продолжает с последнего номера.',
  ],
});

const cli = card(p1, 'cli', DX, ROW3, DW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Claude Code',
  lines: [
    'Ход чата — процесс CLI на этой машине. Разговоры лежат транскриптами в ~/.claude/projects: их и читают телефон и панель.',
  ],
});

const expo = card(p1, 'expo', BX, ROW3, BW, {
  pal: C.note,
  icon: 'shape=cloud',
  iconText: 'Expo',
  title: 'Сервис уведомлений Expo',
  lines: [
    'Получает от панели только вид события (закончено, упало, нужно разрешение, задан вопрос) и имя папки проекта — и будит телефон.',
  ],
});

const ROW4 = Math.max(expo.y + expo.h, server.y + server.h, cli.y + cli.h) + 70;

card(p1, 'w:not', AX, ROW4, DX + DW - AX, {
  pal: C.warn,
  title: 'Чего на этом пути нет',
  lines: [
    'Открытого наружу порта: сервер слушает только 127.0.0.1.',
    'Ключей контура и секретов: их вводят только в панели на своей машине.',
    'Работы без компьютера: панель спит — телефону некуда ходить, уведомления тоже не придут.',
  ],
});

link(p1, 'ph:app', 'ts:net', 'запрос + токен', {
  colour: FLOW.fwd,
  exit: [1, 0.35],
  entry: [0, 0.35],
});
link(p1, 'ts:net', 'ts:serve', 'на ту же машину', {
  colour: FLOW.fwd,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p1, 'ts:serve', 'pn:gate', 'на петлю 127.0.0.1', {
  colour: FLOW.fwd,
  exit: [1, 0.4],
  entry: [0, 0.4],
});
link(p1, 'pn:gate', 'pn:server', 'токен совпал', {
  colour: FLOW.fwd,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p1, 'pn:token', 'pn:gate', 'сверяет с', {
  colour: FLOW.data,
  exit: [0, 0.5],
  entry: [1, 0.5],
});
link(p1, 'pn:server', 'cli', 'запускает ход', {
  colour: FLOW.fwd,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p1, 'ph:secure', 'ph:app', 'адрес и токен', {
  colour: FLOW.data,
  exit: [0.5, 0],
  entry: [0.5, 1],
});
link(p1, 'pn:server', 'expo', 'вид события + папка', {
  colour: FLOW.back,
  exit: [0, 0.5],
  entry: [1, 0.5],
});
link(p1, 'expo', 'ph:app', 'уведомление', {
  colour: FLOW.back,
  dashed: true,
  exit: [0, 0.4],
  entry: [1, 0.85],
  points: [
    { x: AX + AW + 60, y: expo.y + expo.h * 0.4 },
    { x: AX + AW + 60, y: app.y + app.h * 0.85 },
  ],
});

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'телефон', fill: C.human.tint, stroke: C.human.line },
  { caption: 'сеть Tailscale', fill: C.group.tint, stroke: C.group.line },
  { caption: 'проверка токена', fill: C.check.tint, stroke: C.check.line },
  { caption: 'сервер панели', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'Claude Code', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'что где хранится', fill: C.store.tint, stroke: C.store.line },
  { caption: 'внешний сервис', fill: C.note.tint, stroke: C.note.line },
  { caption: 'границы', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'путь запроса', edgeColour: FLOW.fwd },
  { caption: 'что возвращается', edgeColour: FLOW.back },
  { caption: 'уведомление, а не ответ на запрос', edgeColour: FLOW.back, dashed: true },
  { caption: 'кто что читает', edgeColour: FLOW.data },
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
const xml =
  '<mxfile host="app.diagrams.net" version="24.7.7">\n' +
  `${pageXml(p1, b1.w, b1.h)}\n` +
  '</mxfile>\n';

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, xml, 'utf8');
console.log(`записано ${OUT}: ${b1.w}×${b1.h}, ячеек ${p1.cells.length}`);
