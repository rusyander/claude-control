/**
 * Схемы путеводителя «Агент панели». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/panelAgent-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают — высота карточки
 * считается по её тексту, а место подписи ребра подбирается перебором свободных
 * коридоров.
 *
 * Служебный слой — тот же, что в `docs/diagrams/dlp-guide/generate.mjs`: принятая
 * в репозитории форма схемы справки, набор читается одним файлом.
 *
 * Две страницы. Первая — путь одного действия: модель только просит, выполняет
 * панель, и меняющее действие ждёт клика человека. Вторая — чего агент не получает
 * никогда (ключи) и что панель после него оставляет на диске.
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
// ─── Страница 1: путь одного действия ──────────────────────────────────────

const p1 = newPage('Путь одного действия', 'p1');
heading(
  p1,
  60,
  30,
  'Путь одного действия агента панели',
  'Модель только просит. Выполняет панель — тем же маршрутом, что и кнопка, и только после клика человека, если действие что-то меняет.',
  1400,
);

const AX = 60;
const AW = 420;
const BX = 560;
const BW = 460;
const CX = 1100;
const CW = 420;

const typed = card(p1, 'a:typed', AX, 150, AW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Реплика в окне агента',
  lines: [
    'Окно открывается кнопкой «Агент панели» на любой странице. К реплике панель сама добавляет, какая страница открыта.',
  ],
});

const mask = card(p1, 'a:mask', AX, typed.y + typed.h + 55, AW, {
  pal: C.check,
  icon: 'shape=hexagon',
  iconText: 'маска',
  title: 'Маска данных до модели',
  lines: [
    'Правила раздела «Защита данных» плюс встроенные ключи и токены — всегда. Ключ из реплики уходит меткой вида [КЛЮЧ_1].',
    'Файл правил не читается — ход не запускается вовсе (data_mask_broken).',
  ],
});

card(p1, 'a:launch', AX, mask.y + mask.h + 55, AW, {
  pal: C.check,
  icon: 'shape=hexagon',
  iconText: 'запуск',
  title: 'Кого и куда запустить',
  lines: [
    'Активный CLI должен быть Claude Code. Маршрут — как у ассистента панели: облако вендора или контур через шлюз панели.',
    'Нет CLI, чужой CLI, свой эндпоинт, контур без шлюза или ключа — отказ с причиной, ход не начат.',
  ],
});

const cli = card(p1, 'a:cli', BX, 150, BW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Claude Code без своих рук',
  lines: [
    'Встроенных инструментов нет (ни чтения файлов, ни оболочки), из MCP — только переходник панели. Разговор в список чатов не пишется.',
  ],
});

const bridge = card(p1, 'a:bridge', BX, cli.y + cli.h + 55, BW, {
  pal: C.panel,
  icon: 'shape=process',
  iconText: 'MCP',
  title: 'Переходник tools/mcp/panel.mjs',
  lines: [
    'Отдаёт модели список действий панели и передаёт вызов в панель. Своих прав и секретов у него нет.',
  ],
});

const registry = card(p1, 'a:registry', BX, bridge.y + bridge.h + 55, BW, {
  pal: C.check,
  icon: 'shape=hexagon',
  iconText: 'реестр',
  title: 'Реестр действий: класс риска',
  lines: [
    'чтение — выполняется сразу, без вопроса.',
    'изменение и опасное — сначала предпросмотр: что будет записано и дифф файла.',
  ],
});

card(p1, 'a:card', BX, registry.y + registry.h + 55, BW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Карточка ждёт клика до 10 минут',
  lines: [
    'Изменение: фокус на «Выполнить». Опасное: фокус на «Отклонить», Enter по привычке ничего не удалит.',
    'Решение принимается только из окна панели — не от агента.',
  ],
});

const exec = card(p1, 'a:exec', CX, registry.y, CW, {
  pal: C.check,
  icon: 'shape=hexagon',
  iconText: 'панель',
  title: 'Сверка и выполнение',
  lines: [
    'Цель изменилась после показа карточки — не выполнено, ничего не записано («карточка устарела»).',
    'Иначе тот же маршрут API, что у кнопки в разделе, и страница с результатом открывается рядом с окном.',
  ],
});

card(p1, 'a:disk', CX, exec.y + exec.h + 55, CW, {
  pal: C.store,
  icon: 'shape=cylinder3',
  iconText: 'диск',
  title: 'Что остаётся на диске',
  lines: [
    'Сам изменённый файл (CLAUDE.md, .claude.json, state.json…) и копия до правки в backups.',
    'Строка следа в agent-actions.jsonl: что, с каким исходом, кто решил.',
  ],
});

card(p1, 'a:model', CX, 150, CW, {
  pal: C.group,
  icon: 'shape=cloud',
  iconText: 'модель',
  title: 'Модель',
  lines: [
    'Получает реплику уже с метками и список действий. Выбирает, какое действие попросить. Ключей не видит.',
  ],
});

link(p1, 'a:typed', 'a:mask', 'до отправки', {
  colour: FLOW.human,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p1, 'a:mask', 'a:launch', 'с метками', { colour: FLOW.fwd, exit: [0.5, 1], entry: [0.5, 0] });
link(p1, 'a:launch', 'a:cli', 'запуск хода', { colour: FLOW.fwd, exit: [1, 0.3], entry: [0, 0.5] });
link(p1, 'a:cli', 'a:model', 'запрос', { colour: FLOW.fwd, exit: [1, 0.4], entry: [0, 0.4] });
link(p1, 'a:model', 'a:cli', 'вызов действия', {
  colour: FLOW.back,
  exit: [0, 0.8],
  entry: [1, 0.8],
});
link(p1, 'a:cli', 'a:bridge', 'по MCP', { colour: FLOW.fwd, exit: [0.5, 1], entry: [0.5, 0] });
link(p1, 'a:bridge', 'a:registry', 'вызов', { colour: FLOW.fwd, exit: [0.5, 1], entry: [0.5, 0] });
link(p1, 'a:registry', 'a:card', 'меняет', { colour: FLOW.fwd, exit: [0.5, 1], entry: [0.5, 0] });
link(p1, 'a:card', 'a:exec', 'Выполнить', {
  colour: FLOW.human,
  exit: [1, 0.5],
  entry: [0, 0.8],
});
link(p1, 'a:registry', 'a:exec', 'чтение', { colour: FLOW.fwd, exit: [1, 0.3], entry: [0, 0.3] });
link(p1, 'a:exec', 'a:disk', 'запись', { colour: FLOW.data, exit: [0.5, 1], entry: [0.5, 0] });

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'человек и его решение', fill: C.human.tint, stroke: C.human.line },
  { caption: 'работа панели', fill: C.check.tint, stroke: C.check.line },
  { caption: 'переходник панели', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'модель', fill: C.group.tint, stroke: C.group.line },
  { caption: 'файл на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'порядок', edgeColour: FLOW.fwd },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'что возвращается', edgeColour: FLOW.back },
  { caption: 'запись на диск', edgeColour: FLOW.data },
]);

// ─── Страница 2: ключи и файлы ─────────────────────────────────────────────

const p2 = newPage('Ключи и файлы', 'p2');
heading(
  p2,
  60,
  30,
  'Что агенту недоступно и что панель пишет на диск',
  'Секрет вводит только человек, в поле самой панели. Агент узнаёт лишь, что ключ сохранён и принят ли он.',
  1400,
);

const k1 = card(p2, 'k:contour', AX, 150, AW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Ключ контура',
  lines: [
    'Агент сохраняет только черновик: адрес, тип шлюза, название. Поля ключа в действии нет.',
    'Ключа нет — исход «нужен ключ»: панель открывает на странице «Контур» своё поле ключа.',
  ],
});

const k2 = card(p2, 'k:mcp', AX, k1.y + k1.h + 55, AW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Секреты MCP-серверов',
  lines: [
    'При чтении значения секретов модели не показываются. От модели принимаются только пустое значение или ссылка ${VAR}.',
    'После записи панель открывает раздел «MCP-серверы» на этом сервере; значение вводите в правке сервера.',
  ],
});

const k3 = card(p2, 'k:chat', AX, k2.y + k2.h + 55, AW, {
  pal: C.warn,
  icon: 'shape=card',
  iconText: 'чат',
  title: 'Ключ, вставленный в реплику',
  lines: [
    'До модели доходит метка. В сохранённом разговоре — тоже метка: история хранит то, что ушло модели.',
  ],
});

card(p2, 'k:agent', BX, r10(k2.y + k2.h / 2 - 70), BW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'агент',
  title: 'Агент видит только состояние',
  lines: [
    'contour_status: ключ «нет / сохранён / принят / отклонён» — без значения и без маски.',
    'Процесс агента при работе через контур получает заглушку вместо ключа; настоящий подставляет шлюз панели.',
  ],
});

const f1 = card(p2, 'k:journal', CX, 150, CW, {
  pal: C.store,
  icon: 'shape=cylinder3',
  iconText: 'файл',
  title: '~/.claude/agentdeck/agent-actions.jsonl',
  lines: [
    'След действий: строка на действие — время, действие, класс риска, исход, кто решил, сводка. Вход целиком не пишется.',
  ],
});

const f2 = card(p2, 'k:conv', CX, f1.y + f1.h + 55, CW, {
  pal: C.store,
  icon: 'shape=cylinder3',
  iconText: 'файл',
  title: '~/.claude/agentdeck/panel-agent/{id}.json',
  lines: ['Разговор: файл на разговор, реплики после маски. Это вкладка «История» в окне.'],
});

card(p2, 'k:backups', CX, f2.y + f2.h + 55, CW, {
  pal: C.store,
  icon: 'shape=cylinder3',
  iconText: 'файл',
  title: '~/.claude/agentdeck/backups',
  lines: [
    'Копия файла до правки — как при правке руками. Вернуть прежнее — раздел «История изменений».',
  ],
});

card(p2, 'k:never', BX, k3.y + k3.h + 55, BW, {
  pal: C.warn,
  title: 'Чего нет на диске никогда',
  lines: [
    'Ключей и секретов в следе и разговорах. Транскрипта в ~/.claude/projects: ход запускается без сохранения сессии и в список чатов не попадает.',
  ],
});

link(p2, 'k:contour', 'k:agent', 'только состояние ключа', {
  colour: FLOW.data,
  dashed: true,
  exit: [1, 0.5],
  entry: [0, 0.15],
});
link(p2, 'k:mcp', 'k:agent', 'значения скрыты', {
  colour: FLOW.data,
  dashed: true,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p2, 'k:chat', 'k:agent', 'метка вместо ключа', {
  colour: FLOW.data,
  dashed: true,
  exit: [1, 0.5],
  entry: [0, 0.85],
});
link(p2, 'k:agent', 'k:journal', 'каждое действие', {
  colour: FLOW.fwd,
  exit: [1, 0.2],
  entry: [0, 0.4],
});
link(p2, 'k:agent', 'k:conv', 'каждая реплика', {
  colour: FLOW.fwd,
  exit: [1, 0.6],
  entry: [0, 0.4],
});

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'вводит только человек', fill: C.human.tint, stroke: C.human.line },
  { caption: 'агент', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'файл на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'граница', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'запись', edgeColour: FLOW.fwd },
  { caption: 'что доходит до агента', edgeColour: FLOW.data },
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
console.log(`записано ${OUT}: ${b1.w}×${b1.h} и ${b2.w}×${b2.h}`);
