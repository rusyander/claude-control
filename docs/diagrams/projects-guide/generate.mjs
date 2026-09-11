/**
 * Схемы путеводителя «Проекты». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/projects-guide/generate.mjs <абсолютный путь>.drawio
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
 * Страница 1 — что «добавить проект» делает и чего НЕ делает: запись уходит в
 *              состояние панели, файлы остаются файлами репозитория, и половину
 *              из них панель только показывает. На снимке видны вкладки, но не
 *              видно, что за какой вкладкой лежит на диске.
 * Страница 2 — один реестр и разные файлы: у каждого CLI свой файл инструкций
 *              и свой формат конфига, а запись о проекте общая. Снимок ловит
 *              только один из двух видов сразу.
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

// ─── Страница 1: что панель правит, а что только показывает ────────────────

const p1 = newPage('1. Реестр и файлы проекта', 'p1');
heading(
  p1,
  60,
  30,
  'Что «добавить проект» делает с диском',
  'Запись о проекте уходит в состояние панели. В самом репозитории от добавления не появляется ничего — файлы правятся только тогда, когда вы что-то сохраняете на вкладке.',
  1340,
);

card(p1, 'p1:add', 60, 150, 380, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: '«Добавить проект» → «Открыть эту папку»',
  lines: [
    'Обзор дисков панели: любая папка, даже та, где Claude Code ещё не работал.',
    'Имя проекта — последний сегмент пути; его можно переименовать, путь останется прежним.',
  ],
});

const registry = card(p1, 'p1:registry', 520, 150, 400, {
  pal: C.panel,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'state',
  title: 'Реестр панели',
  lines: [
    'Запись «id, имя, путь» в state.json каталога данных панели — рядом с группами, а не в проекте.',
    'Удаление проекта из списка убирает только эту запись: файлы остаются на диске нетронутыми.',
  ],
});

card(p1, 'p1:nothing', 1000, 150, 400, {
  pal: C.note,
  soft: true,
  title: 'В репозитории — ничего нового',
  lines: [
    'Ни CLAUDE.md, ни .claude/ добавление не создаёт. Каталог .claude появляется при ПЕРВОЙ записи на вкладке «Права».',
    'Поэтому пустые вкладки у только что добавленного проекта — норма, а не потерянная конфигурация.',
  ],
});

const edit = column(
  p1,
  'p1:edit',
  C.store,
  60,
  'Панель правит',
  'файлы в каталоге проекта, каждый со своей вкладки',
  [
    {
      id: 'p1:edit:md',
      title: 'CLAUDE.md в корне — вкладка «Правила»',
      lines: [
        'Текст целиком, одним полем: отдельных правил, тумблеров и групп у проектного уровня нет.',
        // Угловые скобки — двойным экранированием: одинарное `&lt;` доезжает до
        // разметки карточки как настоящий `<`, и браузер съедает «<id>» как
        // неизвестный тег. Проверено на этой самой строке.
        'Перед записью — резервная копия под именем project-&amp;lt;id&amp;gt;-CLAUDE.md, чтобы она не смешалась с копиями личного файла.',
      ],
    },
    {
      id: 'p1:edit:mcp',
      title: '.mcp.json в корне — вкладка «MCP-серверы»',
      lines: [
        'Серверы проекта: тот же формат, что у личных, и тот же редактор.',
        'Файл лежит в корне репозитория и обычно коммитится — правка видна всей команде.',
      ],
    },
    {
      id: 'p1:edit:settings',
      title: '.claude/settings.json — вкладка «Права»',
      lines: [
        'Разрешено, спросить, запрещено — список шаблонов проекта.',
        'Запись с пометкой «личное» уходит в .claude/settings.local.json: этот файл в гит обычно не попадает.',
      ],
    },
  ],
  { w: 440, y: 420 },
);

const read = column(
  p1,
  'p1:read',
  C.check,
  560,
  'Панель только показывает',
  'собственный .claude проекта — вкладка «Из проекта»',
  [
    {
      id: 'p1:read:skills',
      title: '.claude/skills/ — скиллы репозитория',
      lines: [
        'Имя, описание, число файлов и пометка «выключен» — всё, что видно.',
        'Тумблера нет: набор принадлежит гиту проекта и правится там, как остальной код.',
      ],
    },
    {
      id: 'p1:read:hooks',
      title: '.claude/hooks/ и хуки из settings.json',
      lines: [
        'Событие, фильтр, команда и имя файла настроек, из которого хук пришёл.',
        'Ссылка на скрипт, которого нет на диске, помечается «скрипт не найден» — молча такое не находят.',
      ],
    },
    {
      id: 'p1:read:rules',
      title: '.claude/rules/ — файлы правил',
      lines: [
        'Заголовок, путь файла и маски путей, к которым правило привязано.',
        'Текст раскрывается кнопкой рядом с заголовком; вложенные каталоги показываются путём, а не только именем.',
      ],
    },
  ],
  { w: 440, y: 420 },
);

const cliY = Math.max(edit.y + edit.h, read.y + read.h) + 90;

card(p1, 'p1:cli', 60, cliY, 440, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Claude Code в этом каталоге',
  lines: [
    'При старте сессии читает личный уровень (~/.claude) И проектный — оба набора складываются в один.',
    'Открытая сессия новую редакцию не увидит: файлы читаются один раз при запуске.',
  ],
});

card(p1, 'p1:levels', 560, cliY, 440, {
  pal: C.warn,
  title: 'Выключить проектное нечем',
  lines: [
    'Тумблеры, группы и песочница есть у личного уровня. У проектного их нет ни на одной вкладке.',
    'Единственный способ убрать проектное правило или хук — изменить файл репозитория: это решение команды, а не панели.',
  ],
});

card(p1, 'p1:git', 1000, cliY, 400, {
  pal: C.note,
  soft: true,
  title: 'Это обычные файлы репозитория',
  lines: [
    'Правка из панели, правка руками и правка, сделанная самим агентом, видны здесь одинаково — своей базы у панели нет.',
    'Сохранение — это коммитируемое изменение в чужом рабочем дереве: оно уедет в ветку вместе с кодом.',
  ],
});

link(p1, 'p1:add', 'p1:registry', 'открыть папку как проект', {
  colour: FLOW.human,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p1, 'p1:registry', 'p1:edit', 'сохранение на вкладке — с резервной копией', {
  colour: FLOW.data,
  exit: [0.2, 1],
  entry: [0.7, 0],
});
link(p1, 'p1:registry', 'p1:read', 'чтение, без единой записи', {
  colour: FLOW.fwd,
  exit: [0.8, 1],
  entry: [0.4, 0],
});
link(p1, 'p1:edit', 'p1:cli', 'читается при старте сессии', {
  colour: FLOW.fwd,
  exit: [0.3, 1],
  entry: [0.3, 0],
});
link(p1, 'p1:read', 'p1:cli', 'подхватывается тем же стартом', {
  colour: FLOW.fwd,
  exit: [0.2, 1],
  entry: [0.8, 0],
  points: [{ x: registry.cx - 120, y: cliY - 40 }],
});

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'человек и его решение', fill: C.human.tint, stroke: C.human.line },
  { caption: 'панель и её состояние', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'файлы, которые панель правит', stage: C.store },
  { caption: 'то, что она только показывает', stage: C.check },
  { caption: 'агентный CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'то, о что спотыкаются', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'запись на диск', edgeColour: FLOW.data },
  { caption: 'чтение и путь дальше', edgeColour: FLOW.fwd },
]);

// ─── Страница 2: один реестр, разные файлы ─────────────────────────────────

const p2 = newPage('2. Тот же проект у другого CLI', 'p2');
heading(
  p2,
  60,
  30,
  'Один реестр — разные файлы',
  'Запись о проекте общая для всех CLI. Вкладки его карточки называются файлами активного: у каждого CLI свой файл инструкций и свой формат конфига.',
  1340,
);

card(p2, 'p2:registry', 560, 130, 440, {
  pal: C.panel,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'state',
  title: 'Реестр панели: путь и имя',
  lines: [
    'Одна запись на проект. Смена активного CLI её не трогает — список проектов остаётся тем же.',
    'Активный CLI выбирается в «Настройки → Провайдеры», и карточка проекта перерисовывается под него.',
  ],
});

const claude = column(
  p2,
  'p2:claude',
  C.cli,
  60,
  'Claude Code',
  'вкладки: Правила · MCP-серверы · Права · Из проекта',
  [
    {
      id: 'p2:claude:md',
      title: 'CLAUDE.md',
      lines: ['Инструкции проекта. Правятся текстом целиком, с резервной копией перед записью.'],
    },
    {
      id: 'p2:claude:mcp',
      title: '.mcp.json — формат JSON',
      lines: ['Серверы проекта в корне репозитория.'],
    },
    {
      id: 'p2:claude:perm',
      title: '.claude/settings.json',
      lines: ['Права проекта; записи с пометкой «личное» — в .claude/settings.local.json.'],
    },
    {
      id: 'p2:claude:local',
      title: 'Вкладка «Из проекта» — только у Claude',
      lines: [
        'Собственный .claude репозитория: скиллы, хуки, файлы правил. У остальных CLI такой вкладки нет вовсе.',
      ],
    },
  ],
  { w: 440, y: 420 },
);

const codex = column(
  p2,
  'p2:codex',
  C.group,
  560,
  'Codex CLI (пример чужого)',
  'вкладки: AGENTS.md · MCP-серверы',
  [
    {
      id: 'p2:codex:md',
      title: 'AGENTS.md',
      lines: [
        'Тот же проект, другой файл инструкций. Панель прямо называет его в шапке вкладки и в подсказке о перезапуске.',
      ],
    },
    {
      id: 'p2:codex:mcp',
      title: '.codex/config.toml — формат TOML',
      lines: [
        'Серверы того же проекта, но другой файл и другой синтаксис: панель пишет в его формате, а не в JSON.',
      ],
    },
    {
      id: 'p2:codex:sections',
      title: 'Список вкладок решает сервер',
      lines: [
        'Разделы приходят от панели по возможностям провайдера, а не подбираются в браузере: чего у CLI нет, того и не покажут.',
      ],
    },
  ],
  { w: 440, y: 420 },
);

const noteY = Math.max(claude.y + claude.h, codex.y + codex.h) + 80;

card(p2, 'p2:apart', 60, noteY, 440, {
  pal: C.warn,
  title: 'Файлы не связаны между собой',
  lines: [
    'Правка CLAUDE.md не попадает в AGENTS.md и наоборот: это два разных файла одного репозитория.',
    'Проект, с которым работают двумя CLI, инструкции держит в двух местах — и расходятся они молча.',
  ],
});

card(p2, 'p2:restart', 560, noteY, 440, {
  pal: C.note,
  soft: true,
  title: 'Перезапуск называется по имени CLI',
  lines: [
    'Строка под редактором говорит «изменения применятся после перезапуска Codex CLI» — именно того CLI, чей файл вы только что сохранили.',
  ],
});

card(p2, 'p2:experimental', 1060, 130, 340, {
  pal: C.note,
  soft: true,
  title: 'Полоса «экспериментально»',
  lines: [
    'Проверен и поддержан полностью только Claude Code. У остальных CLI панель честно предупреждает об этом сверху страницы.',
  ],
});

link(p2, 'p2:registry', 'p2:claude', 'активный CLI — Claude Code', {
  colour: FLOW.fwd,
  exit: [0.2, 1],
  entry: [0.7, 0],
});
link(p2, 'p2:registry', 'p2:codex', 'активный CLI — другой', {
  colour: FLOW.fwd,
  exit: [0.8, 1],
  entry: [0.4, 0],
});

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'панель и её состояние', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'файлы Claude Code', stage: C.cli },
  { caption: 'файлы чужого CLI', stage: C.group },
  { caption: 'то, о что спотыкаются', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'что показывает карточка', edgeColour: FLOW.fwd },
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
