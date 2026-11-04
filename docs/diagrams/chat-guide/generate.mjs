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
 * Страница 1 — путь одного сообщения: где живёт разговор, кто запускает CLI
 *              (ядро задач, не панель), почему у панели нет своей базы и почему
 *              ход переживает её перезапуск. На экране этого не видно.
 * Страница 2 (конвейер разделения) снята вместе с разделением: группы и деревья
 *              теперь сценарии ядра, их путь описывает справка «Ядро».
 * Страница 3 — вызов, который решал только человек (прежний путь, до ядра):
 *              запись D-n, отказ агенту с номером, ответ из любого места; решение
 *              теперь только записывается и работу не продолжает.
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

// ─── Страница 1: путь одного сообщения ─────────────────────────────────────

const p1 = newPage('1. Путь одного сообщения', 'p1');
heading(
  p1,
  60,
  30,
  'Путь одного сообщения',
  'Сверху вниз — что происходит после Enter. Разговор хранит не панель: ход ведёт ядро задач, CLI пишет транскрипт, панель его читает.',
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
    'POST /api/chat/send. CLI сервер сам не запускает: разговор уже ведёт шаг ядра — сообщение уходит этому шагу, иначе ядру уходит новая задача «чат» в каталоге проекта.',
  ],
});

const cli = card(p1, 'p1:cli', SX, server.y + server.h + 110, SW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Процесс агентного CLI',
  lines: [
    'claude — потомок хоста сеанса ядра, в каталоге проекта, свой на каждый разговор. Процесс держит ядро, а не сервер панели: перезапуск панели его не трогает.',
    'Сообщение посреди хода ядро доставит на границе хода, а не в середину ответа.',
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
    'Идущий ход сервер читает из вида сеанса ядра и отдаёт потоком GET /api/chat/:id/stream: размышление, вызовы инструментов, расход, текст ответа.',
    'История же читается из транскрипта — поэтому старый разговор открывается и без прогона.',
  ],
});

card(p1, 'p1:perm', RX, cli.y - 40, RW, {
  pal: C.warn,
  title: 'Права спрашивает ядро',
  lines: [
    'Вопрос права ядро пишет в журнал задачи, панель показывает его карточкой, и шаг ЖДЁТ решения человека — всё это время агент стоит.',
    'Включённый тумблер «Права» в меню чата снимает такие вопросы: окно само выдаёт ядру грант правки.',
  ],
});

card(p1, 'p1:nodb', RX, transcript.y, RW, {
  pal: C.note,
  soft: true,
  title: 'Своей базы у панели нет',
  lines: [
    'Ни разговоров, ни сообщений она не хранит. Своё — только настройки, реестр прогонов и книга «разговор → задача ядра».',
    'Поэтому разговор, начатый в терминале, виден в панели, а начатый в панели — виден в терминале.',
  ],
});

card(p1, 'p1:ledger', RX, server.y - 20, RW, {
  pal: C.store,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'ядро',
  title: 'Ядро задач',
  lines: [
    'Отдельный процесс рядом с панелью. Задача «чат» идёт прямо в папке проекта: начало чата — ваше разрешение правок в этом корне. Ядро не запущено — ход отказывает с причиной, тихого отката на старый путь нет.',
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
link(p1, 'p1:server', 'p1:cli', 'ход в каталоге проекта', { colour: FLOW.fwd });
link(p1, 'p1:cli', 'p1:transcript', 'строка за строкой', { colour: FLOW.data });
link(p1, 'p1:transcript', 'p1:feed', 'история читается отсюда', { colour: FLOW.data });
// Задачу ядру отдаёт сервер, поэтому стрелка идёт ОТ него; CLI запускает уже ядро.
link(p1, 'p1:server', 'p1:ledger', 'задача ядру', {
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

// ─── Страница 3: вызов, который решает только человек ─────────────────────

const p3 = newPage('3. Ждёт решения: D-n', 'p3');
heading(
  p3,
  60,
  30,
  'Вызов, который решал только человек (прежний путь)',
  'Так было до ядра задач; новых записей D-n нет. Старые видны до истечения, и решение по ним только записывается — работу оно не продолжает.',
  1000,
);

const DX = 300;
const DW = 360;
const NX = 820;
const NW = 340;

const call = card(p3, 'p3:call', DX, 140, DW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Агент делает вызов',
  lines: [
    'Команда, правка файла или инструмент MCP. Мини-сервер прав спрашивает панель, можно ли.',
  ],
});

const judge = card(p3, 'p3:judge', DX, call.y + call.h + 100, DW, {
  pal: C.panel,
  icon: 'shape=hexagon',
  iconText: 'API',
  title: 'Панель судит вызов',
  lines: [
    'Покрыт правилами прав группы или автоподтверждения — выполняется без вопроса.',
    'Не покрыт — его решает человек. Группа и автономный чат, у которого никто не сидит, ставят его в список сразу; открытый чат сначала показывает карточку.',
  ],
});

const record = card(p3, 'p3:record', DX, judge.y + judge.h + 110, DW, {
  pal: C.store,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'D-n',
  title: 'Запись D-n',
  lines: [
    'Номер, чья запись, сама команда и причина. Тот же вызов ещё раз — та же запись и счётчик повторов, а не новая.',
    'Живёт в каталоге данных панели, переживает её перезапуск, ждёт 7 суток.',
  ],
});

const goOn = card(p3, 'p3:goon', DX, record.y + record.h + 110, DW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Агент работает дальше',
  lines: [
    'Отказ называет номер и запрещает обходить вызов другой командой. Агент делает всё, что от него не зависит, и закрывает ход строкой «ждёт человека: D-n».',
    'Пока у группы ждёт D-n, её MR остаётся черновиком.',
  ],
});

const human = card(p3, 'p3:human', DX, goOn.y + goOn.h + 110, DW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Человек отвечает',
  lines: [
    'Плашка «Ждёт решения» над любой страницей, «Вопросы» на телефоне, сообщение в Telegram.',
    '«Разрешить» и «Отклонить» записывают решение в запись.',
  ],
});

card(p3, 'p3:resume', DX, human.y + human.h + 110, DW, {
  pal: C.panel,
  icon: 'shape=hexagon',
  iconText: 'API',
  title: 'Решение только записывается',
  lines: [
    'Разговор, где вызов родился, не продолжается, и агенту ничего не доставляется. Нужна эта работа — попросите словами в чате: ход пойдёт задачей ядра.',
  ],
});

const chatCard = card(p3, 'p3:card', NX, judge.y, NW, {
  pal: C.warn,
  title: 'Карточка в открытом чате',
  lines: [
    '«Разрешить / Запретить» ждала ответа заданный срок, потом становилась строкой «Отложено как D-n». Сейчас карточка права — «Вопрос ядра», и шаг ждёт ответа.',
  ],
});

const refusal = card(p3, 'p3:refusal', NX, call.y, NW, {
  pal: C.warn,
  title: 'Отказ с известным ответом — не вопрос',
  lines: [
    'Слияние MR, push в основную или защищённую ветку, push с недоказуемой целью: агент сразу получает отказ, записи D-n нет.',
  ],
});

card(p3, 'p3:only', NX, human.y, NW, {
  pal: C.note,
  soft: true,
  title: 'Отвечает только человек',
  lines: [
    'Маршрут решения процесс модели не пускает. Вызов, который тянется к маршрутам решений или ключу панели, отклоняется раньше всех правил: свой D-n агент не решит.',
  ],
});

// Пояснение о сроке — у ряда «агент работает дальше», а не у записи: справа от
// записи идёт стрелка «не ответили вовремя» от карточки чата.
card(p3, 'p3:expire', NX, goOn.y, NW, {
  pal: C.note,
  soft: true,
  title: 'Срок вышел',
  lines: [
    'Запись истекает, «Разрешить заново» выдаёт разрешение снова. Отмена плана или удаление чата отзывает ждущие записи.',
  ],
});

link(p3, 'p3:call', 'p3:judge', 'запрос прав', { colour: FLOW.fwd });
link(p3, 'p3:judge', 'p3:record', 'решает человек', { colour: FLOW.fwd });
link(p3, 'p3:record', 'p3:goon', 'отказ с номером', { colour: FLOW.back, dashed: true });
link(p3, 'p3:goon', 'p3:human', 'список ждёт ответа', { colour: FLOW.data });
link(p3, 'p3:human', 'p3:resume', 'ответ', { colour: FLOW.human });
// Боковая карточка ниже своей соседки слева: стрелка выходит на высоте её
// середины, иначе ломается и упирается в угол.
const levelWith = (from, to) => Math.min(0.9, Math.max(0.1, (to.cy - from.y) / from.h));
link(p3, 'p3:judge', 'p3:card', 'чат открыт', {
  colour: FLOW.fwd,
  exit: [1, levelWith(judge, chatCard)],
  entry: [0, 0.5],
});
link(p3, 'p3:card', 'p3:record', 'не ответили вовремя', {
  colour: FLOW.fwd,
  exit: [0.5, 1],
  entry: [1, 0.5],
  points: [{ x: chatCard.cx, y: record.cy }],
  startDir: 'v',
});
link(p3, 'p3:call', 'p3:refusal', 'слияние или push в main', {
  colour: FLOW.back,
  dashed: true,
  exit: [1, levelWith(call, refusal)],
  entry: [0, 0.5],
});
routeEdges(p3);
legend(p3, 60, bottomOf(p3) + 60, [
  { caption: 'человек и то, что он видит', fill: C.human.tint, stroke: C.human.line },
  { caption: 'сервер панели', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'процесс агентного CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'файл на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'отказ или место, где ждут ответа', fill: C.warn.tint, stroke: C.warn.line },
  {
    caption: 'значок формы: карточка, сервер, процесс, файл',
    fill: '#FFFFFF',
    stroke: C.cli.line,
  },
  { caption: 'запрос вперёд', edgeColour: FLOW.fwd },
  { caption: 'ответ агенту', edgeColour: FLOW.back, dashed: true },
  { caption: 'запись в списке', edgeColour: FLOW.data },
  { caption: 'решение человека', edgeColour: FLOW.human },
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
const b3 = bounds(p3);
const xml =
  '<mxfile host="app.diagrams.net" version="24.7.7">\n' +
  `${pageXml(p1, b1.w, b1.h)}\n${pageXml(p3, b3.w, b3.h)}\n` +
  '</mxfile>\n';

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, xml, 'utf8');
console.log(
  `записано ${OUT}: страница 1 ${b1.w}×${b1.h}, ` +
    `страница 3 ${b3.w}×${b3.h}, ячеек ${p1.cells.length + p3.cells.length}`,
);
