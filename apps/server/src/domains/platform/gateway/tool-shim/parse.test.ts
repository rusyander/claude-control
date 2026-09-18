import { describe, expect, it } from 'vitest';
import { builtinPromptText } from '../../../prompts/catalog.ts';
import { protocolVersionOf, readTools, systemAddendum, TOOL_PROTOCOL_VERSION } from './protocol.ts';
import { repairJson, repaired } from './repair.ts';
import { parseToolCalls } from './stream.ts';

/**
 * Грамматика проверяется ТАБЛИЦЕЙ ФОРМ, а не набором удачных примеров.
 *
 * Прослойка — единственное место, где текст модели превращается в действие над
 * файлами человека. Ошибка здесь не падает: она либо молча не выполняет вызов
 * (агент «работает как чат»), либо выполняет догадку — вызов, собранный из
 * половины блока. Поэтому каждая форма, которую разборщик принимает, названа
 * строкой ниже, и каждая, которую он отвергает, названа тоже: молчаливого
 * третьего исхода у него нет.
 */

const ALLOWED = new Set(['Write', 'Read']);

/** Идентификаторы по счётчику: тест сравнивает вызовы целиком. */
function counter(): () => string {
  let index = 0;
  return () => `toolu_${(index += 1)}`;
}

function parse(text: string, allowed: ReadonlySet<string> = ALLOWED) {
  return parseToolCalls(text, { allowed, id: counter() });
}

/** Принимаемые формы: что написала модель → что из этого вышло. */
const ACCEPTED: {
  форма: string;
  текст: string;
  имя: string;
  аргументы: Record<string, unknown>;
}[] = [
  {
    форма: 'канонический тег, ровно как просит промпт',
    текст: '<tool_call>{"name": "Write", "arguments": {"file_path": "a.ts"}}</tool_call>',
    имя: 'Write',
    аргументы: { file_path: 'a.ts' },
  },
  {
    форма: 'переносы и отступы вокруг объекта',
    текст:
      '<tool_call>\n  {\n  "name": "Write",\n  "arguments": {"file_path": "a.ts"}\n  }\n</tool_call>',
    имя: 'Write',
    аргументы: { file_path: 'a.ts' },
  },
  {
    форма: 'аргументы под именем `input` — привычка диалекта Anthropic',
    текст: '<tool_call>{"name":"Read","input":{"file_path":"b.ts"}}</tool_call>',
    имя: 'Read',
    аргументы: { file_path: 'b.ts' },
  },
  {
    форма: 'аргументы под именем `parameters` — привычка функций OpenAI',
    текст: '<tool_call>{"name":"Read","parameters":{"file_path":"b.ts"}}</tool_call>',
    имя: 'Read',
    аргументы: { file_path: 'b.ts' },
  },
  {
    форма: 'аргументы строкой — так их шлёт сам OpenAI',
    текст: '<tool_call>{"name":"Read","arguments":"{\\"file_path\\":\\"b.ts\\"}"}</tool_call>',
    имя: 'Read',
    аргументы: { file_path: 'b.ts' },
  },
  {
    форма: 'забор markdown вместо тега',
    текст: '```tool_call\n{"name":"Write","arguments":{"file_path":"a.ts"}}\n```',
    имя: 'Write',
    аргументы: { file_path: 'a.ts' },
  },
  {
    форма: 'забор БЕЗ метки — так ответила живая qwen2.5-coder:14b',
    текст: '```\n{"name":"Write","arguments":{"file_path":"a.ts"}}\n```',
    имя: 'Write',
    аргументы: { file_path: 'a.ts' },
  },
  {
    форма: 'забор с меткой языка — привычка markdown',
    текст: '```json\n{"name":"Write","arguments":{"file_path":"a.ts"}}\n```',
    имя: 'Write',
    аргументы: { file_path: 'a.ts' },
  },
  {
    форма: 'забор ВНУТРИ тега — ремонт снимает обёртку',
    текст:
      '<tool_call>\n```json\n{"name":"Write","arguments":{"file_path":"a.ts"}}\n```\n</tool_call>',
    имя: 'Write',
    аргументы: { file_path: 'a.ts' },
  },
  {
    форма: 'пояснение перед объектом — ремонт берёт сам объект',
    текст: '<tool_call>Вот вызов: {"name":"Read","arguments":{"file_path":"b.ts"}}</tool_call>',
    имя: 'Read',
    аргументы: { file_path: 'b.ts' },
  },
  {
    форма: 'настоящий перенос строки внутри значения — ремонт экранирует его',
    текст: '<tool_call>{"name":"Write","arguments":{"content":"первая\nвторая"}}</tool_call>',
    имя: 'Write',
    аргументы: { content: 'первая\nвторая' },
  },
  {
    форма: 'запятая перед закрывающей скобкой',
    текст: '<tool_call>{"name":"Write","arguments":{"file_path":"a.ts",},}</tool_call>',
    имя: 'Write',
    аргументы: { file_path: 'a.ts' },
  },
  {
    форма: 'вызов без аргументов вовсе',
    текст: '<tool_call>{"name":"Read"}</tool_call>',
    имя: 'Read',
    аргументы: {},
  },
  {
    форма: 'имя с лишними пробелами',
    текст: '<tool_call>{"name":"  Write  ","arguments":{}}</tool_call>',
    имя: 'Write',
    аргументы: {},
  },
];

/** Отвергаемые формы: каждая названа причиной, и текст остаётся видимым. */
const REFUSED: { форма: string; текст: string; причина: string }[] = [
  {
    форма: 'несколько вызовов одним массивом (правило 1 промпта)',
    текст:
      '<tool_call>[{"name":"Write","arguments":{}},{"name":"Read","arguments":{}}]</tool_call>',
    причина: 'несколько вызовов в одном блоке',
  },
  {
    форма: 'инструмент, которого клиент не объявлял',
    текст: '<tool_call>{"name":"Bash","arguments":{"command":"rm -rf /"}}</tool_call>',
    причина: 'инструмент не объявлен клиентом',
  },
  {
    форма: 'блок без имени',
    текст: '<tool_call>{"arguments":{"file_path":"a.ts"}}</tool_call>',
    причина: 'в блоке нет имени инструмента',
  },
  {
    форма: 'внутри блока не JSON вовсе',
    текст: '<tool_call>сейчас запишу файл</tool_call>',
    причина: 'внутри блока нет объекта',
  },
  {
    форма: 'пустой блок',
    текст: '<tool_call>\n</tool_call>',
    причина: 'пустой блок вызова',
  },
  {
    форма: 'аргументы не объект и не строка',
    текст: '<tool_call>{"name":"Write","arguments":42}</tool_call>',
    причина: 'аргументы не разбираются как объект',
  },
];

describe('грамматика вызова: принимаемые формы', () => {
  it.each(ACCEPTED)('$форма', ({ текст, имя, аргументы }) => {
    const parsed = parse(текст);
    expect(parsed.flaws).toEqual([]);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]?.name).toBe(имя);
    expect(parsed.calls[0]?.arguments).toEqual(аргументы);
  });

  it('таблица форм не усохла до пары примеров', () => {
    // Строка, выпавшая из таблицы, — это форма, которую перестали проверять; без
    // этой границы она исчезает незаметно.
    expect(ACCEPTED.length).toBeGreaterThanOrEqual(14);
    expect(REFUSED.length).toBeGreaterThanOrEqual(6);
  });
});

/**
 * Забор без метки — форма, которой отвечает настоящая модель среднего класса
 * (замерено 12 сентября 2026 живым прогоном `qwen2.5-coder:14b`: имя, путь и
 * содержимое верные, обёртка markdown вместо тега).
 *
 * Терпимость здесь узкая и обязана такой остаться: обычный ответ агента полон
 * заборов с кодом, и принять их все за вызовы значило бы выполнять примеры.
 * Вызовом становится ТОЛЬКО блок, назвавший объявленный клиентом инструмент;
 * всё остальное проходит текстом байт в байт и изъяном не считается — иначе
 * человек читал бы «блок не стал вызовом» о каждом куске кода в ответе.
 */
describe('забор без метки: узкая терпимость', () => {
  it('обычный блок кода доезжает текстом и изъяном не считается', () => {
    const текст = '```python\nprint("hi")\n```';
    const parsed = parse(текст);
    expect(parsed.calls).toEqual([]);
    expect(parsed.flaws).toEqual([]);
    expect(parsed.text).toBe(текст);
  });

  it('JSON в заборе, не назвавший инструмент, остаётся примером', () => {
    const текст = '```json\n{"name":"my-package","version":"1.0.0"}\n```';
    const parsed = parse(текст);
    expect(parsed.calls).toEqual([]);
    expect(parsed.flaws).toEqual([]);
    expect(parsed.text).toBe(текст);
  });

  it('чужое имя инструмента в заборе вызовом не становится, но след оставляет', () => {
    // Объект и по имени, и по форме — вызов, просто инструмент клиентом не
    // объявлен. Промолчать тут значило бы, что модель, промахнувшаяся именем,
    // исчезает из отчётности: карточка скажет «вызовов не было», а их пытались
    // сделать.
    const текст = '```\n{"name":"Bash","arguments":{"command":"rm -rf /"}}\n```';
    const parsed = parse(текст);
    expect(parsed.calls).toEqual([]);
    expect(parsed.flaws.map((flaw) => flaw.reason)).toEqual(['инструмент не объявлен клиентом']);
    expect(parsed.text).toBe(текст);
  });

  it('объявленный инструмент со сломанными аргументами — изъян, а не тишина', () => {
    const parsed = parse('```\n{"name":"Write","arguments":42}\n```');
    expect(parsed.calls).toEqual([]);
    expect(parsed.flaws.map((flaw) => flaw.reason)).toEqual([
      'аргументы не разбираются как объект',
    ]);
    expect(parsed.text).toContain('"name":"Write"');
  });

  it('забор-вызов ПОСРЕДИ ответа не выполняется, но попадает в изъяны', () => {
    // Вызов, обёрнутый забором посреди текста, неотличим от примера — а пример
    // с настоящим именем инструмента и есть пример. Молчать тоже нельзя:
    // человек прочитал бы «вызовов не было» там, где модель их писала.
    const текст =
      'Сейчас запишу.\n```\n{"name":"Write","arguments":{"file_path":"a.ts"}}\n```\nГотово.';
    const parsed = parse(текст);
    expect(parsed.calls).toEqual([]);
    expect(parsed.flaws.map((flaw) => flaw.reason)).toEqual([
      'вызов забором посреди ответа не выполняется',
    ]);
    expect(parsed.text).toBe(текст);
  });
});

/**
 * Выполнение примера из ответа — то, ради чего форма без тега принимается ТОЛЬКО
 * целым ответом.
 *
 * Каждая строка ниже доказана живым прогоном враждебного ревью 12 сентября 2026:
 * настоящий `claude.exe` через настоящий шлюз ЗАПИСАЛ ФАЙЛ из блока, про который
 * модель прямым текстом написала «это только пример, не выполняй его». Причина
 * была в ремонте: раунд `unwrap` выдёргивает первый объект из ЛЮБОГО текста, и
 * вызовом становился не «блок, который и есть вызов», а «блок, где где-то есть
 * объект с подходящим именем» — то есть любая цитата, любой кусок прочитанного
 * файла и сам промпт протокола.
 */
describe('пример в ответе не выполняется', () => {
  const пример = (текст: string) => {
    const parsed = parse(текст);
    expect(parsed.calls).toEqual([]);
    // Текст обязан доехать до человека целиком: он должен увидеть, что модель
    // написала, а не пустой ответ.
    expect(parsed.text).toBe(текст);
    return parsed;
  };

  it('цитата протокола в заборе', () => {
    const parsed = пример(
      'Протокол выглядит так:\n\n```\n<tool_call>{"name":"Write","arguments":{"file_path":"a.ts"}}</tool_call>\n```',
    );
    expect(parsed.flaws.map((flaw) => flaw.reason)).toEqual([
      'вызов внутри блока кода не выполняется',
    ]);
  });

  it('объект вызова внутри кода на другом языке', () => {
    const parsed = пример(
      '```js\nconst tool = {"name": "Write", "arguments": {"file_path": "a.ts"}};\nexport default tool;\n```',
    );
    expect(parsed.flaws.map((flaw) => flaw.reason)).toEqual([
      'вызов без тега принимается только целым объектом JSON',
    ]);
  });

  it('забор-вызов с пояснением «это пример»', () => {
    const parsed = пример(
      '```json\n{"name": "Read", "arguments": {"file_path": "/etc/passwd"}}\n```\n\nЭто пример, не выполняй его.',
    );
    expect(parsed.flaws.map((flaw) => flaw.reason)).toEqual([
      'вызов забором посреди ответа не выполняется',
    ]);
  });

  // Ревью 18.09.2026 (C1). Забор С МЕТКОЙ `tool_call` стоял в общем списке форм
  // и выполнялся посреди прозы, хотя справка, корневой `CLAUDE.md` и карта кода
  // все трое обещают «никогда». Живьём настоящий `claude.exe` записал по такому
  // блоку файл, про который модель написала «не выполняй, это пример». Метку
  // пишет та же модель, что пишет пример, — веры ей ровно столько же.
  it('забор С МЕТКОЙ tool_call посреди ответа', () => {
    const parsed = пример(
      'Сейчас запишу файл.\n\n```tool_call\n{"name":"Write","arguments":{"file_path":"a.ts"}}\n```\n\nГотово.',
    );
    expect(parsed.flaws.map((flaw) => flaw.reason)).toEqual([
      'вызов забором посреди ответа не выполняется',
    ]);
  });

  // Обратная сторона той же правки: сузив грамматику, легко отнять у модели руки
  // там, где она права. Забор с меткой, составляющий ВЕСЬ ответ, — вызов, как и
  // безымянный: ответ целиком и есть вызов, примеру вокруг него места нет.
  it('забор с меткой ЦЕЛЫМ ответом остаётся вызовом', () => {
    const parsed = parse('```tool_call\n{"name":"Write","arguments":{"file_path":"a.ts"}}\n```');
    expect(parsed.flaws).toEqual([]);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]?.name).toBe('Write');
  });

  // И вторая: изъян о невыполненном заборе отменялся тем, что вызов в ходе УЖЕ
  // был, — ход «тегом плюс забором» доезжал с пустыми изъянами.
  it('забор посреди ответа назван даже когда вызов тегом уже прошёл', () => {
    const parsed = parse(
      '<tool_call>{"name":"Read","arguments":{"file_path":"b.ts"}}</tool_call>\n\n' +
        'А вот пример, не выполняй:\n\n```tool_call\n{"name":"Write","arguments":{"file_path":"a.ts"}}\n```',
    );
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]?.name).toBe('Read');
    expect(parsed.flaws.map((flaw) => flaw.reason)).toEqual([
      'вызов забором посреди ответа не выполняется',
    ]);
  });

  it('объект с подходящим именем в прочитанном файле', () => {
    // Ровно тот случай, который делает беду не «вольностью грамматики»: агент
    // показал человеку содержимое файла, а прослойка выполнила его.
    const parsed = пример(
      'Вот что в файле:\n\n```json\n{\n  "шаг": 1,\n  "вызов": {"name":"Write","arguments":{"file_path":"/etc/hosts","content":"x"}}\n}\n```',
    );
    expect(parsed.flaws).toEqual([]);
  });
});

describe('грамматика вызова: отвергаемые формы', () => {
  it.each(REFUSED)('$форма', ({ текст, причина }) => {
    const parsed = parse(текст);
    expect(parsed.calls).toEqual([]);
    expect(parsed.flaws.map((flaw) => flaw.reason)).toEqual([причина]);
    // Испорченный блок остаётся видимым: человек должен прочитать, что модель
    // пыталась сделать, а не получить пустой ответ.
    expect(parsed.text).toContain(текст.slice(0, 20));
  });

  it('имя чужого инструмента названо в изъяне', () => {
    const parsed = parse('<tool_call>{"name":"Bash","arguments":{}}</tool_call>');
    expect(parsed.flaws[0]?.name).toBe('Bash');
  });

  it('клиент не объявлял инструментов — вызовом не становится ничто', () => {
    const parsed = parse('<tool_call>{"name":"Write","arguments":{}}</tool_call>', new Set());
    expect(parsed.calls).toEqual([]);
    expect(parsed.flaws[0]?.reason).toBe('инструмент не объявлен клиентом');
  });
});

describe('порядок и соседство', () => {
  it('текст до, между и после вызовов сохраняется в порядке', () => {
    const parsed = parse(
      'Сначала прочту. <tool_call>{"name":"Read","arguments":{}}</tool_call> Потом запишу. <tool_call>{"name":"Write","arguments":{}}</tool_call> Готово.',
    );
    expect(parsed.calls.map((call) => call.name)).toEqual(['Read', 'Write']);
    expect(
      parsed.events.map((event) => (event.type === 'call' ? `[${event.call.name}]` : event.text)),
    ).toEqual(['Сначала прочту. ', '[Read]', ' Потом запишу. ', '[Write]', ' Готово.']);
  });

  it('два вызова подряд без текста между ними — два вызова', () => {
    const parsed = parse(
      '<tool_call>{"name":"Read","arguments":{}}</tool_call><tool_call>{"name":"Write","arguments":{}}</tool_call>',
    );
    expect(parsed.calls.map((call) => call.name)).toEqual(['Read', 'Write']);
  });

  it('блок без закрывающего тега не выполняется, а остаётся текстом', () => {
    const parsed = parse('<tool_call>{"name":"Write","arguments":{"file_path":"a.ts"}}');
    expect(parsed.calls).toEqual([]);
    expect(parsed.flaws.map((flaw) => flaw.reason)).toEqual(['блок без закрывающего тега']);
    expect(parsed.text).toContain('"file_path"');
  });

  it('ответ без вызовов вовсе доезжает текстом байт в байт', () => {
    const parsed = parse('Задача выполнена, вызовы больше не нужны.');
    expect(parsed.calls).toEqual([]);
    expect(parsed.flaws).toEqual([]);
    expect(parsed.text).toBe('Задача выполнена, вызовы больше не нужны.');
  });

  it('идентификатор у каждого вызова свой', () => {
    const parsed = parse(
      '<tool_call>{"name":"Read","arguments":{}}</tool_call><tool_call>{"name":"Read","arguments":{}}</tool_call>',
    );
    expect(parsed.calls[0]?.id).not.toBe(parsed.calls[1]?.id);
  });
});

describe('ремонт JSON: раунды названы', () => {
  it('разобралось как есть — раунда не было', () => {
    const result = repairJson('{"name":"Write"}');
    expect(repaired(result) && result.round).toBe('none');
  });

  it('обёртка снимается первым раундом', () => {
    const result = repairJson('```json\n{"name":"Write"}\n```');
    expect(repaired(result) && result.round).toBe('unwrap');
  });

  it('синтаксис чинится вторым раундом', () => {
    const result = repairJson('{"name":"Write","arguments":{"content":"а\nб"},}');
    expect(repaired(result) && result.round).toBe('syntax');
  });

  it('дальше двух раундов ремонт не идёт — блок объявляется испорченным', () => {
    const result = repairJson('{"name": "Write", "arguments": {');
    expect(repaired(result)).toBe(false);
  });

  it('фигурная скобка внутри значения не обрывает объект', () => {
    const result = repairJson(
      'пояснение {"name":"Write","arguments":{"content":"if (x) { y }"}} хвост',
    );
    expect(repaired(result) && result.value.arguments).toEqual({ content: 'if (x) { y }' });
  });
});

describe('список инструментов для модели', () => {
  it('читается и диалект Anthropic, и упаковка OpenAI', () => {
    const tools = readTools([
      { name: 'Write', description: 'пишет файл', input_schema: { type: 'object' } },
      {
        type: 'function',
        function: { name: 'Read', description: 'читает файл', parameters: { type: 'object' } },
      },
      { description: 'без имени' },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(['Write', 'Read']);
    expect(tools[1]?.schema).toEqual({ type: 'object' });
  });

  it('без инструментов добавки к системной строке нет вовсе', () => {
    // Протокол без списка — обещание рук, которых нет: прямая дорога к вызову
    // выдуманного инструмента.
    expect(systemAddendum('правила', [])).toBe('');
  });

  it('добавка несёт и правила, и схемы одной строкой', () => {
    const text = systemAddendum('правила', readTools([{ name: 'Write', input_schema: { a: 1 } }]));
    expect(text).toContain('правила');
    expect(text).toContain('### Write');
    expect(text).toContain('{"a":1}');
  });
});

describe('версия грамматики', () => {
  it('промпт каталога называет ту же версию, что разбирает код', () => {
    // Разошлись — значит человеку обещают один протокол, а разбирают другой, и
    // узнать об этом лучше здесь, чем по молча не сработавшему вызову.
    expect(protocolVersionOf(builtinPromptText('tool-protocol'))).toBe(TOOL_PROTOCOL_VERSION);
  });

  it('промпт каталога учит ровно тем тегам, которые ищет разборщик', () => {
    const text = builtinPromptText('tool-protocol');
    expect(text).toContain('<tool_call>');
    expect(text).toContain('</tool_call>');
    expect(text).toContain('</tool_result>');
  });
});
