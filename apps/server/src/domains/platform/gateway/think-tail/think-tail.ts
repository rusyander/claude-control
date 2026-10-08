/**
 * Размышления модели, приехавшие ТЕКСТОМ ответа (L9, живая проба dev 14.09.2026).
 *
 * Qwen3.8 за vLLM без разборщика размышлений пишет их прямо в `content` и
 * закрывает голым `</think>` — открывающий тег стоит в шаблоне промпта и в
 * ответ не попадает. Отданный как есть, такой ответ показывает человеку черновик
 * модели, а прослойка инструментов читает вызовы из рассуждения, где модель
 * только ПРИКИДЫВАЕТ, что вызвать.
 *
 * Два режима, и выбирает их не угадывание, а факт:
 * - `lead` — для любой модели. Размышлением считается только ответ, который
 *   НАЧИНАЕТСЯ с `<think>`: начало однозначно, а обычный ответ, где тег
 *   упомянут в середине, остаётся текстом. Держится лишь первый короткий кусок —
 *   пока не ясно, тег это или нет.
 * - `tail` — для модели, у которой голый `</think>` уже видели (факт хранилища,
 *   `platformThinkTail`). Всё содержимое держится до `</think>`; без этого
 *   факта держать пришлось бы весь ответ у каждой модели, и поток перестал бы
 *   быть потоком.
 *
 * Закрывающий тег так и не пришёл — придержанное отдаётся текстом целиком:
 * модель, которая на этот раз не размышляла, не должна ответить пустотой.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

export type ThinkMode = 'lead' | 'tail';

export class ThinkSplitter {
  #state: 'start' | 'thinking' | 'content';
  #held = '';
  /** Размышление в этом ответе уже было — значит, следующий `</think>` не голый. */
  #thought = false;
  /** Размышление только что закрылось — пробелы перед ответом ещё срезаются. */
  #trimLead = false;
  /** Хвост уже отданного текста — чтобы увидеть `</think>`, разрезанный чанками. */
  #tail = '';
  /** Сколько знаков размышления снято с ответа. */
  reasoningChars = 0;
  /**
   * В ответе, отданном текстом, встретился голый `</think>` — модель пишет
   * размышления в текст без открывающего тега. Отсюда факт для следующих ответов.
   */
  sawBareClose = false;

  constructor(mode: ThinkMode) {
    this.#state = mode === 'tail' ? 'thinking' : 'start';
  }

  /** Кусок текста модели → то, что можно отдать клиенту сейчас. */
  push(text: string): string {
    if (!text) return '';
    if (this.#state === 'content') return this.#content(text);
    this.#held += text;
    if (this.#state === 'start') {
      const lead = this.#held.trimStart();
      if (lead.startsWith(OPEN)) {
        this.#held = lead.slice(OPEN.length);
        this.#state = 'thinking';
      } else if (OPEN.startsWith(lead)) {
        return '';
      } else {
        const out = this.#held;
        this.#held = '';
        this.#state = 'content';
        return this.#content(out);
      }
    }
    return this.#thinking();
  }

  /** Поток кончился: незакрытое размышление отдаётся текстом, а не теряется. */
  end(): string {
    if (this.#state === 'content') return '';
    const out = this.#held;
    this.#held = '';
    this.#state = 'content';
    return out;
  }

  #thinking(): string {
    // Тег в режиме `tail` может и открывать размышление — шаблон бывает разным.
    const lead = this.#held.trimStart();
    if (lead.startsWith(OPEN)) this.#held = lead.slice(OPEN.length);
    const at = this.#held.indexOf(CLOSE);
    if (at < 0) return '';
    this.reasoningChars += at;
    this.#thought = true;
    const rest = this.#held.slice(at + CLOSE.length);
    this.#held = '';
    this.#state = 'content';
    this.#trimLead = true;
    return this.#content(rest);
  }

  #content(chunk: string): string {
    // Пустые строки между размышлением и ответом приезжают и следующим чанком.
    const text = this.#trimLead ? chunk.replace(/^\s+/, '') : chunk;
    if (text) this.#trimLead = false;
    const window = this.#tail + text;
    if (!this.#thought && window.includes(CLOSE)) this.sawBareClose = true;
    this.#tail = window.slice(-(CLOSE.length - 1));
    return text;
  }
}

/**
 * Цельный текст модели без размышления — для итога платформы, который сверяется
 * с уже очищенным потоком. Закрывающего тега нет — текст возвращается как есть.
 */
export function withoutThink(text: string): string {
  const splitter = new ThinkSplitter('tail');
  return splitter.push(text) + splitter.end();
}
