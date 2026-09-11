/**
 * Схемы путеводителя «Хуки». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/hooks-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают — высота карточки
 * считается по её тексту, а место подписи ребра подбирается перебором свободных
 * коридоров. Ни то, ни другое в рукописном XML не держится.
 *
 * Служебный слой — тот же, что в `docs/diagrams/rules-guide/generate.mjs`: это
 * принятая в репозитории форма схемы справки. Общей библиотеки у наборов нет
 * намеренно — набор читается одним файлом.
 *
 * Страниц две, и обе про то, чего не видно ни в одном состоянии экрана. Первая —
 * момент события: фильтр, запуск, код возврата, и главное — что двойка
 * останавливает действие ТОЛЬКО на двух событиях из девяти, а на остальных лишь
 * пишет в журнал. Вторая — где живёт хук: у него две части в разных файлах, и
 * пока это не нарисовано, выключение выглядит потерей, а удаление хука —
 * уборкой скрипта.
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

// ─── Страница 1: что происходит в момент события ───────────────────────────

const p1 = newPage('Момент события', 'p1');
heading(
  p1,
  60,
  30,
  'Что происходит в момент события',
  'Хук — не просьба к модели, а код, который выполнит сам CLI. Запретить он может только на двух событиях из девяти.',
  1200,
);

const AX = 60;
const AW = 400;
const BX = 560;
const BW = 420;
const CX = 1080;
const CW = 420;

const event = card(p1, 'h:event', AX, 150, AW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Случилось событие',
  lines: [
    'Одно из девяти: перед вызовом инструмента, после него, при отправке сообщения, при старте и конце сессии, перед сжатием контекста и так далее.',
    'Модель в этом не участвует: событие возникает само, и хук выполнится независимо от того, что она решила.',
  ],
});

const matcher = card(p1, 'h:matcher', AX, event.y + event.h + 55, AW, {
  pal: C.check,
  icon: 'shape=hexagon',
  iconText: '|',
  title: 'Фильтр по инструменту',
  lines: [
    'Есть у четырёх событий из девяти. В форме он выбирается галочками, в файл уходит склеенным через вертикальную черту.',
    'У остальных событий фильтра нет — там хук срабатывает всегда.',
  ],
});

card(p1, 'h:missing', AX, matcher.y + matcher.h + 55, AW, {
  pal: C.warn,
  title: 'Файла скрипта нет',
  lines: [
    'Ошибки не будет — просто ничего не произойдёт, и именно так «хук молча не сработал» и выглядит.',
    'Панель считает это поломкой: карточка краснеет пометкой, и на «Обзоре» краснеет вся плитка хуков.',
  ],
});

const run = card(p1, 'h:run', BX, 150, BW, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'sh',
  title: 'Запускается команда хука',
  lines: [
    'Обычная команда оболочки. Панель, создавая скрипт сама, подставляет сюда абсолютный путь к файлу в hooks/.',
    'Таймаут — в секундах; пусто означает умолчание Claude Code, 60.',
  ],
});

const stdin = card(p1, 'h:stdin', BX, run.y + run.h + 55, BW, {
  pal: C.group,
  icon: 'shape=parallelogram;perimeter=parallelogramPerimeter;fixedSize=1',
  iconText: 'json',
  title: 'Событие приходит в stdin',
  lines: [
    'JSON с именем инструмента, его аргументами, путями файлов — всем, на что скрипт может посмотреть.',
    'Скрипт пишет ответ в stdout и причину в stderr: ничего дополнительного подключать не нужно.',
  ],
});

card(p1, 'h:probe', BX, stdin.y + stdin.h + 55, BW, {
  pal: C.panel,
  title: 'Песочница панели — тот же вход',
  lines: [
    'Прогон подаёт скрипту такое же событие, только заготовленное: безопасная команда, разрушительная, запись токена.',
    'Видно вывод, код возврата и решение — сразу и без расхода лимита.',
  ],
});

const exit = card(p1, 'h:exit', CX, 150, CW, {
  pal: C.check,
  icon: 'shape=hexagon',
  iconText: '0/2',
  title: 'Код возврата',
  lines: [
    'Ноль — работа идёт дальше. Двойка — отказ, и текст из stderr объясняет причину.',
    'Второй способ ответить — напечатать в stdout решение с полем permissionDecision: deny, ask или allow; код возврата тогда не важен.',
  ],
});

const block = card(p1, 'h:block', CX, exit.y + exit.h + 55, CW, {
  pal: C.warn,
  icon: 'shape=hexagon',
  iconText: 'stop',
  title: 'Действие остановлено',
  lines: [
    'Только на PreToolUse и UserPromptSubmit: перед вызовом инструмента и на отправке вашего сообщения.',
    'Это и есть место, где ставят страж на rm -rf или на запись токена в файл.',
  ],
});

card(p1, 'h:log', CX, block.y + block.h + 55, CW, {
  pal: C.note,
  title: 'На остальных семи — только журнал',
  lines: [
    'Та же двойка здесь ничего не останавливает: после записи файла останавливать уже нечего.',
    'Поэтому «код возврата 2 запрещает» — правило неполное, и половина вопросов про хуки растёт отсюда.',
  ],
});

link(p1, 'h:event', 'h:matcher', 'сначала фильтр', {
  colour: FLOW.fwd,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p1, 'h:matcher', 'h:run', 'инструмент подошёл', {
  colour: FLOW.fwd,
  exit: [1, 0.3],
  entry: [0, 0.7],
});
link(p1, 'h:run', 'h:stdin', 'запуск', { colour: FLOW.data, exit: [0.5, 1], entry: [0.5, 0] });
link(p1, 'h:run', 'h:missing', 'файла нет', {
  colour: FLOW.back,
  dashed: true,
  exit: [0, 0.8],
  entry: [1, 0.2],
});
link(p1, 'h:stdin', 'h:exit', 'ответ скрипта', {
  colour: FLOW.fwd,
  exit: [1, 0.2],
  entry: [0, 0.8],
});
link(p1, 'h:exit', 'h:block', 'двойка на двух событиях', {
  colour: FLOW.fwd,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p1, 'h:exit', 'h:log', 'двойка на остальных', {
  colour: FLOW.back,
  dashed: true,
  exit: [1, 0.8],
  entry: [1, 0.3],
  points: [{ x: CX + CW + 60, y: exit.y + exit.h + 20 }],
});

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'агентный CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'проверка и решение', fill: C.check.tint, stroke: C.check.line },
  { caption: 'файл на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'данные события', fill: C.group.tint, stroke: C.group.line },
  { caption: 'что видно на экране', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'отказ и поломка', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'ход выполнения', edgeColour: FLOW.fwd },
  { caption: 'кто что читает', edgeColour: FLOW.data },
  { caption: 'ничего не происходит', edgeColour: FLOW.back, dashed: true },
]);

// ─── Страница 2: где живёт хук ─────────────────────────────────────────────

const p2 = newPage('Где живёт хук', 'p2');
heading(
  p2,
  60,
  30,
  'Где живёт хук: две части в разных местах',
  'Запись о событии и код — разные файлы с разными хозяевами. Отсюда и выключение, похожее на пропажу, и удаление, не трогающее скрипт.',
  1200,
);

const form = card(p2, 'w:form', AX, 150, AW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Форма хука',
  lines: [
    'Событие, фильтр, шаблон, таймаут — и имя файла скрипта. Если оно задано, панель создаёт файл сама и подставляет команду запуска.',
    'Имя занято ⇒ отказ, а не запись поверх: чужой скрипт остаётся целым.',
  ],
});

const toggle = card(p2, 'w:toggle', AX, form.y + form.h + 55, AW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'on/off',
  title: 'Тумблер и стрелки порядка',
  lines: [
    'Стрелки меняют порядок строк внутри одного события — он же порядок выполнения. Порядок самих событий определяет CLI.',
    'У записи из личного файла тумблера нет: выключение означало бы удаление строки оттуда.',
  ],
});

card(p2, 'w:delete', AX, toggle.y + toggle.h + 55, AW, {
  pal: C.warn,
  icon: 'shape=card',
  iconText: 'del',
  title: 'Удаление хука',
  lines: [
    'Убирает ЗАПИСЬ. Файл скрипта остаётся в hooks/ и виден в разделе «Скрипты» с пометкой «не привязан».',
    'Так и задумано: один файл может обслуживать несколько хуков.',
  ],
});

const settings = card(p2, 'w:settings', BX, 150, BW, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'json',
  title: '~/.claude/settings.json → hooks',
  lines: [
    'Событие → фильтр → команды. Панель разворачивает это в плоский список, а идентификатор строки считает от события и содержимого.',
    'Перед каждой записью в backups/ ложится копия файла целиком, с чужими ключами.',
  ],
});

const local = card(p2, 'w:local', BX, settings.y + settings.h + 55, BW, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'local',
  title: 'settings.local.json',
  lines: [
    'Личный файл, который тоже читает CLI, — иначе список врал бы о том, что на самом деле сработает.',
    'Записи помечены бейджем «локальные», и правка возвращается ровно сюда: личная настройка не должна становиться общей.',
  ],
});

card(p2, 'w:scripts', BX, local.y + local.h + 55, BW, {
  pal: C.store,
  icon: 'shape=folder',
  iconText: 'hooks',
  title: '~/.claude/hooks/',
  lines: [
    'Сам код. Раздел «Скрипты» показывает эту папку целиком и считает по settings-файлам, какие файлы к чему привязаны.',
    'Правка кода действует со следующего события: перезапуск нужен только при изменении самих хуков.',
  ],
});

const state = card(p2, 'w:state', CX, 150, CW, {
  pal: C.panel,
  icon: 'shape=note;size=14',
  iconText: 'json',
  title: 'state.json панели',
  lines: [
    'Снимок выключенного хука и состав групп. Выключенная запись из settings.json уходит ЦЕЛИКОМ — иначе CLI продолжал бы её исполнять.',
    'Поэтому включение возвращает ровно то, что было, а правки файла руками в обход панели выключенных хуков не увидят.',
  ],
});

const cli2 = card(p2, 'w:cli', CX, state.y + state.h + 55, CW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Claude Code при старте сессии',
  lines: [
    'Читает оба settings-файла и складывает их хуки в один набор. Открытый разговор нового хука не увидит.',
    'Проектный .claude/settings.json — отдельная история и живёт в разделе «Проекты».',
  ],
});

card(p2, 'w:backup', CX, cli2.y + cli2.h + 55, CW, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'bak',
  title: '~/.claude/agentdeck/backups/',
  lines: [
    'Копия settings.json перед каждой записью. Отсюда состояние восстанавливается целиком.',
    'Самый грубый из способов отката — и единственный, когда файл уже правили руками.',
  ],
});

link(p2, 'w:form', 'w:settings', 'запись хука', {
  colour: FLOW.human,
  exit: [1, 0.3],
  entry: [0, 0.4],
});
link(p2, 'w:form', 'w:scripts', 'файл скрипта', {
  colour: FLOW.human,
  exit: [1, 0.7],
  entry: [0, 0.2],
});
// Поверху, коридором между рядами: напрямую линия прошла бы по тексту карточки
// про settings.local.json, к которой тумблер отношения не имеет.
const rowGapY =
  (Math.max(form.y + form.h, settings.y + settings.h, state.y + state.h) +
    Math.min(toggle.y, local.y, cli2.y)) /
  2;
link(p2, 'w:toggle', 'w:state', 'снимок выключенного', {
  colour: FLOW.human,
  exit: [0.85, 0],
  entry: [0.5, 1],
  points: [
    { x: AX + AW * 0.85, y: rowGapY },
    { x: CX + CW * 0.5, y: rowGapY },
  ],
});
link(p2, 'w:delete', 'w:settings', 'убирает строку', {
  colour: FLOW.human,
  exit: [1, 0.2],
  entry: [0, 0.9],
});
// Через коридор между колонками: напрямую вниз-направо линия прошла бы по
// тексту карточки про settings.local.json, а обе строки одинаково важны —
// CLI читает оба файла.
link(p2, 'w:settings', 'w:cli', 'при старте сессии', {
  colour: FLOW.data,
  exit: [1, 0.6],
  entry: [0, 0.3],
  points: [{ x: 1020, y: cli2.y + cli2.h * 0.3 }],
});
link(p2, 'w:local', 'w:cli', 'при старте сессии', {
  colour: FLOW.data,
  exit: [1, 0.2],
  entry: [0, 0.8],
});
link(p2, 'w:settings', 'w:backup', 'копия перед записью', {
  colour: FLOW.back,
  dashed: true,
  exit: [1, 0.8],
  entry: [0, 0.2],
});

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'действие человека', fill: C.human.tint, stroke: C.human.line },
  { caption: 'файл на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'память панели', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'агентный CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'что удаление НЕ трогает', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'кто что читает', edgeColour: FLOW.data },
  { caption: 'происходит само', edgeColour: FLOW.back, dashed: true },
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
  `${pageXml(p1, b1.w, b1.h)}\n` +
  `${pageXml(p2, b2.w, b2.h)}\n` +
  '</mxfile>\n';

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, xml, 'utf8');
console.log(
  `записано ${OUT}: ${b1.w}×${b1.h} и ${b2.w}×${b2.h}, ячеек ${p1.cells.length + p2.cells.length}`,
);
