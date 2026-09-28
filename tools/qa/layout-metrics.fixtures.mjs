/**
 * Самопроверка `audit-layout.mjs --selftest`: на каждую метрику — страница с
 * заведомым дефектом, которую метрика ОБЯЗАНА назвать, и одна чистая, на
 * которой не должна сработать ни одна. Проверка, которая не может покраснеть,
 * — украшение: если замер перестанет видеть свой дефект, прогон упадёт здесь.
 *
 * Каркас повторяет MainLayout: боковая колонка, `main` — единственная прокрутка
 * с отступом 32px, внутри обёртка страницы `[data-layout-page]`.
 */
const shell = (body, { pageStyle = '', extra = '', fill = false } = {}) => `<!doctype html>
<html><head><style>
  *{box-sizing:border-box}
  html,body{height:100%;margin:0;font:14px/1.5 sans-serif}
  .root{display:flex;height:100%;overflow:hidden}
  nav{width:260px;flex-shrink:0}
  main{flex:1;min-width:0;overflow-y:auto;padding:32px;display:flex;flex-direction:column}
  .page{display:flex;flex-direction:column;flex:1 0 auto;${pageStyle}}
  .pageroot{display:flex;flex-direction:column;gap:16px}
  .head{display:flex;justify-content:space-between;align-items:center}
  .card{border:1px solid #ccc;border-radius:8px;padding:16px}
  .row{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid #eee}
  .row .grow{flex:1}
  button{height:32px}
  .tall{height:36px}
  table{width:100%;border-collapse:collapse}
  td,th{padding:4px 8px;text-align:left}
  select:not([multiple]):not([size]){appearance:none;padding:4px 30px 4px 8px;background:#fff url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2710%27 height=%276%27%3E%3C/svg%3E") no-repeat right 10px center}
  ${extra}
</style></head><body><div class="root"><nav>nav</nav>
<main><div class="page" data-layout-page${fill ? ' data-page-fill' : ''}><div class="pageroot">${body}</div></div></main></div></body></html>`;

const header = '<div class="head"><h1>Раздел</h1><button>Добавить</button></div>';
const rows = (count, render) => Array.from({ length: count }, (_, i) => render(i)).join('');
const listRow = (i, withToggle) =>
  `<div class="row"><span class="grow">правило ${i}</span><button aria-label="Изменить: r${i}">✎</button>` +
  `<button aria-label="Удалить r${i}">🗑</button>${withToggle ? '<span role="switch" aria-checked="true" style="display:inline-block;width:36px;height:20px;background:#88f"></span>' : ''}</div>`;
const table = (cellStyle) =>
  // Последний заголовок — подпись только для скринридера (коробка 1px), как в
  // таблице кейсов: R не должен принимать её текст за содержимое ячейки.
  `<table><thead><tr><th>Статус</th><th>Зона</th><th><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">Действия</span></th></tr></thead><tbody>${rows(
    3,
    (i) =>
      `<tr><td style="${cellStyle}"><span style="display:inline-block;padding:4px 10px;border-radius:999px;background:#dfd">пройден</span></td>` +
      `<td style="${cellStyle}">zone ${i}</td><td style="${cellStyle}"><button class="tall" aria-label="Изменить">✎</button></td></tr>`,
  )}</tbody></table>`;

// Строки в слотах виртуального списка: высота слота `slot`, строка ~45px.
const slotted = (slot) =>
  `<div class="card" style="padding:0"><div style="position:relative;height:${slot * 4}px">${rows(
    4,
    (i) =>
      `<div class="vslot" style="position:absolute;left:0;width:100%;top:${i * slot}px;height:${slot}px">${listRow(i, true)}</div>`,
  )}</div></div>`;
// Страница со своими прокрутками (как библиотека тестов) в низком окне:
// шапка съела высоту, таблица стоит на своём полу или выше него.
const fillPage = (areaStyle) =>
  shell(
    `${header}<div style="flex:none;height:900px">пульт и фильтры</div><div style="${areaStyle};overflow:auto">${rows(60, (i) => listRow(i, true))}</div>`,
    { fill: true, pageStyle: 'flex:1 1 0;min-height:0', extra: '.pageroot{flex:1;min-height:0}' },
  );

export const FIXTURES = [
  {
    name: 'чистая страница',
    expect: [],
    html: shell(
      `${header}<div class="card">${rows(6, (i) => listRow(i, true))}</div>${slotted(50)}${table('')}<select><option>agentdeck</option></select>` +
        '<div data-empty-state style="display:flex;flex-direction:column;align-items:center"><div style="width:56px;height:56px"></div><b>Пусто</b></div>',
    ),
  },
  {
    name: 'W: рамка раздела ограничена 700px',
    expect: ['W'],
    html: shell(`${header}<div class="card">${rows(4, (i) => listRow(i, true))}</div>`, {
      extra: '.pageroot{max-width:700px}',
    }),
  },
  {
    name: 'WN: узкая форма одна в широкой карточке',
    expect: ['WN'],
    html: shell(
      `${header}<div class="card"><div style="width:480px;height:320px;display:flex;flex-direction:column;gap:8px"><label>Поле</label><input><label>Поле</label><input></div></div>`,
    ),
  },
  {
    name: 'WN не срабатывает: блок по центру ряда и карточка одна в ряду сетки',
    expect: [],
    html: shell(
      `${header}<div style="display:flex;flex-direction:column;align-items:center"><div style="width:420px;height:240px;display:flex;flex-direction:column;align-items:center;gap:8px"><b>Нет правил</b><p style="text-align:center">пояснение</p></div></div>` +
        `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px">${rows(4, (i) => `<article class="tile card" style="height:220px">группа ${i}</article>`)}</div>`,
    ),
  },
  {
    name: 'WE: пустое состояние прижато влево в карточке',
    expect: ['WE'],
    html: shell(
      `${header}<div class="card"><div data-empty-state style="display:flex;flex-direction:column;align-items:flex-start"><div style="width:56px;height:56px;background:#eee"></div><b>Пусто</b></div></div>`,
    ),
  },
  {
    name: 'H: список в коробке 240px с прокруткой, под ним пусто',
    expect: ['H'],
    html: shell(
      `${header}<div class="card" style="height:240px;overflow-y:auto;padding:0">${rows(40, (i) => listRow(i, true))}</div>`,
    ),
  },
  {
    name: 'H2: прокрутка страницы и вложенная прокрутка разом',
    expect: ['H2'],
    html: shell(
      `${header}<div style="height:1600px">длинное</div><div class="card" style="height:420px;overflow-y:auto;padding:0">${rows(60, (i) => listRow(i, true))}</div>`,
    ),
  },
  {
    name: 'H2 не срабатывает: своя прокрутка страницы сжата до своего min-height',
    expect: [],
    html: fillPage('flex:1;min-height:320px'),
  },
  {
    name: 'H2: своя прокрутка страницы выше своего пола, а страница всё равно едет',
    expect: ['H2'],
    html: fillPage('flex:none;height:420px'),
  },
  {
    name: 'V: слот виртуального списка ниже строки',
    expect: ['V'],
    html: shell(`${header}${slotted(30)}`),
  },
  {
    name: 'C не срабатывает: кнопка-пометка сразу за названием разной длины',
    expect: [],
    html: shell(
      `${header}<div class="card">${rows(
        4,
        (i) =>
          `<div class="row"><span>${'скилл-'.repeat(i + 1)}</span><button>4 файла</button><span class="grow"></span><button aria-label="Изменить: s${i}">✎</button></div>`,
      )}</div>` +
        // Поля формы одним классом строк: у одного рядом кнопка «+», и поле уже.
        `<div class="card">${rows(
          3,
          (i) =>
            `<div class="field" style="display:flex;gap:8px"><label style="width:200px">Поле ${i}</label><input type="text" style="flex:1">${i === 1 ? '<button aria-label="Добавить">+</button>' : ''}</div>`,
        )}</div>`,
    ),
  },
  {
    // Цели контура: чип «— имя» с пометкой компромисса у своего правого края.
    name: 'C не срабатывает: чипы разной ширины в строке с переносом, пометка у края каждого',
    expect: [],
    html: shell(
      `${header}<div style="display:flex;flex-wrap:wrap;gap:8px">${rows(
        6,
        (i) =>
          `<span class="chip" style="display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border:1px solid #ccc"><span>—</span><span>${'цель-'.repeat(i + 1)}</span><button aria-label="Подпись компромисса: ${i}">!</button></span>`,
      )}</div>`,
    ),
  },
  {
    name: 'C: строка без тумблера сдвигает кнопки',
    expect: ['C'],
    html: shell(`${header}<div class="card">${rows(5, (i) => listRow(i, i % 2 === 0))}</div>`),
  },
  {
    name: 'R: ячейки таблицы прижаты к верху',
    expect: ['R'],
    html: shell(`${header}${table('vertical-align:top')}`),
  },
  {
    name: 'B: последний элемент у самого низа окна (обёртка сжата до колонки)',
    expect: ['B'],
    html: shell(
      `${header}<div style="height:2400px">длинное</div><button>Сохранить правила</button>`,
      {
        pageStyle: 'flex:1;min-height:0',
      },
    ),
  },
  {
    name: 'B: тело окна-диалога без нижнего отступа',
    expect: ['B'],
    html: shell(
      `${header}<div role="dialog" aria-label="Окно" style="position:fixed;inset:100px;display:flex;flex-direction:column;background:#fff;border:1px solid"><div style="flex:1;min-height:0;overflow-y:auto;padding:24px 24px 0">${rows(40, (i) => `<p>строка ${i}</p>`)}<button>Последняя</button></div></div>`,
    ),
  },
  {
    name: 'B не срабатывает: показанная подсказка последней строки свисает к низу тела окна',
    expect: [],
    html: shell(
      `${header}<div role="dialog" aria-label="Окно" style="position:fixed;inset:100px;display:flex;flex-direction:column;background:#fff;border:1px solid"><div style="flex:1;min-height:0;overflow-y:auto;padding:24px">${rows(40, (i) => `<p>строка ${i}</p>`)}<span style="position:relative;display:block"><button>Последняя</button><span role="tooltip" style="position:absolute;top:calc(100% + 4px);left:0;padding:8px">описание шага в две строки, свисает ниже содержимого</span></span></div></div>`,
    ),
  },
  {
    name: 'B не срабатывает: список в рамке внутри окна, строки в 4px от рамки',
    expect: [],
    html: shell(
      `${header}<div role="dialog" aria-label="Окно" style="position:fixed;inset:100px;display:flex;flex-direction:column;background:#fff;border:1px solid"><div style="padding:24px"><div style="height:200px;overflow-y:auto;padding:4px;border:1px solid #ccc;border-radius:8px">${rows(40, (i) => `<label style="display:block">участник ${i}</label>`)}</div></div></div>`,
    ),
  },
  {
    name: 'S: системная стрелка списка вплотную к рамке',
    expect: ['S'],
    html: shell(`${header}<select><option>agentdeck</option></select>`, {
      extra: 'select:not([multiple]):not([size]){appearance:auto;padding:0 12px;background:none}',
    }),
  },
  {
    name: 'X: блок шире области контента',
    expect: ['X'],
    html: shell(`${header}<div style="width:4000px;height:40px">широкий</div>`),
  },
  {
    name: 'T: строка текста шире 900px',
    expect: ['T'],
    html: shell(`${header}<p>${'Очень длинный абзац без меры строки. '.repeat(12)}</p>`),
  },
  {
    name: 'B, T и WN не срабатывают: высокий блок, абзац и узкая форма в закрытом <details>',
    expect: [],
    html: shell(
      `${header}<div style="height:1400px">длинное</div><details><summary>Компромиссы</summary><div style="height:6000px"><div style="width:480px;height:320px;display:flex;flex-direction:column"><label>Поле</label><input></div><p>${'Очень длинный абзац без меры строки. '.repeat(12)}</p></div></details><button>Сохранить</button>`,
    ),
  },
  {
    name: 'T не срабатывает: длинный перечень без пробелов (данные, не проза)',
    expect: [],
    html: shell(
      `${header}<span style="display:block;overflow-wrap:anywhere">${'Bash|PowerShell|Write|Edit|NotebookEdit|Read|'.repeat(6)}</span>`,
    ),
  },
];
