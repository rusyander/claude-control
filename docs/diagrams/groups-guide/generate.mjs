/**
 * Схемы путеводителя «Группы». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/groups-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают — высота карточки
 * считается по её тексту, а место подписи ребра подбирается перебором свободных
 * коридоров. Ни то, ни другое в рукописном XML не держится.
 *
 * Служебный слой (палитра, карточка, колонка, легенда, раскладка рёбер) — тот
 * же, что в `docs/diagrams/rules-guide/generate.mjs`: он и есть принятая в этом
 * репозитории форма схемы справки. Общей библиотеки у наборов нет намеренно —
 * набор целиком читается одним файлом, и правка в одном разделе справки не
 * двигает картинки в другом.
 *
 * Две страницы, и только две: схема здесь появляется там, где снимок бессилен.
 *
 * Страница 1 — две отметки выключения. На экране виден один тумблер, а решений
 *              за ним два: ручное и групповое. Отсюда «включаю группу, а правило
 *              не вернулось» — снимок этого не объясняет, потому что показывать
 *              нечего: обе отметки живут в состоянии панели.
 * Страница 2 — во что набор превращается на диске. Про группы Claude Code не
 *              знает вовсе; чтобы сценарий работал, панель собирает из него
 *              обычный скилл и обычные хуки. Снимок показывает результат, но не
 *              то, что он собран и кем.
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

// ─── Страница 1: два повода быть выключенным ───────────────────────────────

const p1 = newPage('1. Две отметки выключения', 'p1');
heading(
  p1,
  60,
  30,
  'Почему включённая группа не всё оживляет',
  'Тумблер на экране один, а отметок за ним две: ручная и групповая. Участник действует, только когда снята ручная И его не держит ни одна группа.',
  1340,
);

card(p1, 'p1:manual', 60, 150, 420, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Тумблер участника',
  lines: [
    'На его собственной странице: «Правила», «Скиллы», «Хуки», «MCP-серверы», «Права».',
    'Ставит ОДНУ отметку — ручную. Она не привязана ни к какой группе и снимается только тем же тумблером.',
  ],
});

card(p1, 'p1:group', 560, 150, 420, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Тумблер группы',
  lines: [
    'Гасит весь набор разом — ради этого группы и заводят.',
    'Ставит отметку «погашено этой группой» на каждый лист состава, разворачивая вложенные группы до самого низа.',
  ],
});

card(p1, 'p1:auto', 1060, 150, 400, {
  pal: C.panel,
  icon: 'shape=hexagon',
  iconText: 'API',
  title: 'Включение по каталогу',
  lines: [
    'Прогон начался в привязанном проекте — сервер включает группу тем же кодом, что и рука.',
    // Угловые скобки — двойным экранированием: одинарное `&lt;` доезжает до
    // разметки карточки как настоящий `<`, и браузер съедает «<ветка>» как
    // неизвестный тег.
    'Копия ветки «&amp;lt;репозиторий&amp;gt;-worktrees/&amp;lt;ветка&amp;gt;» считается тем же проектом.',
    'Обратно не выключает НИКОГДА: файлы конфигурации общие, а прогонов идёт несколько сразу.',
  ],
});

const state = card(p1, 'p1:state', 260, 470, 520, {
  pal: C.panel,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'state',
  title: 'Состояние панели: две независимые отметки',
  lines: [
    'Ручная — отдельно, групповые — списком: на одном участнике их столько, в скольких группах он состоит.',
    'Включён = ручной отметки нет И групповых не осталось ни одной.',
    'Отсюда обе неожиданности: выключенное руками не оживает от включения группы, а участник двух групп ждёт, пока его отпустят обе.',
  ],
});

const disk = column(
  p1,
  'p1:disk',
  C.store,
  860,
  'Что «выключено» значит на диске',
  'запись в файлы, а не флаг в интерфейсе',
  [
    {
      id: 'p1:disk:rule',
      title: 'Правило',
      lines: [
        'Текст переезжает в служебный раздел «Отключённые правила (AgentDeck)» в конце CLAUDE.md.',
      ],
    },
    {
      id: 'p1:disk:skill',
      title: 'Скилл',
      lines: [
        'Папка переезжает из skills/ в соседний skills-disabled/ — целиком, со всеми файлами.',
      ],
    },
    {
      id: 'p1:disk:hook',
      title: 'Хук и право',
      lines: [
        'Исчезают из settings.json: Claude Code читает только то, что в файле. Панель помнит их у себя и возвращает при включении.',
      ],
    },
    {
      id: 'p1:disk:mcp',
      title: 'MCP-сервер',
      lines: ['Выключается в своём файле конфигурации, с резервной копией перед записью.'],
    },
  ],
  { w: 460, y: 470 },
);

const warnY = Math.max(state.y + state.h, disk.y + disk.h) + 80;

card(p1, 'p1:local', 60, warnY, 460, {
  pal: C.warn,
  title: 'Хук из settings.local.json группе не подчиняется',
  lines: [
    'В этот файл панель не пишет, поэтому выключить такой хук ей нечем — и он честно остаётся включённым.',
    'Панель считает их отдельно и говорит об этом при переключении группы: «N участников пропущено».',
  ],
});

card(p1, 'p1:env', 580, warnY, 460, {
  pal: C.note,
  soft: true,
  title: 'Переменные набора — по тому же правилу',
  lines: [
    'Пока группа включена, её переменные лежат в env файла settings.json.',
    'Ключ, который вы задали руками, группа не трогает вовсе; при выключении снимаются только её ключи, которых не держит другая группа.',
  ],
});

card(p1, 'p1:one', 1100, warnY, 360, {
  pal: C.note,
  soft: true,
  title: 'Один набор на машину',
  lines: [
    'Группы правят общие файлы ~/.claude, а не копию для конкретного чата.',
    'Включили набор — его видят все идущие прогоны, включая телефон и соседний терминал.',
  ],
});

link(p1, 'p1:manual', 'p1:state', 'ручная отметка', {
  colour: FLOW.human,
  exit: [0.4, 1],
  entry: [0.2, 0],
});
link(p1, 'p1:group', 'p1:state', 'отметка группы — на каждый лист', {
  colour: FLOW.human,
  exit: [0.5, 1],
  entry: [0.6, 0],
});
link(p1, 'p1:auto', 'p1:group', 'тем же путём, что и рука', {
  colour: FLOW.fwd,
  exit: [0, 0.5],
  entry: [1, 0.5],
});
link(p1, 'p1:state', 'p1:disk', 'посчитанный итог — одна запись на файл', {
  colour: FLOW.data,
  exit: [1, 0.5],
  entry: [0, 0.3],
});

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'человек и его решение', fill: C.human.tint, stroke: C.human.line },
  { caption: 'панель и её состояние', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'файлы на диске', stage: C.store },
  { caption: 'то, о что спотыкаются', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'путь внутри панели', edgeColour: FLOW.fwd },
  { caption: 'запись на диск', edgeColour: FLOW.data },
]);

// ─── Страница 2: во что превращается набор ─────────────────────────────────

const p2 = newPage('2. Во что превращается набор', 'p2');
heading(
  p2,
  60,
  30,
  'Про группы Claude Code не знает',
  'Ни группы, ни порядка работы, ни сценария в Claude Code нет. Чтобы они работали, панель собирает из них обычный скилл и обычные хуки — с меткой в команде, по которой потом отличает своё от чужого.',
  1340,
);

card(p2, 'p2:group', 60, 150, 440, {
  pal: C.panel,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'state',
  title: 'Группа — запись в состоянии панели',
  lines: [
    'Состав, порядок, привязка к проектам, переменные и шаги лежат в state.json панели.',
    'Сохранение группы пересобирает то, что из неё компилируется, — и только это.',
  ],
});

const compiled = column(
  p2,
  'p2:compiled',
  C.store,
  560,
  'Что панель пишет на диск',
  'обычные файлы Claude Code, без единой новой сущности',
  [
    {
      id: 'p2:compiled:env',
      title: 'Переменные → env в settings.json',
      lines: ['Пока группа включена. Ключ, заданный руками, остаётся за человеком.'],
    },
    {
      id: 'p2:compiled:skill',
      title: 'Шаги → скилл skills/scenario-…',
      lines: [
        'Строка «Когда применять» становится описанием скилла — по ней Claude решает, браться ли за порядок работы.',
        'Скилл добавляется в группу участником и гаснет вместе с ней.',
      ],
    },
    {
      id: 'p2:compiled:trigger',
      title: 'Триггер → хук UserPromptSubmit',
      lines: [
        'Регулярное выражение по тексту запроса: рядом со скиллом кладётся trigger.mjs, а в settings.json — хук с меткой «agentdeck:scenario:&amp;lt;id&amp;gt;» в команде.',
        'Описание скилла лишь предлагает себя модели; триггер напоминает о порядке работы сам.',
      ],
    },
  ],
  { w: 460, y: 150 },
);

const form = card(p2, 'p2:form', 1080, 150, 380, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Сценарий «когда — что»',
  lines: [
    'Событие, фильтр и команда — отдельно от групп, своим списком внизу страницы.',
    'Он не даёт ничего сверх хуков: избавляет от необходимости помнить, какое событие и какой фильтр писать.',
  ],
});

const automation = card(p2, 'p2:automation', 1080, form.y + form.h + 90, 380, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'json',
  title: 'Хук в settings.json',
  lines: [
    'Та же запись, что у написанного руками, плюс метка «agentdeck:automation:&amp;lt;id&amp;gt;» в команде.',
    'Поэтому сценарий работает ровно так же, как хук, и виден на странице «Хуки».',
  ],
});

const tailY = Math.max(compiled.y + compiled.h, automation.y + automation.h) + 80;

card(p2, 'p2:marker', 60, tailY, 460, {
  pal: C.note,
  soft: true,
  title: 'Метка в команде — не украшение',
  lines: [
    'По ней пересборка находит СВОИ записи и не трогает чужие: хук, написанный руками, переживает любое сохранение группы.',
    'Убрали шаги или удалили группу — уходит ровно помеченная запись, соседние остаются.',
  ],
});

card(p2, 'p2:rename', 580, tailY, 460, {
  pal: C.warn,
  title: 'Скилл сценария не переименовывается',
  lines: [
    'Имя скилла считается один раз, при первой компиляции, и дальше не пересчитывается.',
    'Иначе переименование группы оставило бы на диске второй, осиротевший скилл — и он продолжал бы предлагать себя модели.',
  ],
});

card(p2, 'p2:cli', 1100, tailY, 360, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Claude Code видит обычный набор',
  lines: [
    'Скиллы, хуки, права и переменные — и ничего о том, что их собрала панель.',
    'Значит, разобраться в них можно и без неё: файлы остаются читаемыми руками.',
  ],
});

link(p2, 'p2:group', 'p2:compiled', 'сохранение пересобирает', {
  colour: FLOW.data,
  exit: [1, 0.4],
  entry: [0, 0.3],
});
link(p2, 'p2:form', 'p2:automation', 'сохранение', {
  colour: FLOW.human,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p2, 'p2:compiled', 'p2:cli', 'читается при старте сессии', {
  colour: FLOW.fwd,
  exit: [0.8, 1],
  entry: [0.2, 0],
});
link(p2, 'p2:automation', 'p2:cli', 'срабатывает на событии', {
  colour: FLOW.fwd,
  exit: [0.5, 1],
  entry: [0.8, 0],
});

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'человек и его решение', fill: C.human.tint, stroke: C.human.line },
  { caption: 'панель и её состояние', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'файлы на диске', stage: C.store },
  { caption: 'агентный CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'то, о что спотыкаются', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'запись на диск', edgeColour: FLOW.data },
  { caption: 'дальше по пути', edgeColour: FLOW.fwd },
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
