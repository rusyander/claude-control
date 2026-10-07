/**
 * Схема путеводителя «Локальные модели». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/localModels-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают. Служебный слой — тот же,
 * что в `docs/diagrams/dlp-guide/generate.mjs` (общей библиотеки у наборов нет намеренно).
 *
 * Страница одна. Главное, что она объясняет: одна кнопка заменяет ручную установку, а
 * запрос агента идёт на видеокарту той же дорогой, что и через корпоративный контур.
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
// ─── Страница: от кнопки до видеокарты ─────────────────────────────────────

const p1 = newPage('Как агент попадает на вашу видеокарту', 'p1');
heading(
  p1,
  60,
  30,
  'Как агент попадает на вашу видеокарту',
  'Человек нажимает одну кнопку; всё, что раньше ставили и прописывали руками, панель делает сама — а запросы агента идут той же дорогой, что и через корпоративный контур.',
  1400,
);

const AX = 60;
const AW = 400;
const BX = 620;
const BW = 460;
const CX = 1240;
const CW = 430;

const section = card(p1, 'l:section', AX, 150, AW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Раздел «Локальные модели»',
  lines: [
    'Панель читает карту сама (nvidia-smi, реестр Windows, sysctl на Mac): объём, свободную память и пропускную способность.',
    'Каталог моделей для кода размечен под ЭТУ карту: влезет ли, с каким контекстом и с какой скоростью. Лучшая для агента помечена «Рекомендуем».',
  ],
});

const button = card(p1, 'l:button', AX, section.y + section.h + 55, AW, {
  pal: C.check,
  icon: 'shape=hexagon',
  iconText: 'кнопка',
  title: '«Скачать и подключить»',
  lines: [
    'Берёт системный Ollama, если он есть и не старый, иначе скачивает свою копию и сверяет контрольную сумму.',
    'Качает модель с докачкой, поднимает сервер с нужным контекстом и заводит контур локальной модели. Работа идёт на сервере панели: закрытая вкладка её не обрывает.',
  ],
});

card(p1, 'l:hint', AX, button.y + button.h + 55, AW, {
  pal: C.panel,
  icon: 'shape=card',
  iconText: 'чат',
  title: 'Та же кнопка под полем чата',
  lines: [
    'Подсказка называет модель для вашей карты и её скорость. Когда модель скачана и подключена, открытый разговор продолжается сам.',
  ],
});

const chat = card(p1, 'l:chat', BX, 150, BW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Чат, группа, тест',
  lines: [
    'Claude Code запускается как обычно; адрес модели ему подставляет панель на один прогон. В ~/.claude ничего не пишется.',
    'Qwen Code получает тот же маршрут, если контур его принимает.',
  ],
});

const gateway = card(p1, 'l:gateway', BX, chat.y + chat.h + 55, BW, {
  pal: C.panel,
  icon: 'shape=hexagon',
  iconText: 'шлюз',
  title: 'Шлюз панели — контур локальной модели',
  lines: [
    'Тот же механизм, что у корпоративного контура: режим «обязательно» (без молчаливого ухода в облако), журнал, проба при включении.',
    '«Вернуть облако» выключает контур одной кнопкой.',
  ],
});

const ollama = card(p1, 'l:ollama', BX, gateway.y + gateway.h + 55, BW, {
  pal: C.group,
  icon: 'shape=process',
  iconText: 'Ollama',
  title: 'Сервер моделей на 127.0.0.1:11435',
  lines: [
    'Свой порт и своя папка моделей — системный Ollama на 11434 не мешает. Контекст задан на весь сервер: другая модель с другим контекстом = перезапуск.',
    'Простаивающая модель уходит из видеопамяти через 10 минут; «Остановить» освобождает её сразу.',
  ],
});

const gpu = card(p1, 'l:gpu', CX, ollama.y, CW, {
  pal: C.human,
  title: 'Видеокарта',
  lines: [
    'Модель целиком в видеопамяти — десятки токенов в секунду. Не влезла — часть уходит в оперативную память, и агенту это уже слишком медленно: каталог такую не рекомендует.',
  ],
});

const folder = card(p1, 'l:folder', CX, gateway.y, CW, {
  pal: C.store,
  title: 'Папка .local-models',
  lines: [
    'runtime — сервер, models — модели, downloads — недокачанное, tools — Qwen Code и набор, logs — журнал сервера, state.json — замеры и выбор набора.',
    'Модель из системного Ollama переносится жёсткой ссылкой: второй копии на диске нет.',
  ],
});

card(p1, 'l:limits', CX, chat.y, CW, {
  pal: C.warn,
  title: 'Границы',
  lines: [
    'Локальная модель слабее облачной: длинные задачи и большие правки она делает хуже. Набор панели (короткие правила и навыки) помогает ей, но не уравнивает.',
    'Сервер слушает только 127.0.0.1 — раздать модель на команду отсюда нельзя.',
  ],
});

link(p1, 'l:section', 'l:button', 'человек выбирает модель', {
  colour: FLOW.human,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p1, 'l:button', 'l:ollama', 'ставит и запускает', {
  colour: FLOW.fwd,
  exit: [1, 0.8],
  entry: [0, 0.3],
  points: [
    { x: 540, y: button.y + button.h * 0.8 },
    { x: 540, y: ollama.y + ollama.h * 0.3 },
  ],
});
link(p1, 'l:button', 'l:gateway', 'заводит контур', {
  colour: FLOW.fwd,
  exit: [1, (gateway.y + gateway.h / 2 - button.y) / button.h],
  entry: [0, 0.5],
});
link(p1, 'l:chat', 'l:gateway', 'запрос агента', {
  colour: FLOW.fwd,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p1, 'l:gateway', 'l:ollama', 'по адресу …/v1', {
  colour: FLOW.fwd,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p1, 'l:ollama', 'l:gpu', 'веса в видеопамять', {
  colour: FLOW.data,
  // Выход на высоте середины карточки карты: ребро идёт прямой линией.
  exit: [1, (gpu.y + gpu.h / 2 - ollama.y) / ollama.h],
  entry: [0, 0.5],
});
link(p1, 'l:ollama', 'l:folder', 'модели и журнал', {
  colour: FLOW.data,
  exit: [1, 0.2],
  entry: [0, 0.5],
  points: [
    { x: 1160, y: ollama.y + ollama.h * 0.2 },
    { x: 1160, y: folder.y + folder.h * 0.5 },
  ],
});

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'человек и его машина', fill: C.human.tint, stroke: C.human.line },
  { caption: 'работа панели', fill: C.check.tint, stroke: C.check.line },
  { caption: 'что видно на экране', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'агент-CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'файлы на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'сервер моделей', fill: C.group.tint, stroke: C.group.line },
  { caption: 'границы', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'порядок', edgeColour: FLOW.fwd },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'данные', edgeColour: FLOW.data },
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
