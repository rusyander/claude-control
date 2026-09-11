/**
 * Схемы путеводителя «MCP-серверы». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/mcp-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают — высота карточки
 * считается по её тексту, а место подписи ребра подбирается перебором свободных
 * коридоров. Ни то, ни другое в рукописном XML не держится.
 *
 * Служебный слой — тот же, что в `docs/diagrams/rules-guide/generate.mjs`: это
 * принятая в репозитории форма схемы справки. Общей библиотеки у наборов нет
 * намеренно — набор читается одним файлом, и правка в одном разделе справки не
 * двигает картинки в другом.
 *
 * Две страницы, и только две: схема появляется там, где снимок бессилен.
 *
 * Страница 1 — что происходит по кнопке «Проверить». На карточке видна плашка и
 *              одна строка причины; по какой развилке панель к ней пришла и
 *              почему из двух одинаковых отказов 401 выводятся разные советы —
 *              не видно ниоткуда.
 * Страница 2 — кто на самом деле держит сервер. Панель звонит и кладёт трубку,
 *              а работает сервер внутри сессии Claude Code; отсюда и «добавил, а
 *              у агента его нет».
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
// ─── Страница 1: что делает кнопка «Проверить» ─────────────────────────────

const p1 = newPage('1. Проверка связи', 'p1');
heading(
  p1,
  60,
  30,
  'Что происходит по кнопке «Проверить»',
  'Панель ведёт настоящее рукопожатие MCP тем же клиентом, что и Claude Code. Плашка на карточке — итог этого обмена, а не пересказ записи.',
  1100,
);

const LX = 60;
const LW = 400;
const MX = 560;
const MW = 400;
const RX = 1060;
const RW = 400;

const record = card(p1, 'p1:record', LX, 150, LW, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'json',
  title: 'Запись сервера в ~/.claude.json',
  lines: [
    'mcpServers — включённые, mcpServersDisabled — выключенные. Файл лежит РЯДОМ с каталогом .claude, а не внутри него.',
    'Транспорт, команда с аргументами или адрес, переменные окружения и заголовки запроса.',
  ],
});

const expand = card(p1, 'p1:expand', LX, record.y + record.h + 80, LW, {
  pal: C.panel,
  icon: 'shape=hexagon',
  iconText: '${}',
  title: 'Подстановка ссылок ${VAR}',
  lines: [
    'Основа — окружение самой панели, поверх него settings.json → env, поверх — settings.local.json → env, и последним словом .mcp-secrets.env.',
    'Понимается и запасное значение: ${VAR:-по умолчанию}.',
  ],
});

card(p1, 'p1:transport', LX, expand.y + expand.h + 80, LW, {
  pal: C.panel,
  icon: 'shape=hexagon',
  iconText: 'связь',
  title: 'Соединение по транспорту записи',
  lines: [
    'stdio — панель запускает процесс сама и говорит с ним по потокам; на рукопожатие отведено 45 секунд.',
    'sse и http — обычный запрос по адресу, таймаут из настроек приложения.',
  ],
});

const handshake = card(p1, 'p1:handshake', MX, 150, MW, {
  pal: C.check,
  icon: 'shape=process',
  iconText: 'MCP',
  title: 'initialize, затем tools/list',
  lines: [
    'Два сообщения протокола официальным клиентом SDK. Сервер, который на MCP не говорит, рукопожатие не пройдёт, чем бы он ни был.',
    'Сразу после ответа сессия закрывается: панель не держит сервер работающим.',
  ],
});

const badge = card(p1, 'p1:badge', MX, handshake.y + handshake.h + 80, MW, {
  pal: C.human,
  title: 'Плашка «Отвечает: N инструментов»',
  lines: [
    'N — длина списка, пришедшего в ответ на tools/list. Это и есть то, что сервер умеет.',
    'Кнопка «Инструменты» спрашивает тот же список заново и превращает отмеченное в права mcp__<сервер>__<инструмент>.',
  ],
});

card(p1, 'p1:saved', MX, badge.y + badge.h + 80, MW, {
  pal: C.store,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'state',
  title: 'Итог сохраняется у панели',
  lines: [
    'agentdeck/state.json → mcpHealth. После F5 карточка показывает итог ПРОШЛОЙ проверки, а не «не проверялся».',
    'Проверка не запускается сама при открытии раздела: поднять чужой сервер стоит времени, а серверов бывает много. Включается настройкой.',
  ],
});

const noVar = card(p1, 'p1:novar', RX, 150, RW, {
  pal: C.warn,
  title: 'Переменной нет ни в одном источнике',
  lines: [
    'Проверка обрывается ДО соединения и называет имя: «Не заданы переменные ${BILLING_TOKEN}».',
    'Иначе сервер получил бы буквальную строку «Bearer ${BILLING_TOKEN}», честно ответил 401 — и карточка позвала бы авторизоваться вместо того, чтобы завести переменную.',
  ],
});

const noCmd = card(p1, 'p1:nocmd', RX, noVar.y + noVar.h + 60, RW, {
  pal: C.warn,
  title: 'Процесс не запустился',
  lines: [
    'Причина — словами системы: команды нет в PATH, нет прав, упала при старте.',
    'К ней прикладывается stderr самого сервера, прочитанный с запасом на кодировку консоли Windows.',
  ],
});

card(p1, 'p1:401', RX, noCmd.y + noCmd.h + 60, RW, {
  pal: C.warn,
  title: 'Сервер ответил 401',
  lines: [
    'Свой заголовок Authorization в записи ЕСТЬ — значит, токен отвергнут: «проверьте токен в заголовках».',
    'Заголовка НЕТ — значит, сервер зовёт войти: «требуется авторизация OAuth». Кнопка «Авторизоваться» верна только здесь.',
    'У stdio этой развилки нет вовсе: авторизоваться там негде, а «401» в чужом логе — просто текст.',
  ],
});

link(p1, 'p1:record', 'p1:expand', 'что записано', { colour: FLOW.data });
link(p1, 'p1:expand', 'p1:transport', 'всё подставилось', { colour: FLOW.fwd });
link(p1, 'p1:transport', 'p1:handshake', 'соединение открыто', {
  colour: FLOW.fwd,
  exit: [1, 0.5],
  entry: [0, 0.8],
});
link(p1, 'p1:handshake', 'p1:badge', 'список инструментов', { colour: FLOW.fwd });
link(p1, 'p1:badge', 'p1:saved', 'итог', { colour: FLOW.data });
link(p1, 'p1:expand', 'p1:novar', 'имя не нашлось', {
  colour: FLOW.back,
  dashed: true,
  exit: [1, 0.3],
  entry: [0, 0.5],
});
link(p1, 'p1:transport', 'p1:nocmd', 'stdio не стартовал', {
  colour: FLOW.back,
  dashed: true,
  exit: [1, 0.3],
  entry: [0, 0.5],
});
link(p1, 'p1:transport', 'p1:401', 'сеть ответила отказом', {
  colour: FLOW.back,
  dashed: true,
  exit: [1, 0.8],
  entry: [0, 0.5],
});

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'файлы на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'панель', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'протокол MCP', fill: C.check.tint, stroke: C.check.line },
  { caption: 'что видно на карточке', fill: C.human.tint, stroke: C.human.line },
  { caption: 'отказ и его причина', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'дальше по пути', edgeColour: FLOW.fwd },
  { caption: 'чтение и запись', edgeColour: FLOW.data },
  { caption: 'проверка оборвалась', edgeColour: FLOW.back, dashed: true },
]);

// ─── Страница 2: кто держит сервер ─────────────────────────────────────────

const p2 = newPage('2. Кто держит сервер', 'p2');
heading(
  p2,
  60,
  30,
  'Кто на самом деле запускает сервер',
  'Панель правит файл и умеет позвонить. Держит серверы Claude Code — и берёт их состав один раз, при старте сессии.',
  1100,
);

const panel = card(p2, 'p2:panel', 60, 150, 400, {
  pal: C.panel,
  icon: 'shape=hexagon',
  iconText: 'панель',
  title: 'Панель',
  lines: [
    'Пишет ~/.claude.json, проверяет связь, спрашивает список инструментов.',
    'Ни один сервер не остаётся работать после проверки: сессия закрывается сразу, процесс гасится.',
  ],
});

card(p2, 'p2:file', 560, 150, 400, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'json',
  title: '~/.claude.json',
  lines: [
    'Единственное, что связывает панель и агента. Своей базы серверов у панели нет.',
    'Тот же файл правят руками и командой claude mcp — панель показывает результат одинаково.',
  ],
});

const cli = card(p2, 'p2:cli', 1060, 150, 400, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Claude Code',
  lines: [
    'При старте поднимает каждый ВКЛЮЧЁННЫЙ сервер как свой подпроцесс и держит его всю сессию.',
    'Сервер, добавленный только что, появится у агента после перезапуска — это и значит надпись «Изменения применятся после перезапуска».',
  ],
});

card(p2, 'p2:server', 1060, cli.y + cli.h + 80, 400, {
  pal: C.check,
  icon: 'shape=process',
  iconText: 'MCP',
  title: 'Сам MCP-сервер',
  lines: [
    'Чужой процесс или чужой адрес: панель в нём ничего не настраивает и ничего о нём не знает, кроме того, что он сам расскажет.',
    'Его инструменты приходят агенту под именами mcp__<сервер>__<инструмент> — отсюда и вид правил доступа.',
  ],
});

card(p2, 'p2:perms', 560, cli.y + cli.h + 80, 400, {
  pal: C.group,
  title: 'Права — отдельный слой',
  lines: [
    '«Сервер отвечает» не значит «им можно пользоваться»: вызов каждого инструмента проходит через права доступа.',
    'mcp__orders разрешает сервер целиком, mcp__orders__refund_order — один инструмент. Запрет на инструмент сильнее разрешения на сервер.',
  ],
});

const off = card(p2, 'p2:off', 60, panel.y + panel.h + 80, 400, {
  pal: C.warn,
  title: 'Выключенный сервер',
  lines: [
    'Запись переезжает в mcpServersDisabled того же файла: Claude Code её не видит.',
    'Настройки сохраняются целиком — тумблер возвращает сервер ровно таким, каким он был.',
  ],
});

card(p2, 'p2:secrets', 60, off.y + off.h + 70, 400, {
  pal: C.note,
  soft: true,
  title: 'Токен живёт не здесь',
  lines: [
    '~/.claude.json — не место для секрета: файл читают и панель, и агент, и соседние инструменты.',
    'В поля пишут ссылку ${VAR}, а значение заводят в разделе «Переменные» — в .mcp-secrets.env.',
  ],
});

link(p2, 'p2:panel', 'p2:file', 'запись и проверка', {
  colour: FLOW.data,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p2, 'p2:file', 'p2:cli', 'читается при старте сессии', {
  colour: FLOW.fwd,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p2, 'p2:cli', 'p2:server', 'запускает и держит', { colour: FLOW.fwd });
link(p2, 'p2:server', 'p2:perms', 'вызов инструмента', {
  colour: FLOW.fwd,
  exit: [0, 0.5],
  entry: [1, 0.5],
});
link(p2, 'p2:off', 'p2:file', 'тумблер переносит запись', {
  colour: FLOW.human,
  exit: [1, 0.4],
  entry: [0, 0.85],
});

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'панель', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'файл на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'агентный CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'чужой процесс или адрес', fill: C.check.tint, stroke: C.check.line },
  { caption: 'права доступа', fill: C.group.tint, stroke: C.group.line },
  { caption: 'у агента этого нет', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'дальше по пути', edgeColour: FLOW.fwd },
  { caption: 'чтение и запись', edgeColour: FLOW.data },
  { caption: 'действие человека', edgeColour: FLOW.human },
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
