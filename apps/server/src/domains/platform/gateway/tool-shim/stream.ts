import { randomBytes } from 'node:crypto';
import {
  CALL_FORMS,
  findOpen,
  holdBack,
  LOOSE_FORM,
  readCall,
  type CallForm,
  type ShimCall,
  type ShimFlaw,
} from './parse.ts';

/**
 * Потоковый разбор ответа: текст модели → куски текста и готовые вызовы, в том
 * же порядке, в каком их написала модель.
 *
 * Разборщик один на оба пути — и на поток клиенту, и на «собери мне ответ
 * целиком»: второй разборщик, написанный «на цельное тело», разошёлся бы с
 * первым в первую же неделю, и расходились бы они молча.
 *
 * Главное здесь — ГРАНИЦА ЧАНКА. Контур режет ответ где придётся, и тег вызова
 * приезжает двумя кусками. Поэтому наружу никогда не уходит хвост, который
 * может оказаться началом тега, а всё, что после открывающего тега, держится до
 * закрывающего: увиденный клиентом `<tool_call>` — это вызов, не ставший
 * вызовом, и агент показывает его человеку как ответ.
 */

/** Что разборщик отдаёт наружу — по одному событию на кусок. */
export type ShimEvent = { type: 'text'; text: string } | { type: 'call'; call: ShimCall };

export interface StreamParserOptions {
  /** Имена инструментов, объявленных клиентом. Чужое имя вызовом не станет. */
  allowed: ReadonlySet<string>;
  /** Подстановка идентификаторов для тестов. */
  id?: () => string;
}

function defaultId(): string {
  return `toolu_${randomBytes(12).toString('hex')}`;
}

const OPENS = CALL_FORMS.map((form) => form.open);

/**
 * Ответ, который ЦЕЛИКОМ является вызовом: голый объект или один забор без
 * метки и ничего вокруг. Так отвечает модель среднего класса, привыкшая к
 * вендорному формату функций (замер 12 сентября 2026, `qwen2.5-coder:14b`).
 *
 * Внутренность одного забора — если весь ответ это ровно он. Второй забор
 * внутри означает, что ответ из заборов состоит, а не является вызовом.
 */
function wholeFence(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```') || trimmed.length < 7) {
    return undefined;
  }
  const inner = trimmed.slice(3, -3);
  return inner.includes('```') ? undefined : inner;
}

export class ToolStreamParser {
  #options: StreamParserOptions;
  #buffer = '';
  /** Открытый блок: ждём его закрывающий тег. */
  #form: CallForm | undefined;
  /**
   * Ответ начался с фигурной скобки или с забора: держим его целиком до конца —
   * решение «весь ответ и есть вызов» принимается только когда известно, что в
   * нём больше ничего нет. `undefined` — первого непробельного знака ещё не было.
   *
   * Обычный ответ, начавшийся с прозы, при этом течёт как тёк: заборы с кодом
   * внутри него больше не задерживаются вовсе — вызовом они всё равно не станут.
   */
  #lone: boolean | undefined;

  /** Весь текст ответа — для двух проверок: `#insideFence` и `#noteFencedCall`. */
  #seen = '';
  #noted = false;
  /** Цитата протокола внутри блока кода уже названа — второй раз не называем. */
  #quoted = false;

  /** Блоки, которые вызовом не стали, — по одной записи на блок. */
  readonly flaws: ShimFlaw[] = [];
  /** Сколько вызовов собрано за весь ответ. */
  calls = 0;

  constructor(options: StreamParserOptions) {
    this.#options = options;
  }

  push(chunk: string): ShimEvent[] {
    this.#buffer += chunk;
    this.#seen += chunk;
    const events: ShimEvent[] = [];

    if (this.#lone === undefined) {
      const head = this.#buffer.trimStart();
      // Два знака решают: `{` — вендорная форма функций, ``` — забор без метки.
      // Оба принимаются только целым ответом, поэтому оба ждут его конца.
      if (head.length >= 3 || (head && !'```'.startsWith(head))) {
        this.#lone = head.startsWith('{') || head.startsWith('```');
      }
    }
    // Придержать до конца ответа — не задержка ради задержки: пока ответ не
    // кончился, «это весь ответ» проверить нечем, а отдать объект текстом и
    // потом объявить его вызовом уже нельзя.
    if (this.#lone) return events;

    for (;;) {
      if (this.#form) {
        const close = this.#buffer.indexOf(this.#form.close);
        // Закрывающего тега ещё нет: держим всё. Отдать половину вызова —
        // ровно та беда, ради которой разборщик и написан.
        if (close < 0) return events;

        const inner = this.#buffer.slice(0, close);
        const form = this.#form;
        this.#buffer = this.#buffer.slice(close + form.close.length);
        this.#form = undefined;

        const reading = readCall(inner, this.#options.allowed, form);
        // Забор, который вызовом и не пытался быть: отдаём как есть и молчим —
        // изъян тут значил бы жалобу на каждый кусок кода в ответе.
        if ('pass' in reading) {
          events.push({ type: 'text', text: `${form.open}${inner}${form.close}` });
          continue;
        }
        if ('flaw' in reading) {
          this.flaws.push(reading.flaw);
          // Испорченный блок уходит клиенту КАК ЕСТЬ: человек должен увидеть,
          // что модель пыталась сделать. Проглотить его значило бы показать
          // пустой ответ там, где модель работала.
          events.push({ type: 'text', text: `${form.open}${inner}${form.close}` });
          continue;
        }

        this.calls += 1;
        events.push({
          type: 'call',
          call: { id: (this.#options.id ?? defaultId)(), ...reading.call },
        });
        continue;
      }

      const found = findOpen(this.#buffer, CALL_FORMS);
      if (found) {
        // Тег ВНУТРИ блока кода — цитата протокола, а не вызов: так выглядит и
        // документация, и прочитанный агентом файл, и сам промпт протокола.
        // Выполнить её значит дать чужому тексту писать файлы человека.
        if (this.#insideFence(found.index)) {
          const upto = found.index + found.form.open.length;
          events.push({ type: 'text', text: this.#buffer.slice(0, upto) });
          this.#buffer = this.#buffer.slice(upto);
          if (!this.#quoted) {
            this.#quoted = true;
            this.flaws.push({ reason: 'вызов внутри блока кода не выполняется' });
          }
          continue;
        }
        const before = this.#buffer.slice(0, found.index);
        if (before) events.push({ type: 'text', text: before });
        this.#buffer = this.#buffer.slice(found.index + found.form.open.length);
        this.#form = found.form;
        continue;
      }

      const hold = holdBack(this.#buffer, OPENS);
      const text = this.#buffer.slice(0, this.#buffer.length - hold);
      this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
      if (text) events.push({ type: 'text', text });
      return events;
    }
  }

  /**
   * Поток оборвался — не кончился. Всё придержанное возвращается ТЕКСТОМ, как
   * его написала модель, и ни одного вызова отсюда не выходит: ответ, который
   * панель объявила негодным, не должен превращаться в действие над файлами.
   *
   * Изъяна тут тоже нет: модель ни в чём не промахнулась — оборвали её.
   */
  abort(): string {
    const text = this.#form ? `${this.#form.open}${this.#buffer}` : this.#buffer;
    this.#buffer = '';
    this.#form = undefined;
    this.#lone = false;
    return text;
  }

  /**
   * Конец ответа. Незакрытый блок вызовом НЕ становится (правило 6 промпта):
   * модель оборвалась на полуслове, и выполнить половину аргументов — это
   * записать половину файла.
   */
  end(): ShimEvent[] {
    if (this.#lone) {
      this.#lone = false;
      // Тег внутри — ответ не «весь вызов», и разбирать его должен общий путь:
      // иначе цитата протокола внутри такого ответа посчиталась бы дважды —
      // изъяном здесь и вызовом там.
      const wrapped = findOpen(this.#buffer, CALL_FORMS);
      // Один забор без метки на весь ответ — его внутренность и есть вызов.
      // Начался с забора, но целым забором не оказался — значит ответ из
      // заборов СОСТОИТ, и говорить о нём должен `#noteFencedCall`: он назовёт
      // ту причину, которая правда.
      const fenced = wholeFence(this.#buffer);
      const whole = fenced ?? (this.#buffer.trimStart().startsWith('{') ? this.#buffer : undefined);
      const reading =
        wrapped || whole === undefined
          ? ({ pass: true } as const)
          : readCall(whole, this.#options.allowed, LOOSE_FORM);
      if ('call' in reading) {
        this.#buffer = '';
        this.calls += 1;
        return [{ type: 'call', call: { id: (this.#options.id ?? defaultId)(), ...reading.call } }];
      }
      // Названное имя без вызова — промах модели, и он обязан быть виден: иначе
      // «объект с хвостом» и «объект с чужим именем» выглядят как обычный ответ.
      if ('flaw' in reading) this.flaws.push(reading.flaw);
      // Не вызов — значит обычный ответ, просто начавшийся со скобки: тот же
      // текст идёт общим путём, и теги с заборами внутри него не теряются.
      return [...this.push(''), ...this.end()];
    }
    this.#noteFencedCall();
    if (this.#form) {
      const text = `${this.#form.open}${this.#buffer}`;
      // У забора без метки незакрытость — не изъян: обычный ответ может
      // кончиться открытым блоком кода, и жаловаться тут не на что.
      if (!this.#form.loose) this.flaws.push({ reason: 'блок без закрывающего тега' });
      this.#buffer = '';
      this.#form = undefined;
      return text ? [{ type: 'text', text }] : [];
    }
    const text = this.#buffer;
    this.#buffer = '';
    return text ? [{ type: 'text', text }] : [];
  }

  /**
   * Стоит ли знак с этим местом буфера внутри открытого блока кода.
   *
   * Считается по ВСЕМУ тексту ответа до него: заборов нечётное число — значит
   * последний открыт. Разборщик сами заборы не держит (обычный ответ агента
   * полон кода, и держать его до закрытия значит останавливать выдачу на каждом
   * блоке), поэтому «где мы» узнаётся счётом, а не состоянием.
   */
  #insideFence(index: number): boolean {
    const before = this.#seen.slice(0, this.#seen.length - this.#buffer.length + index);
    let fences = 0;
    let at = before.indexOf('```');
    while (at >= 0) {
      fences += 1;
      at = before.indexOf('```', at + 3);
    }
    return fences % 2 === 1;
  }

  /**
   * Готовый вызов, написанный забором ПОСРЕДИ ответа, не выполняется — но и
   * молчать о нём нельзя.
   *
   * Без этой записи человек читает на карточке «вызовов не было» ровно там, где
   * модель их писала раз за разом, и идёт чинить панель. Чинить надо промпт:
   * вызов посреди ответа неотличим от примера, и выполняются только теги либо
   * ответ, который весь и есть вызов.
   */
  #noteFencedCall(): void {
    if (this.#noted || this.calls > 0) return;
    this.#noted = true;

    for (const match of this.#seen.matchAll(/```[a-z_]*\r?\n([\s\S]*?)```/gi)) {
      const reading = readCall(match[1] ?? '', this.#options.allowed, LOOSE_FORM);
      if ('call' in reading) {
        this.flaws.push({
          reason: 'вызов забором посреди ответа не выполняется',
          name: reading.call.name,
        });
        return;
      }
    }
  }
}

export interface ParsedAnswer {
  events: ShimEvent[];
  calls: ShimCall[];
  flaws: ShimFlaw[];
  /** Текст ответа без блоков вызова — то, что человек читает как ответ. */
  text: string;
}

/** Весь ответ разом — тем же разборщиком, что и поток. */
export function parseToolCalls(text: string, options: StreamParserOptions): ParsedAnswer {
  const parser = new ToolStreamParser(options);
  const events = [...parser.push(text), ...parser.end()];
  return {
    events,
    calls: events.flatMap((event) => (event.type === 'call' ? [event.call] : [])),
    flaws: parser.flaws,
    text: events.map((event) => (event.type === 'text' ? event.text : '')).join(''),
  };
}
