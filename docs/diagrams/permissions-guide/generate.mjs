/**
 * Схемы путеводителя «Права доступа». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/permissions-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают — высота карточки
 * считается по её тексту, а место подписи ребра подбирается перебором свободных
 * коридоров. Ни то, ни другое в рукописном XML не держится.
 *
 * Служебный слой (палитра, карточка, легенда, раскладка рёбер) — тот же, что в
 * `docs/diagrams/rules-guide/generate.mjs`: он и есть принятая в этом репозитории
 * форма схемы справки. Общей библиотеки у наборов нет намеренно — набор целиком
 * читается одним файлом, и правка в одном разделе справки не двигает картинки в
 * другом.
 *
 * Две страницы, и только две: схема появляется там, где снимок бессилен.
 *
 * Страница 1 — порядок решения на один вызов инструмента. На экране видно
 *              плашки «Разрешено» и «Не действует», но не то, ПОЧЕМУ победило
 *              одно правило из четырёх и кто именно это решил.
 * Страница 2 — где физически лежит право и что с ним делают соседние кнопки.
 *              Тумблер и корзина стоят рядом и оба убирают строку из файла;
 *              разница — остаётся ли у панели отметка, чем вернуть.
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
// ─── Страница 1: кто решает, можно ли вызвать инструмент ───────────────────

const p1 = newPage('1. Порядок решения', 'p1');
heading(
  p1,
  60,
  30,
  'Кто решает, можно ли вызвать инструмент',
  'Решает Claude Code, а не панель. Панель пишет правила в его файлы и показывает, какое из них победит.',
  1100,
);

const AX = 60;
const AW = 380;
const BX = 540;
const BW = 400;
const CX = 1040;
const CW = 360;

const call = card(p1, 'p1:call', AX, 150, AW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Claude собирается вызвать инструмент',
  lines: [
    'Например Bash(git push origin main) или mcp__orders__refund_order.',
    'Это происходит внутри сессии Claude Code: панель в этот момент не участвует и ничего не может запретить.',
  ],
});

const rules = card(p1, 'p1:rules', AX, call.y + call.h + 70, AW, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'json',
  title: 'Правила, прочитанные при старте',
  lines: [
    'settings.json и settings.local.json личного каталога — оба наравне, плюс файлы проекта.',
    'Прочитаны ОДИН раз, при запуске сессии. Правило, добавленное сейчас, доедет до следующего запуска.',
  ],
});

card(p1, 'p1:none', AX, rules.y + rules.h + 70, AW, {
  pal: C.note,
  soft: true,
  title: 'Ни одно правило не подошло',
  lines: [
    'Инструмент, не указанный нигде, по умолчанию спрашивает подтверждения.',
    'Пустой раздел «Права» не значит «всё разрешено»: он значит «на каждый вызов будет вопрос».',
  ],
});

const match = card(p1, 'p1:match', BX, 150, BW, {
  pal: C.check,
  icon: 'shape=hexagon',
  iconText: 'отбор',
  title: 'Какие правила накрывают этот вызов',
  lines: [
    'Точное совпадение шаблона.',
    'Голое имя инструмента накрывает любое уточнение: Bash — это и Bash(git push:*), и Bash(rm:*).',
    'Имя сервера накрывает все его инструменты: mcp__orders — это и mcp__orders__refund_order.',
    'Пересечения масок ВНУТРИ скобок не разбираются: Bash(git:*) и Bash(git push:*) считаются разными.',
  ],
});

const rank = card(p1, 'p1:rank', BX, match.y + match.h + 70, BW, {
  pal: C.panel,
  icon: 'shape=hexagon',
  iconText: 'выбор',
  title: 'Побеждает сильнейшее решение',
  lines: [
    'deny сильнее ask, ask сильнее allow. Сильнее — значит побеждает независимо от того, в каком файле лежит и каким по счёту записано.',
    'При равной силе точное совпадение важнее широкого — его панель и предложит править.',
  ],
});

card(p1, 'p1:shows', BX, rank.y + rank.h + 70, BW, {
  pal: C.panel,
  soft: true,
  title: 'Тот же разбор панель делает у себя',
  lines: [
    'Ради двух надписей: плашки «Не действует: перекрыто «…»» в списке и предупреждения в форме, пока право ещё не сохранено.',
    'Это подсказка, а не решение. Панель не участвует в вызове и ничего не может ни разрешить, ни запретить.',
  ],
});

const deny = card(p1, 'p1:deny', CX, 150, CW, {
  pal: C.warn,
  weight: 3,
  title: 'Запрещено — вызова не будет',
  lines: [
    'Подтвердить нельзя: это не вопрос, а отказ.',
    'Отсюда и главный вопрос раздела: «я же разрешил, почему не работает». Значит, тот же вызов накрыт запретом.',
  ],
});

const ask = card(p1, 'p1:ask', CX, deny.y + deny.h + 60, CW, {
  pal: C.note,
  title: 'Спрашивать — придёт запрос',
  lines: [
    'Карточка подтверждения появляется и в терминале, и в чате панели.',
    'Это положение по умолчанию для всего, о чём вы не высказались.',
  ],
});

card(p1, 'p1:allow', CX, ask.y + ask.h + 60, CW, {
  pal: C.human,
  title: 'Разрешено — выполнится молча',
  lines: [
    'Ни вопроса, ни следа в переписке — только результат.',
    'Поэтому широкое allow (Bash целиком) снимает вопросы разом со всего, что под него попадает.',
  ],
});

link(p1, 'p1:call', 'p1:match', 'вызов', { colour: FLOW.fwd, exit: [1, 0.5], entry: [0, 0.3] });
link(p1, 'p1:rules', 'p1:match', 'все правила сессии', {
  colour: FLOW.data,
  exit: [1, 0.4],
  entry: [0, 0.8],
});
link(p1, 'p1:match', 'p1:rank', 'накрывающие', { colour: FLOW.fwd });
link(p1, 'p1:none', 'p1:ask', 'по умолчанию', {
  colour: FLOW.back,
  dashed: true,
  exit: [1, 0.5],
  entry: [0, 0.9],
});
link(p1, 'p1:rank', 'p1:deny', 'deny', { colour: FLOW.fwd, exit: [1, 0.2], entry: [0, 0.7] });
link(p1, 'p1:rank', 'p1:ask', 'ask', { colour: FLOW.fwd, exit: [1, 0.5], entry: [0, 0.3] });
link(p1, 'p1:rank', 'p1:allow', 'allow', { colour: FLOW.fwd, exit: [1, 0.8], entry: [0, 0.2] });

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'агентный CLI — он и решает', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'файлы на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'разбор шаблонов', fill: C.check.tint, stroke: C.check.line },
  { caption: 'панель', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'вызова не будет', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'будет вопрос', fill: C.note.tint, stroke: C.note.line },
  { caption: 'выполнится молча', fill: C.human.tint, stroke: C.human.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'дальше по пути', edgeColour: FLOW.fwd },
  { caption: 'что читается с диска', edgeColour: FLOW.data },
  { caption: 'положение по умолчанию', edgeColour: FLOW.back, dashed: true },
]);

// ─── Страница 2: где лежит право и что делают кнопки ───────────────────────

const p2 = newPage('2. Где лежит право', 'p2');
heading(
  p2,
  60,
  30,
  'Где лежит право и что с ним делают кнопки',
  'Своей базы у панели нет. Всё, кроме одной отметки, — строки в файлах самого Claude Code.',
  1100,
);

const form = card(p2, 'p2:form', 60, 150, 380, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Форма права',
  lines: [
    'Шаблон и решение — больше ничего. Заготовки и пакетный ввод только заполняют эти два поля.',
    'Новое право всегда уходит в общий settings.json; правимое остаётся в своём файле.',
  ],
});

const shared = card(p2, 'p2:shared', 540, 150, 400, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'json',
  title: '~/.claude/settings.json → permissions',
  lines: [
    'Три списка: allow, ask, deny. Одно право — одна строка ровно в одном из них.',
    'Файл общий: его кладут в репозиторий и делят с командой.',
  ],
});

const local = card(p2, 'p2:local', 540, shared.y + shared.h + 70, 400, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'local',
  title: 'settings.local.json → permissions',
  lines: [
    'Тот же формат, но файл личный и в репозиторий не уезжает.',
    'Claude Code применяет оба наравне: запрет отсюда гасит разрешение из общего файла.',
    'В списке такие права помечены «локальные» и тумблера не имеют — панель правит личный файл только по прямой просьбе.',
  ],
});

const mark = card(p2, 'p2:mark', 1040, 150, 380, {
  pal: C.panel,
  icon: 'shape=cylinder3;backgroundOutline=1;size=7',
  iconText: 'state',
  title: 'Выключено — это удаление плюс отметка',
  lines: [
    'Тумблер ФИЗИЧЕСКИ убирает строку из файла: оставленная там, она продолжала бы действовать.',
    'Чтобы право было чем вернуть, панель запоминает его у себя — agentdeck/state.json. В списке оно остаётся серым, с пометкой «Выключено».',
  ],
});

card(p2, 'p2:gone', 1040, mark.y + mark.h + 70, 380, {
  pal: C.warn,
  weight: 3,
  icon: 'shape=card',
  iconText: 'нет',
  title: 'Удалено',
  lines: [
    'Строка вырезана, отметки нет. Инструмент возвращается к поведению по умолчанию — подтверждение на каждый вызов.',
    'Вернуть можно только откатом резервной копии в «Настройках»: копия — это весь файл того момента.',
  ],
});

card(p2, 'p2:restart', 540, local.y + local.h + 70, 400, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Когда правка доедет до агента',
  lines: [
    'Оба файла читаются при старте сессии. Открытый разговор новых прав не увидит — ни в терминале, ни в чате панели.',
    'Это не сбой и не задержка записи: файл на диске уже другой.',
  ],
});

const group = card(p2, 'p2:group', 60, form.y + form.h + 70, 380, {
  pal: C.group,
  title: 'Группа гасит пачкой',
  lines: [
    'Тумблер группы снимает все её права разом — тем же способом, строка за строкой.',
    'Отметка группы отдельная от ручной: право, выключенное рукой, не оживёт при включении группы.',
  ],
});

card(p2, 'p2:move', 60, group.y + group.h + 70, 380, {
  pal: C.note,
  soft: true,
  title: 'Кнопка со стрелками — перенос',
  lines: [
    'Переносит право между общим и личным файлом. Шаблон и решение те же, меняется только файл.',
    'Секретов здесь нет: оба файла Claude Code читает одинаково. Личный — про «это моё, а не командное».',
  ],
});

link(p2, 'p2:form', 'p2:shared', 'сохранение', {
  colour: FLOW.human,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p2, 'p2:shared', 'p2:local', 'перенос стрелками', {
  colour: FLOW.human,
  exit: [0.2, 1],
  entry: [0.2, 0],
});
link(p2, 'p2:local', 'p2:shared', 'и обратно', {
  colour: FLOW.back,
  dashed: true,
  exit: [0.8, 0],
  entry: [0.8, 1],
});
link(p2, 'p2:shared', 'p2:mark', 'тумблер', {
  colour: FLOW.human,
  exit: [1, 0.35],
  entry: [0, 0.35],
});
link(p2, 'p2:mark', 'p2:shared', 'тумблер обратно — строка возвращается', {
  colour: FLOW.back,
  dashed: true,
  exit: [0, 0.75],
  entry: [1, 0.75],
});
link(p2, 'p2:mark', 'p2:gone', 'корзина', { colour: FLOW.human });
link(p2, 'p2:local', 'p2:restart', 'читается при старте', { colour: FLOW.fwd });
link(p2, 'p2:group', 'p2:shared', 'пачкой', {
  colour: FLOW.human,
  exit: [1, 0.5],
  entry: [0, 0.85],
});

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'человек и его решение', fill: C.human.tint, stroke: C.human.line },
  { caption: 'файл на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'память самой панели', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'группа', fill: C.group.tint, stroke: C.group.line },
  { caption: 'агентный CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'вернуть нечем', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'значок — чья это коробка', fill: '#FFFFFF', stroke: C.panel.line },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'возврат к прежнему', edgeColour: FLOW.back, dashed: true },
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
