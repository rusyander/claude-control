import { describe, expect, it } from 'vitest';
import { ToolStreamParser, type ShimEvent } from './stream.ts';

/**
 * Граница чанка — место, где ломаются все потоковые разборщики.
 *
 * Контур режет ответ где придётся: `<tool_` приезжает в одном куске, `call>` в
 * следующем. Разборщик, который смотрит только на свой кусок, отдаёт клиенту
 * половину тега, и вызов исчезает — агент показывает человеку `<tool_call>{…`
 * как ответ и ничего не делает.
 *
 * Поэтому главная проверка здесь не пример, а СВОЙСТВО: ответ, разрезанный в
 * любом месте, разбирается одинаково. Она обходит все точки разреза разом, и
 * забытый случай спрятаться в ней не может.
 */

const ALLOWED = new Set(['Write', 'Read']);

function run(chunks: readonly string[]): { events: ShimEvent[]; flaws: string[] } {
  let index = 0;
  const parser = new ToolStreamParser({ allowed: ALLOWED, id: () => `toolu_${(index += 1)}` });
  const events: ShimEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.end());
  return { events, flaws: parser.flaws.map((flaw) => flaw.reason) };
}

/** Текст и вызовы в одну строку — по ней и сравниваются разрезы. */
function shape(events: readonly ShimEvent[]): string {
  return events
    .map((event) =>
      event.type === 'call'
        ? `«${event.call.name}:${JSON.stringify(event.call.arguments)}»`
        : event.text,
    )
    .join('');
}

const ANSWER =
  'Сейчас запишу файл. <tool_call>{"name": "Write", "arguments": {"file_path": "a.ts", "content": "export const a = 1;"}}</tool_call> Готово, проверь.';

describe('разбор на границе чанка', () => {
  it('ответ, разрезанный в ЛЮБОМ месте, разбирается одинаково', () => {
    const whole = run([ANSWER]);
    expect(whole.events.filter((event) => event.type === 'call')).toHaveLength(1);

    for (let cut = 1; cut < ANSWER.length; cut += 1) {
      const split = run([ANSWER.slice(0, cut), ANSWER.slice(cut)]);
      expect(shape(split.events), `разрез на ${cut}`).toBe(shape(whole.events));
      expect(split.flaws, `разрез на ${cut}`).toEqual([]);
    }
  });

  it('тег, приехавший по одному знаку, всё равно собирается в вызов', () => {
    const { events, flaws } = run([...ANSWER]);
    expect(flaws).toEqual([]);
    expect(shape(events)).toBe(shape(run([ANSWER]).events));
  });

  it('ни один кусок текста не несёт наружу половину тега', () => {
    for (let cut = 1; cut < ANSWER.length; cut += 1) {
      const text = run([ANSWER.slice(0, cut), ANSWER.slice(cut)])
        .events.filter((event) => event.type === 'text')
        .map((event) => (event.type === 'text' ? event.text : ''))
        .join('');
      // Целый испорченный блок наружу уходит по делу; половина тега — никогда.
      expect(text.includes('<tool_call>'), `разрез на ${cut}`).toBe(false);
      expect(/<tool_?c?a?l?l?$/.test(text), `разрез на ${cut}`).toBe(false);
    }
  });
});

describe('поток не задерживает лишнего', () => {
  it('текст без тегов уходит клиенту сразу, а не копится до конца ответа', () => {
    let index = 0;
    const parser = new ToolStreamParser({ allowed: ALLOWED, id: () => `toolu_${(index += 1)}` });
    const first = parser.push('Первое слово. ');
    expect(shape(first)).toBe('Первое слово. ');
  });

  it('придерживается ровно хвост, похожий на начало тега', () => {
    let index = 0;
    const parser = new ToolStreamParser({ allowed: ALLOWED, id: () => `toolu_${(index += 1)}` });
    expect(shape(parser.push('текст <tool'))).toBe('текст ');
    // Оказалось не тегом — придержанное уходит следом, ничего не пропало.
    expect(shape(parser.push('box'))).toBe('<toolbox');
  });

  it('открытый блок держится целиком: половина вызова наружу не идёт', () => {
    let index = 0;
    const parser = new ToolStreamParser({ allowed: ALLOWED, id: () => `toolu_${(index += 1)}` });
    expect(shape(parser.push('<tool_call>{"name":"Write","arg'))).toBe('');
    expect(shape(parser.push('uments":{}}</tool_call>'))).toBe('«Write:{}»');
  });

  it('оборванный на полуслове блок не выполняется, а показывается текстом', () => {
    const { events, flaws } = run(['<tool_call>{"name":"Write","arguments":{"content":"полов']);
    expect(flaws).toEqual(['блок без закрывающего тега']);
    expect(shape(events)).toContain('полов');
    expect(events.some((event) => event.type === 'call')).toBe(false);
  });
});

describe('несколько вызовов в потоке', () => {
  it('вызовы идут в том же порядке, в каком их написала модель', () => {
    const { events } = run([
      '<tool_call>{"name":"Read","arguments":{"file_path":"a"}}</tool_call>',
      'теперь пишу',
      '<tool_call>{"name":"Write","arguments":{"file_path":"b"}}</tool_call>',
    ]);
    expect(shape(events)).toBe('«Read:{"file_path":"a"}»теперь пишу«Write:{"file_path":"b"}»');
  });

  it('счётчик вызовов считает только состоявшиеся', () => {
    let index = 0;
    const parser = new ToolStreamParser({ allowed: ALLOWED, id: () => `toolu_${(index += 1)}` });
    parser.push('<tool_call>{"name":"Read","arguments":{}}</tool_call>');
    parser.push('<tool_call>{"name":"Bash","arguments":{}}</tool_call>');
    parser.end();
    expect(parser.calls).toBe(1);
    expect(parser.flaws).toHaveLength(1);
  });
});

/**
 * Ответ, который ЦЕЛИКОМ является объектом вызова, — вторая форма живой модели
 * среднего класса (замер 12 сентября 2026, `qwen2.5-coder:14b`: тот же верный
 * вызов, но уже вовсе без обёртки).
 *
 * Правило узкое намеренно: объект должен быть ВСЕМ ответом. Текста вокруг нет —
 * значит это и не пример, и не цитата, а единственное, что модель сказала;
 * объект посреди ответа так же не разбирается, как и раньше.
 */
describe('ответ одним объектом, без обёртки', () => {
  it('весь ответ — объект вызова: становится вызовом', () => {
    const { events, flaws } = run([
      '{\n  "name": "Write",\n  "arguments": {"file_path": "a.ts"}\n}',
    ]);
    expect(flaws).toEqual([]);
    expect(shape(events)).toBe('«Write:{"file_path":"a.ts"}»');
  });

  it('тот же объект по одному знаку — тот же вызов', () => {
    const answer = '{"name":"Read","arguments":{"file_path":"b.ts"}}';
    const { events, flaws } = run([...answer]);
    expect(flaws).toEqual([]);
    expect(shape(events)).toBe('«Read:{"file_path":"b.ts"}»');
  });

  it('объект, не назвавший объявленный инструмент, доезжает текстом байт в байт', () => {
    const answer = '{"name":"my-package","version":"1.0.0"}';
    const { events, flaws } = run([answer]);
    expect(flaws).toEqual([]);
    expect(shape(events)).toBe(answer);
  });

  it('объект, за которым идёт текст, вызовом не становится, но промах назван', () => {
    // Имя объявленного инструмента названо, а вызова не вышло: молчать об этом
    // нельзя — карточка сказала бы «вызовов не было» там, где модель их писала,
    // и человек пошёл бы чинить панель вместо промпта.
    const answer = '{"name":"Write","arguments":{}} — вот так я бы это сделал';
    const { events, flaws } = run([answer]);
    expect(flaws).toEqual(['вызов без тега принимается только целым объектом JSON']);
    expect(shape(events)).toBe(answer);
  });

  it('ответ, начинающийся с объекта, но продолжающийся прозой, не теряет ни знака', () => {
    const answer = '{"a": 1}\nЭто пример конфигурации, а не вызов.';
    const { events } = run([answer]);
    expect(shape(events)).toBe(answer);
  });
});

/**
 * Поток не должен вставать на обычном коде.
 *
 * Пока забор без метки стоял в таблице форм наравне с тегами, разборщик держал
 * ЛЮБОЙ блок кода до закрывающего забора: живая выдача агента замирала на каждом
 * примере, а обрыв связи посреди блока терял его целиком. Теперь заборы не
 * держатся вовсе — вызовом они всё равно не станут.
 */
describe('обычный код течёт, а не копится', () => {
  it('блок кода отдаётся кусками, а не разом на конце', () => {
    let index = 0;
    const parser = new ToolStreamParser({ allowed: ALLOWED, id: () => `toolu_${(index += 1)}` });
    parser.push('Сейчас покажу код.\n\n```py\n');
    const inside = parser.push('def main():\n    print(1)\n');
    expect(shape(inside)).toBe('def main():\n    print(1)\n');
  });

  it('обрыв посреди ответа отдаёт прочитанное, а не съедает его', () => {
    const parser = new ToolStreamParser({ allowed: ALLOWED });
    parser.push('Начало ответа. <tool_call>{"name":"Write"');
    // Ровно то, что видит клиент при обрыве связи с контуром: вызов собирать
    // нельзя (половина аргументов — половина файла), а текст терять нечего ради.
    expect(parser.abort()).toBe('<tool_call>{"name":"Write"');
    expect(parser.calls).toBe(0);
    expect(parser.flaws).toEqual([]);
  });
});

/**
 * Тег внутри блока кода — цитата протокола, а не вызов.
 *
 * Доказано живым прогоном враждебного ревью 12 сентября 2026: настоящий
 * `claude.exe` записал файл из блока, про который модель написала «это пример,
 * не выполняй». Так же выглядит и прочитанный агентом файл с документацией, и
 * сам промпт протокола, показанный человеку.
 */
describe('цитата протокола не выполняется', () => {
  it('тег в заборе доезжает текстом байт в байт и назван изъяном', () => {
    const answer =
      'Протокол выглядит так:\n\n```\n<tool_call>{"name":"Write","arguments":{"file_path":"a.ts"}}</tool_call>\n```\n\nЭто только пример.';
    const { events, flaws } = run([answer]);
    expect(shape(events)).toBe(answer);
    expect(flaws).toEqual(['вызов внутри блока кода не выполняется']);
  });

  it('после закрытого забора настоящий тег снова работает', () => {
    // Счёт заборов не должен «залипать»: пример в ответе не отменяет вызова,
    // написанного дальше по правилам.
    const answer =
      'Пример:\n```\n<tool_call>{"name":"Read","arguments":{}}</tool_call>\n```\nА теперь по-настоящему: <tool_call>{"name":"Write","arguments":{"file_path":"a.ts"}}</tool_call>';
    const { events, flaws } = run([answer]);
    expect(shape(events)).toContain('«Write:{"file_path":"a.ts"}»');
    expect(flaws).toEqual(['вызов внутри блока кода не выполняется']);
  });

  it('забор из тильд — такой же блок кода, и цитата в нём не выполняется', () => {
    // CommonMark знает два забора. Счёт одних кавычек пропускал `~~~`, и цитата
    // вызова в нём выполнялась (враждебный аудит контура, 13.09.2026).
    const answer =
      'Не запускай это:\n~~~\n<tool_call>{"name":"Write","arguments":{"file_path":"rm.sh"}}</tool_call>\n~~~\n';
    const { events, flaws } = run([answer]);
    expect(shape(events)).toBe(answer);
    expect(flaws).toEqual(['вызов внутри блока кода не выполняется']);
  });

  it('тройные кавычки посреди прозы не открывают блок и не гасят настоящий вызов', () => {
    const answer =
      'Блок кода начинается строкой из ``` — ниже не он. <tool_call>{"name":"Write","arguments":{"file_path":"a.ts"}}</tool_call>';
    const { events, flaws } = run([answer]);
    expect(shape(events)).toContain('«Write:{"file_path":"a.ts"}»');
    expect(flaws).toEqual([]);
  });

  it('забор закрывается только своим знаком и не короче открывшего', () => {
    // Внутри блока из четырёх кавычек три кавычки — это текст блока, а не его конец.
    const answer =
      '````\n```\n<tool_call>{"name":"Write","arguments":{"file_path":"a.ts"}}</tool_call>\n````\n';
    const { flaws } = run([answer]);
    expect(flaws).toEqual(['вызов внутри блока кода не выполняется']);
  });
});
