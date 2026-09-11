/**
 * Схемы документа справки «Тесты». Источник — этот генератор, `.drawio` — вывод:
 *
 *   node docs/diagrams/tests-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают — ширина коробки
 * считается по её тексту, а положение подписи ребра подбирается перебором
 * свободных мест.
 *
 * Две страницы, обе намеренно узкие: экспорт уезжает в справку, которую читают
 * и с телефона. Плотный информационный лист скилла `drawio-architect` здесь
 * был бы нечитаем — это то же осознанное отступление, что уже сделано в
 * `docs/diagrams/platform-guide`, и конвенции взяты оттуда же, а не изобретены
 * заново.
 *
 * Страница 1 — где живёт набор и кто в него пишет: у раздела нет своей базы,
 *              и запись прогона собирается из файлов кейсов.
 * Страница 2 — что краснит вердикт вехи и чего НЕ краснит карантин.
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
const FLOW = { client: '#1565C0', data: '#6D4C41', admin: '#EF6C00' };

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

/**
 * Ряд карточек ОДНОЙ высоты, посчитанной по самой длинной из них.
 *
 * Ставить карточки ряда поодиночке нельзя: высота считается по тексту, тексты
 * разной длины, и ряд выходит с рваным низом — это первое, что видит глаз на
 * готовой схеме, и первое, за что её возвращают.
 */
function row(p, y, w, xs, specs) {
  const h = Math.max(...specs.map((spec) => spec.h ?? cardH(spec, w)));
  specs.forEach((spec, i) => card(p, spec.id, xs[i], y, w, { ...spec, h }));
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
 * Порядок не косметический: подпись обязана обходить не только коробки и уже
 * поставленные подписи, но и каждую линию страницы — включая те, которых в
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
    const obstacles = [...p.V.values()].concat(placed);
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

// ─── Страница 1: где живёт набор и кто в него пишет ─────────────────────────

const p1 = newPage('1. Где живёт набор', 'p1');
heading(
  p1,
  60,
  30,
  'Где живёт набор и кто в него пишет',
  'Своей базы у раздела нет: набор — это файлы проекта, а запись прогона собирается из них же.',
  1000,
);

const A_W = 300;
const A1 = 60;
const A2 = 400;
const A3 = 740;

row(
  p1,
  130,
  A_W,
  [A1, A2, A3],
  [
    {
      id: 'p1:human',
      pal: C.actor,
      icon: 'shape=actor',
      iconText: 'QA',
      title: 'Человек',
      lines: ['Ведёт кейсы руками и проходит их шаг за шагом — в панели или с телефона.'],
    },
    {
      id: 'p1:agent',
      pal: C.front,
      icon: 'shape=process',
      iconText: 'CLI',
      title: 'Агент CLI',
      lines: [
        'Генерация, прогон, исследование, автоматизация. На время прогона ему разрешены только файлы тестов.',
      ],
    },
    {
      id: 'p1:ci',
      pal: C.ext,
      icon: 'shape=cloud',
      iconText: 'CI',
      title: 'Чужой прогон: CI',
      lines: ['Отчёт JUnit, Playwright или Allure приходит импортом — панель его не запускала.'],
    },
  ],
);

card(p1, 'p1:panel', A2, 330, A_W, {
  pal: C.edge,
  icon: 'shape=hexagon',
  iconText: 'API',
  title: 'Панель',
  lines: ['Читает и пишет файлы проекта. Ничего своего не хранит и ничего не сливает в базу.'],
});

put(p1, 'p1:filesTitle', 'Файлы проекта: .agent/tests/', textStyle(13, '#EF6C00', true), {
  x: A1,
  y: 520,
  w: 500,
  h: 24,
});

const STORE_ICON = 'shape=cylinder3;backgroundOutline=1;size=7';
row(
  p1,
  560,
  A_W,
  [A1, A2, A3],
  [
    {
      id: 'p1:cases',
      pal: C.store,
      icon: STORE_ICON,
      iconText: 'json',
      title: 'группа.tests.json',
      lines: ['Кейсы группы и последний статус каждого: пройден, провален, карантин с причиной.'],
    },
    {
      id: 'p1:runs',
      pal: C.store,
      icon: STORE_ICON,
      iconText: 'run',
      title: 'runs/идентификатор.run.json',
      lines: ['Запись прогона: кто гонял, по какой ветке и вехе, что вышло по каждому кейсу.'],
    },
    {
      id: 'p1:files',
      pal: C.store,
      icon: STORE_ICON,
      iconText: 'файлы',
      title: 'attachments, plans, views, environments',
      lines: ['Доказательства провалов, планы, сохранённые отборы и окружения стенда.'],
    },
  ],
);

card(p1, 'p1:git', A1, 760, 980, {
  pal: C.ext,
  soft: true,
  title: 'git проекта',
  lines: [
    'Кейсы и прогоны едут в коммит вместе с кодом: ветка с правкой несёт и правку кейсов, а слияние сводит их обычным способом.',
  ],
});

// Две нижние карточки разной ширины, поэтому высота выравнивается руками:
// `row` считает ряд одной ширины, а рваный низ виден одинаково в обоих случаях.
const assembled = {
  pal: C.note,
  soft: true,
  title: 'Запись прогона считается по кейсам, а не по счётчику',
  lines: [
    'В начале прогона панель запоминает отпечаток выбранных кейсов и в конце штампует те, что изменились.',
    'Кейса, которого исполнитель не тронул, в записи не будет: пустая запись — это «агент ничего не отметил», а не «панель потеряла».',
  ],
};
const secrets = {
  pal: C.warn,
  soft: true,
  title: 'Пароли стенда — не в проекте',
  lines: [
    'Окружение в файле, доступы к нему — в панели, зашифрованными. В кейс, промпт и отчёт они не попадают.',
  ],
};
const noteH = Math.max(cardH(assembled, 640), cardH(secrets, A_W));
card(p1, 'p1:assembled', A1, 920, 640, { ...assembled, h: noteH });
card(p1, 'p1:secrets', A3, 920, A_W, { ...secrets, h: noteH });

link(p1, 'p1:human', 'p1:panel', 'ручной проход', {
  colour: FLOW.client,
  exit: [0.5, 1],
  entry: [0, 0.5],
});
link(p1, 'p1:agent', 'p1:panel', 'прогон агентом', { colour: FLOW.client });
link(p1, 'p1:ci', 'p1:panel', 'импорт отчёта', {
  colour: FLOW.admin,
  exit: [0.5, 1],
  entry: [1, 0.5],
});
link(p1, 'p1:panel', 'p1:cases', 'статус кейса', {
  colour: FLOW.data,
  exit: [0, 1],
  entry: [0.5, 0],
});
link(p1, 'p1:panel', 'p1:runs', 'запись прогона', { colour: FLOW.data });
link(p1, 'p1:panel', 'p1:files', 'доказательства', {
  colour: FLOW.data,
  exit: [1, 1],
  entry: [0.5, 0],
});
link(p1, 'p1:cases', 'p1:git', 'коммитом', {
  colour: FLOW.data,
  dashed: true,
  exit: [0.2, 1],
  entry: [0.2, 0],
});
link(p1, 'p1:runs', 'p1:git', 'коммитом', {
  colour: FLOW.data,
  dashed: true,
  exit: [0.5, 1],
  entry: [0.5, 0],
});

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'значок роли карточки', fill: '#FFFFFF', stroke: C.ext.line },
  { caption: 'человек', fill: C.actor.tint, stroke: C.actor.line },
  { caption: 'агент CLI', fill: C.front.tint, stroke: C.front.line },
  { caption: 'панель', fill: C.edge.tint, stroke: C.edge.line },
  { caption: 'файл проекта', fill: C.store.tint, stroke: C.store.line },
  { caption: 'то, что вне панели', fill: C.ext.tint, stroke: C.ext.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'предупреждение', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'прогон, запущенный панелью', edgeColour: FLOW.client },
  { caption: 'результат пришёл со стороны', edgeColour: FLOW.admin },
  { caption: 'запись в файл проекта', edgeColour: FLOW.data },
  { caption: 'уезжает в коммит', edgeColour: FLOW.data, dashed: true },
]);

// ─── Страница 2: что краснит вердикт ───────────────────────────────────────

const p2 = newPage('2. Что краснит вердикт', 'p2');
heading(
  p2,
  60,
  30,
  'Что краснит вердикт вехи и чего не краснит карантин',
  'Карантин не чинит кейс и не прячет его: он снимает с кейса ровно одно право — красить вердикт и гейт.',
  1000,
);

const B_W = 420;
const B1 = 60;
const B2 = 560;

card(p2, 'p2:red', 310, 130, B_W, {
  pal: C.svc,
  icon: 'shape=process',
  iconText: 'run',
  title: 'Кейс провалился в прогоне',
  lines: [
    'Статус записан в файл кейса, заметка исполнителя — в запись прогона. Дальше всё решает одна отметка: стоит на кейсе карантин или нет.',
  ],
});

row(
  p2,
  330,
  B_W,
  [B1, B2],
  [
    {
      id: 'p2:plain',
      pal: C.warn,
      title: 'Провал без карантина',
      lines: ['Обычный красный кейс: он в счётчике провалов и в списке «чем доказаны провалы».'],
    },
    {
      id: 'p2:muted',
      pal: C.note,
      title: 'Провал в карантине: muted плюс причина',
      lines: [
        'Кейс гоняется как раньше, статус у него настоящий, причина видна прямо в строке. Без причины карантин не ставится.',
      ],
    },
  ],
);

row(
  p2,
  520,
  B_W,
  [B1, B2],
  [
    {
      id: 'p2:verdictRed',
      pal: C.svc,
      title: 'Вердикт вехи: отдавать рано',
      lines: ['Провал попадает в готовность релиза и в документ, который из неё печатают.'],
    },
    {
      id: 'p2:verdictGreen',
      pal: C.svc,
      title: 'Вердикт вехи: можно отдавать',
      lines: [
        'Карточка честно пишет, сколько кейсов в карантине, и показывает их провалы отдельным списком — просто в вердикт они не идут.',
      ],
    },
  ],
);

row(
  p2,
  710,
  B_W,
  [B1, B2],
  [
    {
      id: 'p2:gateRed',
      pal: C.warn,
      title: 'Гейт CI краснеет',
      lines: ['pnpm tests report выходит с кодом 1; в выгрузке junit кейс — обычный провал.'],
    },
    {
      id: 'p2:gateGreen',
      pal: C.ext,
      title: 'Гейт CI не краснеет',
      lines: [
        'report не считает такой кейс провалом, в junit он уезжает как skipped с причиной карантина.',
      ],
    },
  ],
);

card(p2, 'p2:back', B1, 900, 920, {
  pal: C.note,
  soft: true,
  title: 'Как вернуть кейс в строй',
  lines: [
    'Отметить кейс, действие «вернуть из карантина» — статус, история и привязки остаются на месте.',
    'Хотите красноты в гейте — снимите карантин, а не удаляйте кейс: удалённый кейс перестаёт и проверять.',
  ],
});

link(p2, 'p2:red', 'p2:plain', 'карантина нет', {
  colour: FLOW.client,
  exit: [0.2, 1],
  entry: [0.5, 0],
});
link(p2, 'p2:red', 'p2:muted', 'кейс в карантине', {
  colour: FLOW.admin,
  exit: [0.8, 1],
  entry: [0.5, 0],
});
link(p2, 'p2:plain', 'p2:verdictRed', 'идёт в вердикт', { colour: FLOW.client });
link(p2, 'p2:muted', 'p2:verdictGreen', 'в вердикт не идёт', { colour: FLOW.admin });
link(p2, 'p2:verdictRed', 'p2:gateRed', 'и в гейт', { colour: FLOW.client });
link(p2, 'p2:verdictGreen', 'p2:gateGreen', 'и в гейт', { colour: FLOW.admin });

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'значок роли карточки', fill: '#FFFFFF', stroke: C.svc.line },
  { caption: 'что делает панель', fill: C.svc.tint, stroke: C.svc.line },
  { caption: 'красное: провал и красный гейт', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'карантин и пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'зелёный гейт', fill: C.ext.tint, stroke: C.ext.line },
  { caption: 'путь обычного провала', edgeColour: FLOW.client },
  { caption: 'путь провала в карантине', edgeColour: FLOW.admin },
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
