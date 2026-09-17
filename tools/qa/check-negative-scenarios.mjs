/**
 * Негативные сценарии контура (§8 `TASKS-PLATFORM.md`) — каждый закрыт ИМЕНЕМ
 * проверки, а не обещанием в таблице.
 *
 * Зачем скрипт, если строки уже перечислены в задаче: список в markdown стареет
 * молча. Переименовали тест — строка §8 продолжает утверждать, что сценарий
 * закрыт, и узнаётся это ровно тогда, когда сценарий случается у человека.
 *
 * Три правила, без которых прогон был бы украшением:
 *
 * 1. Прогон ЧИТАЕТ САМУ ТАБЛИЦУ. Иначе устаревание просто переезжает на этаж
 *    выше: реестр остаётся зелёным, пока §8 дописывают, переписывают колонку
 *    «ожидаемое поведение» или удаляют целиком. Сверяются и набор номеров, и
 *    кусок обещания (`expects`) в каждой строке.
 * 2. Якорь ищется в КОДЕ, а не в комментариях. Комментарий переживает удаление
 *    того, что он объясняет, — и такой якорь доказывал бы только собственное
 *    существование.
 * 3. У каждой строки есть свой якорь в файле `*.test.ts` и хотя бы один якорь,
 *    которого нет у соседей. Иначе строка живёт чужими доказательствами: две
 *    строки с одинаковыми якорями — это одна проверка, посчитанная дважды.
 *
 * Проверка СТАТИЧЕСКАЯ: стенд не нужен, поэтому она годится и для CI.
 * Запуск: `node tools/qa/check-negative-scenarios.mjs` (`--selftest` — прогон
 * самого сторожа: он обязан уметь краснеть).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const SERVER = 'apps/server/src';
const WEB = 'apps/web/src';
const TABLE_FILE = 'TASKS-PLATFORM.md';

/** Короче — почти наверняка совпадёт со случайным местом («map(»). */
const MIN_ANCHOR = 12;

/**
 * Строки §8. `closedBy` — файл и кусок текста, который обязан в нём быть:
 * название теста, инвариант или строка интерфейса, которую читает человек.
 * `expects` — кусок колонки «ожидаемое поведение» той же строки таблицы: по
 * нему видно, что закрывали ИМЕННО ТО, что обещано.
 *
 * `note` стоит там, где ДЕЙСТВИТЕЛЬНОСТЬ РАЗОШЛАСЬ С ТАБЛИЦЕЙ. Молча
 * подгонять поведение под текст задачи нельзя: спецификация писалась до чтения
 * исходников платформы компании, и там, где она ошибается, побеждает контур.
 */
const SCENARIOS = [
  {
    id: '1',
    title: 'Адрес админки вместо api.',
    expects: 'называет ошибку адреса',
    closedBy: [
      [`${SERVER}/domains/platform/probe.test.ts`, 'адрес админки назван отдельным сообщением'],
      [`${SERVER}/domains/platform/probe.test.ts`, 'но про админку не выдумываем'],
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        '404 на чате называет ОБА чтения',
      ],
    ],
  },
  {
    id: '2',
    title: 'Опечатка в адресе, DNS не резолвится',
    expects: 'адрес не отвечает',
    closedBy: [
      [`${SERVER}/domains/platform/probe.test.ts`, 'вышло время — «не ответил за 15 с»'],
      [`${SERVER}/domains/platform/ca-fetch.test.ts`, 'мёртвый адрес — отказ обещания'],
      [`${SERVER}/domains/platform/store.test.ts`, 'неудачная проба НЕ стирает подтверждённое'],
    ],
  },
  {
    id: '3',
    title: 'Корпоративный или самоподписанный сертификат',
    expects: 'свой корневой сертификат',
    closedBy: [
      [`${SERVER}/domains/platform/probe.test.ts`, 'подсказка про корневой сертификат компании'],
      [`${SERVER}/domains/platform/ca-fetch.test.ts`, 'нет присваивания rejectUnauthorized'],
    ],
  },
  {
    id: '4',
    title: 'Нет VPN',
    expects: 'русской причиной',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        'контур не отвечает ⇒ 502 с русской причиной',
      ],
    ],
  },
  {
    id: '5',
    title: 'Ключ неверный или отозван',
    expects: 'подсказка про кэш',
    closedBy: [
      [`${SERVER}/domains/platform/probe.test.ts`, '401 — ключ отклонён, и это сказано словами'],
      [`${SERVER}/domains/platform/probe.test.ts`, 'подпись про кэш ключа'],
    ],
  },
  {
    id: '6',
    title: 'Ключ истёк по сроку',
    expects: 'расхождение №1',
    note:
      'ТАБЛИЦА ОШИБАЛАСЬ: «отдельным текстом» невозможно, и причин ПЯТЬ. keys.go отвечает «key ' +
      'expired» и «budget exceeded», key_service.go добавляет «invalid API key», «key owner is ' +
      'deleted» и «key owner check failed»; inst-api/internal/auth/apikey.go на 401 от админки ' +
      'отдаёт nil,nil и пишет клиенту плоское «invalid API key». Панель называет все пять.',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        '401 называет ВСЕ ПЯТЬ причин',
      ],
      // Текст отказа переехал в драйвер (Т1): пять причин — знание о ПЛАТФОРМЕ КОМПАНИИ, и
      // у произвольного совместимого шлюза их нет. Якорь идёт за текстом, а не
      // за файлом: он стережёт формулировку, а не её адрес.
      [`${SERVER}/domains/platform/drivers/enterprise-platform.ts`, 'истёк по сроку'],
    ],
  },
  {
    id: '7',
    title: 'Бюджет КЛЮЧА исчерпан — тот же 401',
    expects: 'все ПЯТЬ причин',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        '401 называет ВСЕ ПЯТЬ причин',
      ],
      // Якорь в САМОМ ТЕКСТЕ отказа, а не в комментарии рядом с ним: комментарий
      // про причины переживёт замену сообщения на плоское «ключ не принят».
      [`${SERVER}/domains/platform/drivers/enterprise-platform.ts`, 'исчерпал свой бюджет'],
    ],
  },
  {
    id: '7б',
    title: 'Исчерпан лимит пользователя, команды или инстанса — 402 с уровнем',
    expects: 'с названием уровня',
    note:
      'ТАБЛИЦА ОШИБАЛАСЬ: на /v1 402 — только бюджет КЛЮЧА (handler_public_api.go:338-341, ' +
      'handler_agent_api.go:447), трёхуровневый бюджет budget.go проверяется лишь на JWT-маршрутах, ' +
      'куда панель не ходит. Уровня в теле нет; что кончилось, называет манифест драйвера ' +
      '(budgetRefusals), а молчащий контур оставляет поля пустыми.',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        '402 платформы компании назван бюджетом КЛЮЧА',
      ],
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        'новый отказ заменяет прежний целиком',
      ],
      [`${SERVER}/domains/platform/spend.test.ts`, 'чей это лимит доезжает до экрана'],
    ],
  },
  {
    id: '8',
    title: '403: модель не разрешена ключу',
    expects: '403 с именем модели',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        '403 называет МОДЕЛЬ и место',
      ],
      [`${SERVER}/domains/platform/probe.test.ts`, '403 — ключу не разрешено'],
    ],
  },
  {
    id: '9',
    title: 'RPM/TPM превышены — 429, «когда повторить» и ровно один повтор',
    expects: 'когда повторить',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/upstream.test.ts`,
        'повторяем только временное и только на стороне контура',
      ],
      [`${SERVER}/domains/platform/gateway/upstream.test.ts`, 'третьей попытки нет'],
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        '429 говорит, ЧЕРЕЗ СКОЛЬКО повторить',
      ],
    ],
  },
  {
    id: '10',
    title: 'Гардрейл на входе — 451 с перечнем без текста',
    expects: 'перечень нарушений без текста',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        '451 в потоке приходит клиенту терминальной ошибкой',
      ],
      [`${SERVER}/domains/platform/gateway/status.test.ts`, 'похожая на секрет'],
    ],
  },
  {
    id: '11',
    title: 'Гардрейл оборвал поток на середине',
    expects: 'stream_interrupted',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/frames.test.ts`,
        'после обрыва в поток клиента больше ничего не пишется',
      ],
      // Вторая половина обещания: клиенту уходит ТЕРМИНАЛЬНАЯ ошибка, а не тишина.
      [
        `${SERVER}/domains/platform/gateway/frames.test.ts`,
        'openai получает терминальную ошибку и [DONE]',
      ],
      [`${SERVER}/domains/platform/violations.test.ts`, 'обрыв в потоке — не «не приняли»'],
    ],
  },
  {
    id: '12',
    title: 'Реестр моделей не готов — 503',
    expects: 'контур ещё поднимается',
    closedBy: [
      [`${SERVER}/domains/platform/probe.test.ts`, '503 — контур ещё поднимается'],
      [
        `${SERVER}/domains/platform/gateway/upstream.test.ts`,
        '503 переживается одной повторной попыткой',
      ],
    ],
  },
  {
    id: '13',
    title: 'Модель исчезла из контура между прогонами',
    expects: 'пометка в списке',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        '404 на чате называет ОБА чтения',
      ],
      [
        `${SERVER}/lib/app-store/platform-health.test.ts`,
        'исчезнувшая из ответа модель помечается и помнит',
      ],
      [
        `${SERVER}/domains/models/platform-source.test.ts`,
        'пропавшие показываются, но в конце списка',
      ],
    ],
  },
  {
    id: '14',
    title: 'Контур ответил не-JSON: HTML прокси или страница входа',
    expects: 'тело не показывается сырым',
    closedBy: [
      [`${SERVER}/domains/platform/probe.test.ts`, 'не JSON при 200'],
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        'и не поток, и не ответ модели',
      ],
    ],
  },
  {
    id: '15',
    title: 'Не-потоковый запрос дольше 120 с',
    expects: 'шлюз ходит потоком',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        'наверх всё равно уходит поток',
      ],
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        'anthropic без потока получает цельное сообщение',
      ],
    ],
  },
  {
    id: '16',
    title: 'Поток оборвался на середине сети — учёт не удваивается',
    expects: 'учёт не удваивается',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        'обрыв не удваивает учёт',
      ],
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        'клиент видит ошибку, панель — событие и расход',
      ],
    ],
  },
  {
    id: '17',
    title: 'Дев-сервер перезапустился в момент запроса',
    expects: 'расхождение №2',
    note:
      'Повтор — ТОЛЬКО по коду ответа (429 и 5xx). Оборванная связь не повторяется намеренно: ' +
      'запрос мог дойти и исполниться, и второй такой же — второй списанный расход у контура.',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/upstream.test.ts`,
        '503 переживается одной повторной попыткой',
      ],
      [
        `${SERVER}/domains/platform/gateway/upstream.test.ts`,
        'обрыв связи не повторяется: запрос мог дойти',
      ],
    ],
  },
  {
    id: '18',
    title: 'Панель выключена, CLI направлен на шлюз',
    expects: 'отказ соединения',
    closedBy: [
      [`${WEB}/shared/config/i18n/ru.ts`, 'он получит отказ соединения, а не тихо уйдёт в облако'],
      // Поведение, а не подпись: остановленный шлюз ОТПУСКАЕТ порт, и именно
      // поэтому направленный на него CLI получает отказ соединения.
      [`${SERVER}/domains/platform/gateway/listener.test.ts`, 'остановленный шлюз не держит порт'],
    ],
  },
  {
    id: '19',
    title: 'Порт шлюза занят другим процессом',
    expects: 'соседний порт',
    closedBy: [
      [`${SERVER}/domains/platform/gateway/listener.test.ts`, 'занятый порт уступается соседнему'],
      [`${SERVER}/domains/platform/gateway/listener.test.ts`, 'доставшийся порт публикуется'],
    ],
  },
  {
    id: '20',
    title: 'Человек правил конфиг CLI руками после применения',
    expects: 'откат не затирает',
    closedBy: [
      [
        `${SERVER}/domains/platform/apply/rollback.test.ts`,
        'изменённый человеком после применения, не затирается',
      ],
      [`${SERVER}/domains/platform/apply/plan.test.ts`, 'файл правили после нас'],
    ],
  },
  {
    id: '21',
    title: 'Два контура настроены одновременно',
    expects: 'расхождение №3',
    note:
      'Сильнее таблицы: раздел показывает СПИСОК контуров, а не один с оговоркой. ' +
      'Строка §8 писалась, когда страницы ещё не было.',
    closedBy: [
      [`${SERVER}/domains/platform/store.test.ts`, 'два контура живут рядом'],
      // Именно перебор списка контуров: короткий «map(» совпал бы с любым
      // другим перебором на странице и пережил бы возврат к одному контуру.
      // После вкладок список идёт из `platforms` и рисует КАРТОЧКУ на каждый
      // контур; перебор того же массива в выборе контура карточек не рисует.
      [
        `${WEB}/pages/Platform/PlatformPage.tsx`,
        '<PlatformCard\n                    key={status.platform.id}',
      ],
    ],
  },
  {
    id: '22',
    title: 'Ключ поменяли в админке — старый работает до истечения кэша',
    expects: 'до истечения кэша',
    closedBy: [
      [`${SERVER}/domains/platform/probe.test.ts`, 'подпись про кэш ключа'],
      [`${SERVER}/domains/platform/probe.test.ts`, 'кэшировать нечего'],
    ],
  },
  {
    id: '23',
    title: 'Вендорный кадр, которого мы не знаем',
    expects: 'журнал диагностики',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/frames.test.ts`,
        'незнакомый кадр попадает в след ИМЕНАМИ ПОЛЕЙ',
      ],
      [`${SERVER}/domains/platform/gateway/frames.test.ts`, 'нечитаемый кадр наружу не идёт'],
    ],
  },
  {
    id: '24',
    title: 'Тело запроса и собранного ответа больше лимита',
    expects: 'поток без потолка',
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        'тело больше 32 МБ отклоняется, не читаясь',
      ],
      // Вторая половина строки, и до ревью Т10 её не было вовсе: потолок
      // ЗАПРОСА закрывал строку про ответ.
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        'собранный ответ больше потолка',
      ],
    ],
  },
  {
    id: '25',
    title: 'Часы машины ушли',
    expects: 'JWT не используется',
    closedBy: [
      [`${SERVER}/domains/platform/ca-fetch.test.ts`, 'ключ контура не подписывается временем'],
      [`${SERVER}/domains/platform/spend.test.ts`, 'день местный, а не UTC'],
    ],
  },
  {
    id: '26',
    title: 'Отказ панели по содержимому',
    expects: '400 `invalid_request_error` с причиной, не 403',
    // Решение по контуру №1: 403 Claude Code читает как ошибку входа и дописывает
    // «Failed to authenticate.». Все три места отказа — мост, родная ручка, прокси.
    closedBy: [
      [
        `${SERVER}/domains/platform/gateway/pipeline.integration.test.ts`,
        'правило «отклонить» останавливает запрос, и наружу он не уходит',
      ],
      [
        `${SERVER}/domains/platform/gateway/pipeline.native.integration.test.ts`,
        'правило «отклонить» на родной ручке — 400 invalid_request_error',
      ],
      [`${SERVER}/domains/dlp/DlpProxy.test.ts`, 'отклоняет запрос правилом block'],
    ],
  },
];

const cache = new Map();

/**
 * Файл БЕЗ комментариев: якорь обязан лежать в коде или в тексте, который
 * читает человек. Комментарий переживает удаление того, что объясняет.
 */
function readCode(file) {
  if (!cache.has(file)) {
    try {
      const raw = readFileSync(resolve(ROOT, file), 'utf8');
      // Отбрасываются СТРОКИ, которые целиком комментарий, а не куски по
      // `/* … */`: в словаре интерфейса вполне живут строки с «**/*.ts», и
      // жадная вырезка блока съела бы половину файла между двумя такими.
      const stripped = raw
        .split(/\r?\n/)
        .filter((line) => {
          const head = line.trimStart();
          return !head.startsWith('//') && !head.startsWith('*') && !head.startsWith('/*');
        })
        .join('\n');
      cache.set(file, stripped);
    } catch {
      cache.set(file, null);
    }
  }
  return cache.get(file);
}

/** Строки таблицы §8 из самой задачи: номер → обещание. */
export function readTable(markdown) {
  const section = markdown.split('## 8. Негативные сценарии')[1] ?? '';
  const table = section.split('\n---')[0] ?? '';
  const rows = new Map();
  for (const line of table.split('\n')) {
    if (!/^\|\s*(\d|№)/.test(line)) continue;
    const cells = line
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length < 3 || cells[0] === '#') continue;
    rows.set(cells[0], { scenario: cells[1], expected: cells[2] });
  }
  return rows;
}

/**
 * Сверка реестра с таблицей и с исходниками. Возвращает список бед — так её
 * можно позвать с испорченными данными и убедиться, что сторож краснеет.
 */
export function verify(scenarios, table, read = readCode) {
  const problems = [];
  const ok = [];

  const registryIds = new Set(scenarios.map((scenario) => scenario.id));
  for (const id of table.keys()) {
    if (!registryIds.has(id)) problems.push(`§8 №${id} есть в таблице, но не заведён в реестре`);
  }

  // Якорь, встречающийся у двух строк, — это одно доказательство, посчитанное
  // дважды. У каждой строки обязан быть хотя бы один свой.
  const anchorUsers = new Map();
  for (const scenario of scenarios) {
    for (const [file, anchor] of scenario.closedBy) {
      const key = `${file}::${anchor}`;
      anchorUsers.set(key, (anchorUsers.get(key) ?? 0) + 1);
    }
  }

  for (const scenario of scenarios) {
    const missing = [];

    const row = table.get(scenario.id);
    if (!row) missing.push(`строки №${scenario.id} нет в таблице §8 — реестр её выдумал`);
    else if (!row.expected.includes(scenario.expects)) {
      missing.push(`колонка «ожидаемое поведение» разошлась: в таблице нет «${scenario.expects}»`);
    }

    let hasTest = false;
    let hasOwn = false;
    for (const [file, anchor] of scenario.closedBy) {
      if (anchor.length < MIN_ANCHOR) missing.push(`якорь «${anchor}» короче ${MIN_ANCHOR} знаков`);
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) hasTest = true;
      if (anchorUsers.get(`${file}::${anchor}`) === 1) hasOwn = true;

      const text = read(file);
      if (text === null) missing.push(`${file} — файла нет`);
      else if (!text.includes(anchor)) missing.push(`${file} — нет «${anchor}» (вне комментариев)`);
    }
    if (!hasTest) missing.push('нет ни одного якоря в тесте — строку закрывают только исходники');
    if (!hasOwn) missing.push('все якоря общие с соседями — своего доказательства у строки нет');

    if (missing.length === 0) ok.push(scenario);
    else problems.push({ scenario, missing });
  }

  return { problems, ok };
}

/** Сторож обязан уметь краснеть — иначе зелёный прогон ничего не значит. */
function selftest() {
  const table = readTable(readFileSync(resolve(ROOT, TABLE_FILE), 'utf8'));
  const cases = [
    [
      'пропавший якорь',
      () => {
        const broken = structuredClone(SCENARIOS);
        broken[0].closedBy[0][1] = 'такого текста в файле нет никогда';
        return verify(broken, table);
      },
    ],
    [
      'строка выпала из реестра',
      () =>
        verify(
          SCENARIOS.filter((scenario) => scenario.id !== '9'),
          table,
        ),
    ],
    [
      'колонку поведения переписали',
      () => {
        const drifted = new Map(table);
        drifted.set('16', { scenario: 'что угодно', expected: 'учёт теперь удваивается' });
        return verify(SCENARIOS, drifted);
      },
    ],
    [
      'якорь слишком короткий',
      () => {
        const broken = structuredClone(SCENARIOS);
        broken[0].closedBy[0][1] = 'map(';
        return verify(broken, table);
      },
    ],
    [
      'якорь только в комментарии',
      () =>
        verify(
          [
            {
              id: '25',
              title: 'проверка сторожа',
              expects: 'JWT не используется',
              closedBy: [[`${SERVER}/x.test.ts`, 'этот текст только в комментарии']],
            },
          ],
          table,
          () => '// этот текст только в комментарии\nconst a = 1;',
        ),
    ],
  ];

  let failed = 0;
  for (const [name, run] of cases) {
    const { problems } = run();
    const red = problems.length > 0;
    console.log(`${red ? 'ок  ' : 'ПЛОХО'} сторож краснеет: ${name}`);
    if (!red) failed += 1;
  }
  console.log(
    failed === 0
      ? '\nСамопроверка пройдена: сторож умеет краснеть на всех пяти поломках.'
      : `\nСамопроверка провалена: молча проходит поломок — ${failed}`,
  );
  return failed === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();

  const table = readTable(readFileSync(resolve(ROOT, TABLE_FILE), 'utf8'));
  const { problems, ok } = verify(SCENARIOS, table);

  for (const scenario of ok) console.log(`ок   §8 №${scenario.id}: ${scenario.title}`);
  for (const problem of problems) {
    if (typeof problem === 'string') {
      console.log(`ПЛОХО ${problem}`);
      continue;
    }
    console.log(`ПЛОХО §8 №${problem.scenario.id}: ${problem.scenario.title}`);
    for (const line of problem.missing) console.log(`        ${line}`);
  }

  const notes = SCENARIOS.filter((scenario) => scenario.note);
  if (notes.length > 0) {
    console.log('\nГде действительность расходится с таблицей §8:');
    for (const scenario of notes) console.log(`  • §8 №${scenario.id}: ${scenario.note}`);
  }

  console.log(
    problems.length === 0
      ? `\nВсе ${SCENARIOS.length} строк §8 сверены с таблицей и закрыты названными проверками.`
      : `\nБед: ${problems.length}`,
  );
  return problems.length === 0 ? 0 : 1;
}

process.exit(main());
