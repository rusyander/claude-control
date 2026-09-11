/**
 * Схемы путеводителя «Файл CLAUDE.md». Источник — этот генератор, `.drawio` —
 * его вывод:
 *
 *   node docs/diagrams/claudeMd-guide/generate.mjs <абсолютный путь>.drawio
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
 * Страница 1 — уровни инструкций: где ещё лежат правила, какой из них панель
 *              правит, а какой только показывает, и почему вопрос «чьё правило
 *              главнее» решается текстом, а не механизмом. На снимке видно
 *              вкладку одного проекта, но не то, что уходит в сессию вместе.
 * Страница 2 — путь одного сохранения: сверенная версия, правка в поле, правка
 *              снаружи, расхождение, копия и запись. Карточку расхождения снять
 *              можно, а вот что панель считает «своим» и «чужим» — нет.
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
// ─── Страница 1: уровни инструкций ─────────────────────────────────────────

const p1 = newPage('1. Уровни инструкций', 'p1');
heading(
  p1,
  60,
  30,
  'Какие файлы с инструкциями читает агент',
  'Уровней три, и в сессию они уходят вместе. Панель правит первые два, третий только показывает, а старшинства между ними не назначает никто.',
  1100,
);

const LX = 60;
const LW = 380;
const MX = 560;
const MW = 380;
const RX = 1060;
const RW = 380;

const user = card(p1, 'p1:user', LX, 150, LW, {
  pal: C.human,
  icon: 'shape=note;size=14',
  iconText: 'личн',
  title: 'Личный уровень: ~/.claude/CLAUDE.md',
  lines: [
    'Действует в любом проекте на этой машине. Панель правит его двумя разделами: «Правила» — карточками, «CLAUDE.md» — текстом целиком.',
    'Тумблеры, группы и песочница есть только у этого уровня.',
  ],
});

const project = card(p1, 'p1:project', LX, user.y + user.h + 60, LW, {
  pal: C.group,
  icon: 'shape=note;size=14',
  iconText: 'проект',
  title: 'Уровень проекта: проект/CLAUDE.md',
  lines: [
    'Лежит в самом репозитории и обычно в git — его читает вся команда, а не только вы.',
    'Панель правит его текстом: «Проекты» → карточка проекта → вкладка «Правила». Карточек, тумблеров и групп у него нет.',
  ],
});

card(p1, 'p1:local', LX, project.y + project.h + 60, LW, {
  pal: C.check,
  icon: 'shape=folder',
  iconText: 'из проекта',
  title: 'Файлы проекта: проект/.claude/',
  lines: [
    'Правила rules/*.md, навыки и хуки самого проекта. Вкладка «Из проекта» показывает их списком и открывает на чтение.',
    'Панель их не правит и не выключает: это файлы проекта, а не её настройки. Поэтому у них нет ни тумблера, ни группы.',
  ],
});

const session = card(p1, 'p1:session', MX, 150, MW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Старт сессии Claude Code',
  lines: [
    'Все доступные файлы читаются ОДИН раз, при запуске, и попадают в один контекст — целиком, как текст.',
    'Личный читается всегда; проектные — когда сессия запущена в этом каталоге. В чате панели каталог сессии виден в шапке.',
  ],
});

const answer = card(p1, 'p1:answer', MX, session.y + session.h + 90, MW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'ответ',
  title: 'Ответы этой сессии',
  lines: [
    'Действуют все уровни сразу: проектный не заменяет личный, а добавляется к нему.',
    'Правило — постоянная инструкция, а не запрет на уровне системы: оно меняет поведение, но ничего не блокирует.',
  ],
});

card(p1, 'p1:order', MX, answer.y + answer.h + 60, MW, {
  pal: C.warn,
  weight: 3,
  title: 'Старшинства между уровнями нет',
  lines: [
    'Панель не ранжирует файлы, ничего из них не вырезает и не решает, чьё правило сильнее: в сессию уходит текст всех уровней.',
    'Две формулировки, которые спорят, агент разбирает как текст. Значит исключение пишут словами и в том файле, где оно уместно: «в этом проекте — иначе, чем в личном правиле».',
  ],
});

const cannot = card(p1, 'p1:cannot', RX, 150, RW, {
  pal: C.warn,
  title: 'Чего проектный уровень не может',
  lines: [
    'Выключить личное правило. Тумблер и служебный раздел «Отключённые правила» есть только в личном файле, и проектный текст до них не дотягивается.',
    'Убрать личное правило из сессии тоже нечем: файл читается целиком. Проектный уровень только добавляет свой текст.',
  ],
});

const overlay = card(p1, 'p1:overlay', RX, cannot.y + cannot.h + 60, RW, {
  pal: C.panel,
  title: 'Что панель держит у себя',
  lines: [
    'Отметки о выключении и состав групп лежат в её собственном state.json.',
    'Это не четвёртый уровень инструкций: Claude Code этот файл не читает. Он решает только одно — как панель соберёт личный CLAUDE.md при следующей записи.',
  ],
});

card(p1, 'p1:reach', RX, overlay.y + overlay.h + 60, RW, {
  pal: C.note,
  soft: true,
  title: 'Когда правка доходит до агента',
  lines: [
    'На старте следующей сессии. Открытый разговор новую редакцию не увидит — ни личную, ни проектную: это граница сессии, а не сбой.',
    'В чате панели новую редакцию берёт новый чат или «Перезапустить сессию» в меню шапки.',
  ],
});

link(p1, 'p1:user', 'p1:session', 'всегда', {
  colour: FLOW.fwd,
  exit: [1, 0.4],
  entry: [0, 0.3],
});
link(p1, 'p1:project', 'p1:session', 'если сессия здесь', {
  colour: FLOW.fwd,
  exit: [1, 0.4],
  entry: [0, 0.6],
});
link(p1, 'p1:local', 'p1:session', 'вместе с ним', {
  colour: FLOW.fwd,
  exit: [1, 0.4],
  entry: [0, 0.9],
});
link(p1, 'p1:session', 'p1:answer', 'один контекст', { colour: FLOW.fwd });

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  {
    caption: 'личный уровень — панель правит карточками',
    fill: C.human.tint,
    stroke: C.human.line,
  },
  { caption: 'уровень проекта — панель правит текстом', fill: C.group.tint, stroke: C.group.line },
  { caption: 'файлы проекта — только чтение', fill: C.check.tint, stroke: C.check.line },
  { caption: 'панель', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'агентный CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'то, о что спотыкаются', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'дальше по пути', edgeColour: FLOW.fwd },
]);

// ─── Страница 2: сохранение и расхождение ──────────────────────────────────

const p2 = newPage('2. Сохранение и расхождение', 'p2');
heading(
  p2,
  60,
  30,
  'Что происходит между полем и файлом',
  'Текст в поле — ваш черновик, файл на диске живёт своей жизнью. Расхождение — это не ошибка, а честный вопрос: чей текст верен.',
  1100,
);

const AX = 60;
const AW = 380;
const BX = 560;
const BW = 380;
const CX = 1060;
const CW = 380;

const open = card(p2, 'p2:open', AX, 150, AW, {
  pal: C.panel,
  icon: 'shape=process',
  iconText: 'старт',
  title: 'Страница открылась',
  lines: [
    'Панель прочла файл и запомнила эту версию как сверенную.',
    'Пока текст в поле совпадает со сверенной версией, несохранённых правок нет — и любая новая версия с диска просто заменит поле.',
  ],
});

const edit = card(p2, 'p2:edit', AX, open.y + open.h + 70, AW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Правка в поле',
  lines: [
    'Живёт только в браузере: под полем появляется пометка «есть несохранённые правки» рядом со счётчиком символов.',
    'На диске пока ничего не изменилось. Уйти со страницы — потерять правку.',
  ],
});

const outside = card(p2, 'p2:outside', AX, edit.y + edit.h + 70, AW, {
  pal: C.warn,
  icon: 'shape=note;size=14',
  iconText: 'извне',
  title: 'Файл изменили снаружи',
  lines: [
    'Обычное дело: тот же файл правит раздел «Правила» в соседней вкладке, чужой редактор и сам Claude Code.',
    'Наблюдатель файлов приносит новую версию сразу, без обновления страницы.',
  ],
});

card(p2, 'p2:conflict', BX, outside.y - 30, BW, {
  pal: C.warn,
  weight: 3,
  title: 'Расхождение: правка есть, диск ушёл вперёд',
  lines: [
    'Панель НЕ заменяет поле: сверху появляется карточка «файл изменился на диске» и одна кнопка — «Загрузить с диска».',
    'Кнопка берёт версию с диска целиком, вашу правку она при этом теряет. Слить две версии панель не умеет и не пытается.',
  ],
});

card(p2, 'p2:save', BX, 150, BW, {
  pal: C.panel,
  icon: 'shape=hexagon',
  iconText: 'API',
  title: 'Сохранение',
  lines: [
    'Уходит то, что в поле, целиком — файл заменяется, а не дополняется.',
    'При расхождении побеждает тот, кто сохранил последним, поэтому сначала решают, чей текст верен, и только потом жмут «Сохранить».',
  ],
});

const backup = card(p2, 'p2:backup', CX, 150, CW, {
  pal: C.store,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'bak',
  title: 'Копия — до записи',
  lines: [
    'agentdeck/backups/, имя с отметкой времени. Копия делается на каждое сохранение, даже если поменялся один символ.',
    'Хранится десять копий файла; глубину меняют в «Настройках», от 1 до 100.',
  ],
});

const write = card(p2, 'p2:write', CX, backup.y + backup.h + 70, CW, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'md',
  title: 'Атомарная запись',
  lines: [
    'Файл пишется рядом и переименовывается на место: оборванная запись не оставит половины файла.',
    'Сразу после этого наблюдатель приносит новую версию обратно в поле — сверенная версия становится равной диску.',
  ],
});

card(p2, 'p2:undo', CX, write.y + write.h + 70, CW, {
  pal: C.note,
  soft: true,
  title: 'Как вернуть прежнее',
  lines: [
    'До сохранения — кнопка «Отменить правки» рядом с «Сохранить»: поле возвращается к сверенной версии.',
    'После сохранения — только откат резервной копии в «Настройках»: копия это весь файл того момента, а не отдельная правка.',
  ],
});

card(p2, 'p2:clean', AX, outside.y + outside.h + 80, AW, {
  pal: C.note,
  soft: true,
  title: 'Если правок в поле не было',
  lines: [
    'Панель молча берёт версию с диска — никакой карточки не появляется.',
    'Показывать устаревший текст и называть его «несохранёнными правками» было бы ложью, поэтому спрашивают только там, где есть что терять.',
  ],
});

link(p2, 'p2:open', 'p2:edit', 'вы правите текст', { colour: FLOW.human });
link(p2, 'p2:edit', 'p2:save', 'кнопка «Сохранить»', {
  colour: FLOW.human,
  exit: [1, 0.4],
  entry: [0, 0.6],
});
link(p2, 'p2:outside', 'p2:conflict', 'в поле есть своя правка', {
  colour: FLOW.data,
  exit: [1, 0.4],
  entry: [0, 0.4],
});
link(p2, 'p2:outside', 'p2:clean', 'поле чистое — замена без вопросов', {
  colour: FLOW.back,
  dashed: true,
});
link(p2, 'p2:conflict', 'p2:edit', 'кнопка «Загрузить с диска» — правка потеряна', {
  colour: FLOW.back,
  dashed: true,
  exit: [0, 0.8],
  entry: [1, 0.8],
});
link(p2, 'p2:save', 'p2:backup', 'сначала копия', {
  colour: FLOW.data,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p2, 'p2:backup', 'p2:write', 'потом запись', { colour: FLOW.data });

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'человек и его правка', fill: C.human.tint, stroke: C.human.line },
  { caption: 'панель', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'файл на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'то, о что спотыкаются', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'запись на диск', edgeColour: FLOW.data },
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
