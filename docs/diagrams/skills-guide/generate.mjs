/**
 * Схемы путеводителя «Скиллы». Источник — этот генератор, `.drawio` — его вывод:
 *
 *   node docs/diagrams/skills-guide/generate.mjs <абсолютный путь>.drawio
 *
 * Правку вносят СЮДА и перегенерируют; XML руками не трогают — высота карточки
 * считается по её тексту, а место подписи ребра подбирается перебором свободных
 * коридоров. Ни то, ни другое в рукописном XML не держится.
 *
 * Служебный слой — тот же, что в `docs/diagrams/rules-guide/generate.mjs`: это
 * принятая в репозитории форма схемы справки. Общей библиотеки у наборов нет
 * намеренно — набор читается одним файлом.
 *
 * Страниц две, и обе про то, чего не видно ни в одном состоянии экрана.
 * Первая — что именно Claude читает у скилла и КОГДА: на экране видно папку с
 * файлами, а в контекст при старте попадает только шапка, тело — после
 * совпадения, вложенные файлы — вообще никогда, если на них нет ссылки. Вторая —
 * что тумблер, переименование и удаление делают с папкой: включённость скилла
 * хранит не панель, а то, в какой из двух папок лежит каталог.
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

// ─── Страница 1: что Claude читает у скилла и когда ────────────────────────

const p1 = newPage('Что читается и когда', 'p1');
heading(
  p1,
  60,
  30,
  'Что Claude читает у скилла и когда',
  'На экране видно папку целиком. В контекст при старте попадает только шапка — и это вся разница между скиллом и правилом.',
  1200,
);

const AX = 60;
const AW = 400;
const BX = 560;
const BW = 420;
const CX = 1080;
const CW = 420;

const folder = card(p1, 's:folder', AX, 150, AW, {
  pal: C.store,
  icon: 'shape=folder',
  iconText: 'skills',
  title: '~/.claude/skills/<имя>/',
  lines: [
    'Папка со SKILL.md внутри — этого и только этого панель ищет на диске.',
    'Рядом могут лежать references/, config/, templates/ и что угодно ещё: для панели это дерево файлов скилла.',
  ],
});

const head = card(p1, 's:head', AX, folder.y + folder.h + 60, AW, {
  pal: C.panel,
  icon: 'shape=note;size=14',
  iconText: 'yaml',
  title: 'Шапка SKILL.md: name и description',
  lines: [
    'Два поля YAML в начале файла. Описание — единственное, по чему принимается решение о подключении.',
    'Тело файла на это решение не влияет никак: его ещё не читали.',
  ],
});

card(p1, 's:nested', AX, head.y + head.h + 60, AW, {
  pal: C.warn,
  title: 'Вложенные файлы',
  lines: [
    'Claude Code не обходит папку скилла сам. Файл, на который нет ссылки из SKILL.md, не прочитают никогда.',
    'Панель показывает такие файлы деревом и даёт их править — но подключить их может только ссылка в тексте.',
  ],
});

const start = card(p1, 's:start', BX, 150, BW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Старт сессии: обход каталога skills/',
  lines: [
    'Claude Code читает ТОЛЬКО skills/. Соседняя skills-disabled/ для него не существует.',
    'Из каждого SKILL.md берётся шапка — имя и описание. Тела скиллов в контекст на этом шаге не попадают.',
  ],
});

const match = card(p1, 's:match', BX, start.y + start.h + 60, BW, {
  pal: C.check,
  icon: 'shape=hexagon',
  iconText: '?',
  title: 'Задача совпала с описанием',
  lines: [
    'Решает модель, и заранее узнать ответ нельзя — проверяется только прогоном.',
    'Скилл не подключился при хорошей инструкции ⇒ переписывать нужно description, а не тело.',
  ],
});

card(p1, 's:cost', BX, match.y + match.h + 60, BW, {
  pal: C.note,
  title: 'Почему это не правило',
  lines: [
    'Правило из CLAUDE.md читается целиком в каждой сессии и занимает контекст всегда.',
    'Двадцать подробных скиллов не мешают друг другу: наружу торчат только описания, а тело подтягивается одно.',
  ],
});

const body = card(p1, 's:body', CX, 150, CW, {
  pal: C.group,
  icon: 'shape=card',
  iconText: 'md',
  title: 'Тело скилла в контексте',
  lines: [
    'Текст SKILL.md подтягивается целиком — вот здесь и работают длинные многошаговые инструкции.',
    'До этого момента модель знала о скилле только одну фразу описания.',
  ],
});

const refs = card(p1, 's:refs', CX, body.y + body.h + 60, CW, {
  pal: C.group,
  title: 'Файл по ссылке из SKILL.md',
  lines: [
    'references/rules.md читается, когда текст скилла на него сослался — и ровно поэтому крупные скиллы делают входом плюс модулями.',
    'Без ссылки файл остаётся мёртвым грузом на диске.',
  ],
});

card(p1, 's:palette', CX, refs.y + refs.h + 60, CW, {
  pal: C.panel,
  title: 'Тот же скилл в палитре «/»',
  lines: [
    'Имя папки становится командой /имя, и раздел «Команды» показывает её рядом со встроенными.',
    'Это второй вход в тот же скилл, а не отдельная сущность.',
  ],
});

link(p1, 's:folder', 's:head', 'панель пишет папку', {
  colour: FLOW.human,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p1, 's:head', 's:start', 'при старте сессии', {
  colour: FLOW.data,
  exit: [1, 0.3],
  entry: [0, 0.7],
});
link(p1, 's:start', 's:match', 'описания всех скиллов', {
  colour: FLOW.fwd,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
link(p1, 's:match', 's:body', 'совпало', { colour: FLOW.fwd, exit: [1, 0.3], entry: [0, 0.7] });
link(p1, 's:body', 's:refs', 'ссылка в тексте', {
  colour: FLOW.data,
  exit: [0.5, 1],
  entry: [0.5, 0],
});
// По коридору между вторым и третьим рядами: напрямую связь прошла бы по тексту
// карточки «Почему это не правило», а она объясняет совсем другое.
const corridorY = match.y + match.h + 30;
link(p1, 's:nested', 's:refs', 'только по ссылке', {
  colour: FLOW.back,
  dashed: true,
  exit: [0.3, 0],
  entry: [0.25, 1],
  points: [
    { x: AX + AW * 0.3, y: corridorY },
    { x: CX + CW * 0.25, y: corridorY },
  ],
});
link(p1, 's:start', 's:palette', 'имя папки = /команда', {
  colour: FLOW.back,
  dashed: true,
  exit: [1, 0.15],
  entry: [0, 0.15],
});

routeEdges(p1);
legend(p1, 60, bottomOf(p1) + 60, [
  { caption: 'файл на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'что видно на экране', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'агентный CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'решение модели', fill: C.check.tint, stroke: C.check.line },
  { caption: 'попало в контекст', fill: C.group.tint, stroke: C.group.line },
  { caption: 'не прочитается без ссылки', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'действие панели', edgeColour: FLOW.human },
  { caption: 'кто что читает', edgeColour: FLOW.data },
  { caption: 'происходит само', edgeColour: FLOW.fwd },
  { caption: 'связь на заметку', edgeColour: FLOW.back, dashed: true },
]);

// ─── Страница 2: две папки и одно состояние ────────────────────────────────

const p2 = newPage('Две папки и одно состояние', 'p2');
heading(
  p2,
  60,
  30,
  'Что тумблер, переименование и удаление делают с папкой',
  'Включённость скилла не хранится нигде отдельно: она и есть то, в какой из двух папок лежит каталог.',
  1200,
);

const toggle = card(p2, 'd:toggle', AX, 150, AW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'вы',
  title: 'Тумблер в карточке',
  lines: [
    'Переносит каталог целиком между skills/ и skills-disabled/. Ничего не удаляется и не копируется.',
    'Из палитры скилл пропадает сразу, из списка панели — нет: он остаётся с пометкой «Выключено» и в счётчике.',
  ],
});

const rename = card(p2, 'd:rename', AX, toggle.y + toggle.h + 55, AW, {
  pal: C.human,
  icon: 'shape=card',
  iconText: 'A→B',
  title: 'Кнопка «Переименовать»',
  lines: [
    'Имя скилла — это имя каталога и идентификатор разом, поэтому в форме оно заблокировано: правка там завела бы вторую папку.',
    'Кнопка двигает папку И переписывает ссылки на скилл в группах и отметках.',
  ],
});

card(p2, 'd:delete', AX, rename.y + rename.h + 55, AW, {
  pal: C.warn,
  icon: 'shape=card',
  iconText: 'del',
  title: 'Удаление',
  lines: [
    'Стирает папку со всем содержимым. Отдельной корзины у раздела нет.',
    'Перед этим панель кладёт копию папки в backups — пока в «Настройках» включена резервная копия перед записью.',
  ],
});

const on = card(p2, 'd:on', BX, 150, BW, {
  pal: C.store,
  icon: 'shape=folder',
  iconText: 'on',
  title: '~/.claude/skills/<имя>/',
  lines: [
    'Единственный каталог, который обходит Claude Code. Лежащее здесь — включено, и другого признака нет.',
    'Симлинк или junction на папку в другом месте панель читает как обычную папку.',
  ],
});

const off = card(p2, 'd:off', BX, on.y + on.h + 55, BW, {
  pal: C.store,
  icon: 'shape=folder',
  iconText: 'off',
  title: '~/.claude/skills-disabled/<имя>/',
  lines: [
    'Соседний каталог, которого CLI не видит. Файлы целы, правки уходят сюда же — второй, включённой копии не появляется.',
    'Панель читает оба каталога: иначе выключенный скилл выглядел бы пропавшим с диска.',
  ],
});

card(p2, 'd:backup', BX, off.y + off.h + 55, BW, {
  pal: C.store,
  icon: 'shape=note;size=14',
  iconText: 'bak',
  title: '~/.claude/agentdeck/backups/',
  lines: [
    'Копия папки перед удалением и перед перезаписью. Кнопка «Восстановить» в списке копий на странице настроек разворачивает её обратно в skills/.',
    'Отдельный файл внутри скилла так не вернуть: копируется папка целиком.',
  ],
});

const state = card(p2, 'd:state', CX, 150, CW, {
  pal: C.panel,
  icon: 'shape=note;size=14',
  iconText: 'json',
  title: 'state.json панели',
  lines: [
    'Здесь лежит только то, чего нет в файлах Claude Code: состав групп и отметки.',
    'Включённости скилла здесь НЕТ — её целиком определяет папка. Поэтому тумблер переживает и переустановку панели, и правку файлов руками.',
  ],
});

const cli = card(p2, 'd:cli', CX, state.y + state.h + 55, CW, {
  pal: C.cli,
  icon: 'shape=process',
  iconText: 'CLI',
  title: 'Claude Code при старте сессии',
  lines: [
    'Обходит skills/ и берёт шапки. Открытый разговор изменений не увидит: каталог он прочитал при старте.',
    'Выключенный скилл для него просто не существует — ошибки не будет.',
  ],
});

card(p2, 'd:links', CX, cli.y + cli.h + 55, CW, {
  pal: C.note,
  title: 'Ссылки вида /skills?id=<имя>',
  lines: [
    'Идентификатор скилла — его имя, поэтому переименование обрывает старые ссылки на него.',
    'Переименование обратно той же кнопкой оживляет их, а копия прежней папки остаётся в backups.',
  ],
});

link(p2, 'd:toggle', 'd:on', 'включить', { colour: FLOW.human, exit: [1, 0.3], entry: [0, 0.4] });
link(p2, 'd:toggle', 'd:off', 'выключить', { colour: FLOW.human, exit: [1, 0.7], entry: [0, 0.2] });
link(p2, 'd:rename', 'd:on', 'двигает папку', {
  colour: FLOW.human,
  exit: [1, 0.2],
  entry: [0, 0.8],
});
// Поверху, по коридору между рядами: прямая линия отсюда направо прошла бы по
// тексту карточки про skills-disabled/, а переименование как раз её и не
// касается — оно двигает папку и переписывает отметки.
const rowGapY =
  (Math.max(toggle.y + toggle.h, on.y + on.h, state.y + state.h) +
    Math.min(rename.y, off.y, cli.y)) /
  2;
link(p2, 'd:rename', 'd:state', 'переносит отметки', {
  colour: FLOW.human,
  exit: [0.9, 0],
  entry: [0.5, 1],
  points: [
    { x: AX + AW * 0.9, y: rowGapY },
    { x: CX + CW * 0.5, y: rowGapY },
  ],
});
link(p2, 'd:delete', 'd:backup', 'сначала копия', {
  colour: FLOW.human,
  exit: [1, 0.5],
  entry: [0, 0.5],
});
link(p2, 'd:on', 'd:cli', 'обходится при старте', {
  colour: FLOW.data,
  exit: [1, 0.3],
  entry: [0, 0.3],
});
link(p2, 'd:off', 'd:cli', 'не виден вовсе', {
  colour: FLOW.back,
  dashed: true,
  exit: [1, 0.8],
  entry: [0, 0.9],
});

routeEdges(p2);
legend(p2, 60, bottomOf(p2) + 60, [
  { caption: 'действие человека', fill: C.human.tint, stroke: C.human.line },
  { caption: 'папка на диске', fill: C.store.tint, stroke: C.store.line },
  { caption: 'память панели', fill: C.panel.tint, stroke: C.panel.line },
  { caption: 'агентный CLI', fill: C.cli.tint, stroke: C.cli.line },
  { caption: 'необратимо без копии', fill: C.warn.tint, stroke: C.warn.line },
  { caption: 'пояснение', fill: C.note.tint, stroke: C.note.line },
  { caption: 'действие человека', edgeColour: FLOW.human },
  { caption: 'кто что читает', edgeColour: FLOW.data },
  { caption: 'не читается', edgeColour: FLOW.back, dashed: true },
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
