/**
 * Схемы путеводителя «Правила». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/rules-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают — высота карточки
 * считается по её тексту, а место подписи ребра подбирается перебором свободных
 * коридоров. Ни то, ни другое в рукописном XML не держится.
 *
 * Служебный слой (палитра, карточка, легенда, раскладка рёбер) — тот
 * же, что в `docs/diagrams/chat-guide/generate.mjs`: он и есть принятая в этом
 * репозитории форма схемы справки. Общей библиотеки у наборов нет намеренно —
 * набор целиком читается одним файлом, и правка в одном разделе справки не
 * двигает картинки в другом.
 *
 * Две страницы, и только две: схема здесь появляется там, где снимок бессилен.
 *
 * Страница 1 — путь одной правки: что панель считает правилом, что она пишет в
 *              файл, когда написанное доходит до агента. На экране видно форму и
 *              список, но не разбор файла и не границу сессии.
 * Страница 2 — три состояния правила: включено, выключено, удалено. Тумблер и
 *              корзина стоят соседними кнопками и делают разное, а разницу —
 *              остаётся ли текст в файле — не показывает ни один снимок.
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
// ─── Страница 1: что панель считает правилом и что уходит в файл ───────────

const p1 = newPage('1. Правило и файл', 'p1');
heading(
  p1,
  60,
  30,
  'Что панель считает правилом',
  'Слева направо — путь одной правки. Файл остаётся обычным markdown: панель разбирает его, подменяет одно правило и собирает обратно.',
  1000,
);

const SX = 60;
const SW = 360;
const RX = 560;
const RW = 380;
const NX = 1000;
const NW = 380;

const form = card(p1, 'p1:form', SX, 140, SW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Форма правила',
  lines: [
    'Три способа ввода — простой текст, конструктор блоков, список по строке на правило.',
    'Выход у всех один: заголовок и тело в markdown. Режим влияет только на то, как удобнее вводить.',
  ],
});

const server = card(p1, 'p1:server', SX, form.y + form.h + 100, SW, {
  pal: C.panel,
  icon: 'shape=hexagon',
  iconText: 'API',
  title: 'Сервер панели',
  lines: [
    'Читает файл целиком, разбирает его на шапку и правила, подменяет одно правило и собирает файл заново.',
    'Разбор и сборка — одна линейка: что панель не считает правилом, то она и не трогает.',
  ],
});

const backup = card(p1, 'p1:backup', SX, server.y + server.h + 100, SW, {
  pal: C.store,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'bak',
  title: 'Резервная копия — до записи',
  lines: [
    'agentdeck/backups/, имя с отметкой времени. Хранится десять копий файла, глубина настраивается.',
    'Копия делается на каждое сохранение, даже если поменялся один символ.',
  ],
});

const file = card(p1, 'p1:file', SX, backup.y + backup.h + 100, SW, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'md',
  title: '~/.claude/CLAUDE.md',
  lines: [
    'Включённое правило — раздел «## ПРАВИЛО: Заголовок».',
    'Выключенное — «### Заголовок» внутри служебного раздела «## Отключённые правила (AgentDeck)».',
    'Шапка и обычные разделы остаются на своих местах.',
  ],
});

const session = card(p1, 'p1:session', RX, file.y - 40, RW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Старт сессии Claude Code',
  lines: [
    'Файл читается ОДИН раз, целиком, при запуске — и в терминале, и в чате панели.',
    'Открытый разговор новую редакцию не увидит: это не сбой, а граница сессии.',
  ],
});

card(p1, 'p1:answer', RX, session.y + session.h + 90, RW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'ответ',
  title: 'Каждый ответ следующей сессии',
  lines: [
    'Правило — постоянная инструкция, а не техническое ограничение: оно влияет на поведение, но ничего не запрещает на уровне системы.',
    'Поэтому формулировка должна быть проверяемой: «отвечать по-русски» видно сразу, «писать хорошо» — никогда.',
  ],
});

const headingNote = card(p1, 'p1:heading', NX, 140, NW, {
  pal: C.warn,
  title: 'Правилом делает только заголовок',
  lines: [
    '«## ПРАВИЛО: …» — слово в любом регистре, двоеточие обязательно.',
    '«## Язык общения», «### ПРАВИЛО: …» и «## ПРАВИЛО без двоеточия» — обычный текст: панель его не трогает и в список не берёт.',
    'Отсюда и «0 правил» в непустом файле — раздел считает такие заголовки и говорит, сколько их.',
  ],
});

const idNote = card(p1, 'p1:id', NX, headingNote.y + headingNote.h + 60, NW, {
  pal: C.note,
  soft: true,
  title: 'Идентификатор считается из заголовка',
  lines: [
    'При каждом разборе файла заново. Два правила с одинаковым заголовком получают суффикс: «-2», «-3».',
    'Переименование меняет идентификатор — ссылка /rules?id=старое-имя перестаёт открывать правило; отметки о выключении и составе групп панель переносит сама.',
  ],
});

card(p1, 'p1:nodb', NX, idNote.y + idNote.h + 60, NW, {
  pal: C.note,
  soft: true,
  title: 'Своей базы у панели нет',
  lines: [
    'Источник правды — сам файл. Правка руками, правка из соседнего раздела и правка, сделанная самим Claude Code, видны здесь одинаково.',
    'Своё у панели только отметки: что выключено и какие правила собраны в группы.',
  ],
});

link(p1, 'p1:form', 'p1:server', 'сохранение', { colour: FLOW.human });
link(p1, 'p1:server', 'p1:backup', 'копия прежнего файла', { colour: FLOW.data });
link(p1, 'p1:backup', 'p1:file', 'атомарная запись', { colour: FLOW.data });
link(p1, 'p1:file', 'p1:session', 'читается при запуске', {
  colour: FLOW.fwd,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p1, 'p1:session', 'p1:answer', 'правило действует', { colour: FLOW.fwd });

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'человек и его решение', fill: C.human.tint, stroke: C.human.line },
  { caption: 'панель', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'файл на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'агентный CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'то, о что спотыкаются', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'запись на диск', edgeColour: FLOW.data },
  { caption: 'дальше по пути', edgeColour: FLOW.fwd },
]);

// ─── Страница 2: три состояния правила ─────────────────────────────────────

const p2 = newPage('2. Состояния правила', 'p2');
heading(
  p2,
  60,
  30,
  'Что делает тумблер, а что — корзина',
  'Выключение и удаление выглядят соседними кнопками, но делают разное. Разница — в том, остаётся ли текст в файле.',
  1000,
);

const on = card(p2, 'p2:on', 60, 150, 360, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вкл',
  title: 'Включено',
  lines: [
    'Раздел «## ПРАВИЛО: Заголовок» в основном теле файла.',
    'Claude Code читает его при старте сессии наравне с остальным текстом.',
  ],
});

card(p2, 'p2:off', 540, 150, 360, {
  pal: C.warn,
  icon: 'shape=card',
  iconText: 'выкл',
  title: 'Выключено',
  lines: [
    'Тот же текст переехал под «### Заголовок» в служебный раздел «## Отключённые правила (AgentDeck)» в конце файла.',
    'В списке правило остаётся с пометкой «Выключено», в счётчике раздела — учитывается.',
  ],
});

const gone = card(p2, 'p2:gone', 1020, 150, 360, {
  pal: C.warn,
  weight: 3,
  icon: 'shape=card',
  iconText: 'нет',
  title: 'Удалено',
  lines: [
    'Раздел вырезан из файла целиком. В списке правила больше нет, текста в файле — тоже.',
    'Вернуть можно только откатом резервной копии в разделе «Настройки»: копия — это весь файл того момента, а не одно правило.',
  ],
});

card(p2, 'p2:group', 60, 460, 360, {
  pal: C.panel,
  title: 'Группа гасит пачкой',
  lines: [
    'Тумблер группы переключает все её правила разом — ради этого группы и заводят.',
    'Отметка группы отдельная от ручной: правило, выключенное рукой, не оживёт при включении группы, а входящее в две группы оживёт, только когда его отпустят обе.',
  ],
});

card(p2, 'p2:keep', 540, 470, 360, {
  pal: C.note,
  soft: true,
  title: 'Служебный раздел — не мусор',
  lines: [
    'В нём лежит текст выключенных правил. Сотрёте раздел руками на странице CLAUDE.md — текст пропадёт, и тумблер вернуть его уже не сможет.',
    'Панель собирает этот раздел заново при каждой записи файла.',
  ],
});

card(p2, 'p2:project', 1020, 470, 360, {
  pal: C.check,
  soft: true,
  title: 'Только личный уровень',
  lines: [
    'Тумблеры, группы и песочница есть у правил из ~/.claude/CLAUDE.md.',
    'У проектного CLAUDE.md и файлов .claude/rules самого проекта их нет: панель правит первый текстом целиком, а вторые только показывает.',
  ],
});

link(p2, 'p2:on', 'p2:off', 'тумблер', {
  colour: FLOW.human,
  exit: [1, 0.35],
  entry: [0, 0.35],
});
link(p2, 'p2:off', 'p2:on', 'тумблер обратно — текст на месте', {
  colour: FLOW.back,
  dashed: true,
  exit: [0, 0.7],
  entry: [1, 0.7],
});
link(p2, 'p2:off', 'p2:gone', 'корзина', {
  colour: FLOW.human,
  exit: [1, 0.35],
  entry: [0, 0.35],
});
link(p2, 'p2:gone', 'p2:on', 'откат копии в «Настройках» — вернётся весь файл', {
  colour: FLOW.back,
  dashed: true,
  exit: [0.5, 1],
  entry: [0.5, 1],
  points: [
    { x: gone.cx, y: gone.y + gone.h + 60 },
    { x: on.cx, y: on.y + on.h + 60 },
  ],
});
link(p2, 'p2:group', 'p2:on', 'пачкой', {
  colour: FLOW.human,
  exit: [0.5, 0],
  entry: [0.5, 1],
});

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'правило действует', fill: C.human.tint, stroke: C.human.line },
  { caption: 'правило не действует', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'панель', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'другой уровень настроек', fill: C.check.tint, stroke: C.check.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'возврат к прежнему', edgeColour: FLOW.back, dashed: true },
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
