/**
 * Схемы документа «Ядро задач». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/core-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают. Служебный слой — тот же,
 * что в `docs/diagrams/kit-guide/generate.mjs` (общей библиотеки у наборов нет намеренно).
 *
 * Три страницы: как страницы панели доходят до ядра (прокладка, звенья), как задача идёт от
 * формы запуска до шагов (оценка, деление, лента) и как её ведёт ведущий (класс, единицы, сборка).
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
} // ─── Страница 1: от панели до ядра ─────────────────────────────────────────

const p1 = newPage('От панели до ядра', 'p1');
heading(
  p1,
  60,
  30,
  'От панели до ядра',
  'Ядро задач — отдельный процесс рядом с панелью. Страницы «Задачи ядра» ходят к нему только через прокладку панели, а команды человека ядро принимает от звена, которое ему записали.',
  1500,
);

const PX = 60;
const PW = 380;
const QX = 560;
const QW = 440;
const RX = 1120;
const RW = 440;

const pages = card(p1, 'c:pages', PX, 150, PW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Страницы «Задачи ядра»',
  lines: [
    'Список задач, лента задачи, экран запуска, сценарии.',
    'Ответы на вопросы ядра, запуск, сохранение сценария — команды человека.',
  ],
});

const proxy = card(p1, 'c:proxy', QX, 150, QW, {
  pal: C.panel,
  icon: 'shape=hexagon',
  iconText: 'панель',
  title: 'Прокладка панели /api/core/*',
  lines: [
    'Находит запущенное ядро по его записи в procs.json и проверяет, что порт держит именно оно.',
    'Добавляет ключ доступа ядра; поток событий отдаёт без буфера и с места обрыва.',
    'Ядра нет — 503 «не запущено»; не подтвердило себя — 503; не отвечает — 502.',
  ],
});

const core = card(p1, 'c:core', RX, 150, RW, {
  pal: C.check,
  icon: 'shape=process',
  iconText: 'ядро',
  title: 'Ядро задач',
  lines: [
    'Свой процесс: pnpm core. pnpm dev его не запускает.',
    'Журнал на задачу, сессии CLI, проверки, решения с причинами, итоговый отчёт.',
  ],
});

const recorder = card(p1, 'c:recorder', QX, proxy.y + proxy.h + 70, QW, {
  pal: C.panel,
  title: 'Запуск панели: pnpm dev или pnpm keepalive',
  lines: [
    'Сразу после старта записывает ядру процессы панели звеньями — по защищённому каналу надзора.',
    'Перезапуск панели — новая запись; прежний процесс ядро больше не признаёт.',
  ],
});

const hops = card(p1, 'c:hops', RX, recorder.y, RW, {
  pal: C.store,
  title: 'Доверенные звенья ядра',
  lines: [
    'Команда через записанное звено принимается как команда человека.',
    'Звено не записано — ядро требует подпись телефона, а страницы показывают плашку «Ядро ещё не знает эту панель».',
  ],
});

card(p1, 'c:limits', PX, recorder.y, PW, {
  pal: C.warn,
  title: 'Границы',
  lines: [
    'Панель не читает файлы ядра сама: всё — через прокладку.',
    'Числа на ленте — те же, что считает ядро: расход по журналу, одним способом с аналитикой.',
  ],
});

link(p1, 'c:pages', 'c:proxy', 'запросы и команды', {
  colour: FLOW.human,
  exit: [1, 0.35],
  entry: [0, (pages.y + pages.h * 0.35 - proxy.y) / proxy.h],
});
link(p1, 'c:proxy', 'c:core', 'с ключом ядра', {
  colour: FLOW.fwd,
  exit: [1, 0.3],
  entry: [0, (proxy.y + proxy.h * 0.3 - core.y) / core.h],
});
link(p1, 'c:core', 'c:proxy', 'поток событий', {
  colour: FLOW.data,
  exit: [0, 0.8],
  entry: [1, (core.y + core.h * 0.8 - proxy.y) / proxy.h],
});
link(p1, 'c:recorder', 'c:hops', 'запись звеньев', {
  colour: FLOW.fwd,
  exit: [1, 0.5],
  entry: [0, (recorder.y + recorder.h / 2 - hops.y) / hops.h],
});
link(p1, 'c:hops', 'c:core', 'кому верить', {
  colour: FLOW.back,
  dashed: true,
  exit: [0.5, 0],
  entry: [0.5, 1],
});

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'человек и его экран', fill: C.human.tint, stroke: C.human.line },
  { caption: 'панель', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'ядро', fill: C.check.tint, stroke: C.check.line },
  { caption: 'что ядро помнит', fill: C.store.tint, stroke: C.store.line },
  { caption: 'границы', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'запрос', edgeColour: FLOW.fwd },
  { caption: 'данные', edgeColour: FLOW.data },
  { caption: 'решает доверие', edgeColour: FLOW.back, dashed: true },
]);

// ─── Страница 2: от запуска до шагов ───────────────────────────────────────

const p2 = newPage('От запуска до шагов', 'p2');
heading(
  p2,
  60,
  30,
  'От запуска до шагов',
  'Экран запуска только спрашивает ядро. Задача рождается оценкой, а работать начинает после того, как человек принял деление на части.',
  1500,
);

const SW = 310;
const GAP = 110;
const sx = (i) => 60 + i * (SW + GAP);

const form = card(p2, 'l:form', sx(0), 150, SW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Форма запуска',
  lines: [
    'Название, требования, репозитории, сценарий.',
    'Ждать CI выключено по умолчанию; файл репозитория включить его не может.',
  ],
});

const estimate = card(p2, 'l:estimate', sx(1), 150, SW, {
  pal: C.check,
  icon: 'shape=hexagon',
  iconText: 'ядро',
  title: 'Оценка',
  lines: [
    'Время, токены и разброс — по истории прогонов; истории нет — «неизвестно», а не выдуманное число.',
    'Проверка дорог: где найден каждый CLI, маршрут, диск, порты, git.',
    'Отвергнутые правки репозитория, предупреждения вашего слоя, доступ к подтверждению.',
  ],
});

const split = card(p2, 'l:split', sx(2), 150, SW, {
  pal: C.human,
  title: 'Деление и запуск',
  lines: [
    'Ядро предлагает части; их можно поправить на экране.',
    'Запуск — принять деление. Пока есть неподтверждённый доступ, кнопка закрыта и причина названа.',
  ],
});

const steps = card(p2, 'l:steps', sx(3), 150, SW, {
  pal: C.check,
  icon: 'shape=process',
  iconText: 'ядро',
  title: 'Шаги задачи',
  lines: [
    'Сессии CLI по маршруту, проверки (полный прогон, повтор записи, узкая), решения с причинами.',
    'Нужен человек — вопрос на ленте.',
  ],
});

const tape = card(p2, 'l:tape', sx(3), steps.y + steps.h + 70, SW, {
  pal: C.panel,
  title: 'Лента задачи',
  lines: [
    'Каждая строка журнала по времени; у решения — заголовок и «детали» с причинами ядра.',
    'Справа — расход и окна; внизу — итоговый отчёт.',
  ],
});

card(p2, 'l:ask', sx(2), tape.y, SW, {
  pal: C.human,
  title: 'Вопрос человеку',
  lines: [
    'Карточка над лентой: ответить, одобрить, выдать доступ. Ответ уходит командой через прокладку.',
  ],
});

card(p2, 'l:scenario', sx(0), tape.y, SW, {
  pal: C.store,
  title: 'Сценарии',
  lines: [
    'Пресет ядра или ваша версия из библиотеки. Версия пишется один раз; правка — новая версия.',
  ],
});

link(p2, 'l:form', 'l:estimate', 'оценить', {
  colour: FLOW.human,
  exit: [1, 0.3],
  entry: [0, (form.y + form.h * 0.3 - estimate.y) / estimate.h],
});
link(p2, 'l:estimate', 'l:split', 'задача создана', {
  colour: FLOW.fwd,
  exit: [1, 0.3],
  entry: [0, (estimate.y + estimate.h * 0.3 - split.y) / split.h],
});
link(p2, 'l:split', 'l:steps', 'запустить', {
  colour: FLOW.human,
  exit: [1, 0.3],
  entry: [0, (split.y + split.h * 0.3 - steps.y) / steps.h],
});
link(p2, 'l:steps', 'l:tape', 'строки журнала', {
  colour: FLOW.data,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p2, 'l:tape', 'l:ask', 'вопрос', {
  colour: FLOW.data,
  exit: [0, 0.5],
  entry: [1, 0.5],
});
link(p2, 'l:scenario', 'l:form', 'выбор сценария', {
  colour: FLOW.back,
  dashed: true,
  exit: [0.5, 0],
  entry: [0.5, 1],
});

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'человек решает', fill: C.human.tint, stroke: C.human.line },
  { caption: 'ядро работает', fill: C.check.tint, stroke: C.check.line },
  { caption: 'что видно на экране', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'библиотека сценариев', fill: C.store.tint, stroke: C.store.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.check.line },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'порядок', edgeColour: FLOW.fwd },
  { caption: 'данные', edgeColour: FLOW.data },
  { caption: 'источник', edgeColour: FLOW.back, dashed: true },
]);

// ─── Страница 3: ведущий ────────────────────────────────────────────────────

const p3 = newPage('Ведущий', 'p3');
heading(
  p3,
  60,
  30,
  'Ведущий: от разведки до публикации',
  'Модель предлагает, решает одна функция ядра; каждое решение с причиной ложится в ленту. Класс задачи выбирает форму, единицы работают в пределах мест сеансов.',
  1500,
);

// Ряд карточек одной высоты — по самой высокой: нижние края ровные, стрелки без ступенек.
function evenRow(p, y, entries) {
  const h = Math.max(...entries.map(([, , spec]) => cardH(spec, SW)));
  return entries.map(([id, col, spec]) => card(p, id, sx(col), y, SW, { ...spec, h }));
}

const [recon, intakeCard, classCard, planCard] = evenRow(p3, 150, [
  [
    'd:recon',
    0,
    {
      pal: C.check,
      icon: 'shape=hexagon',
      iconText: 'ядро',
      title: 'Разведка',
      lines: [
        'Только читает: карта до 20 строк — файлы с причиной, тесты, владельцы.',
        'Тел файлов в карте нет.',
      ],
    },
  ],
  [
    'd:intake',
    1,
    {
      pal: C.check,
      title: 'Разбор',
      lines: [
        'Карточка приёма: цель, пункты приёмки, до 4 развилок с рекомендацией.',
        'Сама принимается только у задачи трекера с полем критериев и без развилок.',
      ],
    },
  ],
  [
    'd:class',
    2,
    {
      pal: C.check,
      title: 'Класс и форма',
      lines: [
        'S — правка без плана; M — одна единица; L — единицы и сборка; XL — дочерние задачи.',
        'Модель класс только поднимает, понижает человек.',
      ],
    },
  ],
  [
    'd:plan',
    3,
    {
      pal: C.check,
      title: 'План',
      lines: [
        'Только M и шире: деление на единицы со своими путями.',
        'Проверка деления называет каждый пробел одним отказом.',
      ],
    },
  ],
]);

const ROW2 = recon.y + recon.h + 110;
const [unitsCard] = evenRow(p3, ROW2, [
  [
    'd:units',
    3,
    {
      pal: C.check,
      icon: 'shape=process',
      iconText: 'единица',
      title: 'Единицы',
      lines: [
        'Своя сессия, копия, место сеанса, права и журнал — на любом CLI.',
        'Субагентов внутри сессии нет: отказ «lead-worker».',
      ],
    },
  ],
  [
    'd:review',
    2,
    {
      pal: C.check,
      title: 'Ревью и правки',
      lines: ['Ревью у каждого класса, у L — у каждой единицы.', 'Ревьюер не слабее автора.'],
    },
  ],
  [
    'd:integrate',
    1,
    {
      pal: C.check,
      title: 'Сборка',
      lines: [
        'От 2 параллельных частей: ветки сливаются локально, общее изменение проверяется и смотрится ревью.',
        'Конфликт останавливает публикацию и называет файлы.',
      ],
    },
  ],
  [
    'd:publish',
    0,
    {
      pal: C.check,
      title: 'Финальная проверка и публикация',
      lines: [
        'Свой MR у каждой части, только после зелёной сборки.',
        'MR частей ссылаются друг на друга.',
      ],
    },
  ],
]);

const ROW3 = unitsCard.y + unitsCard.h + 80;
evenRow(p3, ROW3, [
  [
    'd:ask',
    0,
    {
      pal: C.human,
      icon: 'shape=card',
      iconText: 'вы',
      title: 'Вопросы человеку',
      lines: [
        'Развилки карточки, класс и деление (если «Всегда спрашивать»), предел кругов.',
        'Карточка над лентой; ответ уходит командой.',
      ],
    },
  ],
  [
    'd:slots',
    1,
    {
      pal: C.panel,
      title: 'Места сеансов',
      lines: [
        'Экономно 2, Сбалансировано 4, Максимум качества 6 — на все задачи машины.',
        'Лишние ждут в очереди, отказа нет; чаты не считаются.',
      ],
    },
  ],
  [
    'd:tiers',
    2,
    {
      pal: C.store,
      icon: 'shape=cylinder3',
      iconText: 'память',
      title: 'Ступени',
      lines: [
        'Неудача — следующая попытка ступенью выше: усилие до xhigh, затем модель, до потолка.',
        'Меньше 85 % первых проходов из 20 — вид работы на ступень выше.',
      ],
    },
  ],
  [
    'd:spend',
    3,
    {
      pal: C.warn,
      title: 'Расход',
      lines: [
        'Предела нет намеренно.',
        'Больше двух верхних границ оценки — заметка в ленте, задача идёт дальше.',
      ],
    },
  ],
]);

link(p3, 'd:recon', 'd:intake', 'карта', {
  colour: FLOW.data,
  exit: [1, 0.3],
  entry: [0, (recon.y + recon.h * 0.3 - intakeCard.y) / intakeCard.h],
});
link(p3, 'd:intake', 'd:class', 'карточка', {
  colour: FLOW.fwd,
  exit: [1, 0.3],
  entry: [0, (intakeCard.y + intakeCard.h * 0.3 - classCard.y) / classCard.h],
});
link(p3, 'd:class', 'd:plan', 'M, L, XL', {
  colour: FLOW.fwd,
  exit: [1, 0.3],
  entry: [0, (classCard.y + classCard.h * 0.3 - planCard.y) / planCard.h],
});
link(p3, 'd:plan', 'd:units', 'деление', {
  colour: FLOW.fwd,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p3, 'd:class', 'd:review', 'S — без плана', {
  colour: FLOW.back,
  dashed: true,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p3, 'd:units', 'd:review', 'работа', {
  colour: FLOW.fwd,
  exit: [0, 0.5],
  entry: [1, 0.5],
});
link(p3, 'd:review', 'd:integrate', 'L, XL', {
  colour: FLOW.fwd,
  exit: [0, 0.5],
  entry: [1, 0.5],
});
link(p3, 'd:integrate', 'd:publish', 'зелёная', {
  colour: FLOW.fwd,
  exit: [0, 0.5],
  entry: [1, 0.5],
});

routeEdges(p3);
legend(p3, 60, bottomOf(p3) + 60, [
  { caption: 'ядро работает', fill: C.check.tint, stroke: C.check.line },
  { caption: 'человек решает', fill: C.human.tint, stroke: C.human.line },
  { caption: 'очередь мест', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'что ядро помнит', fill: C.store.tint, stroke: C.store.line },
  { caption: 'границы', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.check.line },
  { caption: 'порядок', edgeColour: FLOW.fwd },
  { caption: 'данные', edgeColour: FLOW.data },
  { caption: 'обход по классу', edgeColour: FLOW.back, dashed: true },
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
const xml =
  '<mxfile host="app.diagrams.net" version="24.7.7">\n' +
  `${pageXml(p1, b1.w, b1.h)}\n` +
  `${pageXml(p2, b2.w, b2.h)}\n` +
  `${pageXml(p3, b3.w, b3.h)}\n` +
  '</mxfile>\n';

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, xml, 'utf8');
console.log(`записано ${OUT}: ${b1.w}×${b1.h}, ${b2.w}×${b2.h} и ${b3.w}×${b3.h}`);
