import { CALL_CLOSE, CALL_OPEN } from './protocol.ts';
import { repairJson, repaired, strictObject, type RepairRound } from './repair.ts';
import { serverText } from '../../../../lib/server-texts.ts';

/**
 * Разбор ОДНОГО вызова и границы блоков. Состояние потока живёт в `stream.ts`,
 * здесь — только грамматика без памяти.
 *
 * Формы приёма шире, чем форма просьбы, и это сознательно: промпт просит теги,
 * но модель, обученная на markdown, пишет забор, а модель, обученная на
 * функциях OpenAI, кладёт аргументы строкой. Каждая принятая форма названа
 * строкой ниже и закрыта своим тестом; всё, что не названо, остаётся текстом и
 * попадает в изъяны — «выполнили догадку» здесь хуже, чем «не выполнили».
 */

/** Пара тегов, которой может быть обёрнут вызов. Первая — та, о которой просит промпт. */
export interface CallForm {
  open: string;
  close: string;
  /**
   * Форма без тега — забор без метки и голый объект. Вызовом такой блок
   * становится ТОЛЬКО когда он ЦЕЛИКОМ разобрался строгим `JSON.parse` и назвал
   * объявленный клиентом инструмент. Ремонт сюда не пускается: он выдёргивает
   * первый объект из любого текста, и тогда пример, цитата и кусок прочитанного
   * файла становятся действием над файлами человека.
   */
  loose?: boolean;
}

export const CALL_FORMS: readonly CallForm[] = [{ open: CALL_OPEN, close: CALL_CLOSE }];

/**
 * Форма без тега — забор (с меткой `tool_call` или без неё) и голый объект, — и
 * она разбирается НЕ здесь, а на конце ответа (`stream.ts`), потому что
 * принимается только когда составляет ВЕСЬ ответ.
 *
 * Метка забора границы не двигает. Забор ```tool_call посреди ответа стоял в
 * общем списке форм и выполнялся с прозой вокруг — при том что справка, корневой
 * `CLAUDE.md` и карта кода все трое обещают «никогда». Живой прогон 18 сентября
 * 2026 показал, чем это кончается: настоящий `claude.exe` записал файл из блока,
 * который модель пометила «не выполняй, это пример». Метку пишет та же модель,
 * что пишет пример, — доверять ей ровно столько же, сколько безымянному забору.
 *
 * Так ответила живая `qwen2.5-coder:14b` (замер 12 сентября 2026): вызов верный,
 * обёртка markdown. Отказаться его разбирать значит оставить агента без рук
 * ровно там, ради чего прослойка и написана. Но поставить забор в один ряд с
 * тегами нельзя: обычный ответ агента полон заборов с кодом, и любой пример,
 * любая цитата протокола и любой кусок ПРОЧИТАННОГО ФАЙЛА, попав в ответ внутри
 * забора, становился бы действием над файлами человека.
 *
 * Отсюда правило: весь ответ и есть вызов — или это не вызов.
 */
export const LOOSE_FORM: CallForm = { open: '```', close: '```', loose: true };

/** Готовый вызов — уже в форме, из которой синтезируется блок диалекта. */
export interface ShimCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Какой раунд ремонта понадобился. `none` — разобралось как есть. */
  round: RepairRound;
}

/** Блок, который модель написала вызовом, но вызовом он не стал. */
export interface ShimFlaw {
  /** Причина по-русски: она уедет в след запроса и её читает человек. */
  reason: string;
  /** Имя инструмента, если его удалось прочитать. */
  name?: string;
}

/**
 * Что вышло из блока: вызов, испорченный вызов или «это не вызов вовсе».
 *
 * Третий исход есть только у забора без метки, и он не то же самое, что изъян:
 * изъян человек читает как «модель пыталась и не смогла», а кусок кода в ответе
 * никем не пытался быть вызовом. Считать его изъяном значило бы ругаться на
 * каждый блок кода.
 */
export type CallReading = { call: Omit<ShimCall, 'id'> } | { flaw: ShimFlaw } | { pass: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Аргументы вызова. Имён у поля три, потому что моделей три школы: `arguments`
 * просит наш промпт, `input` носит диалект Anthropic, `parameters` —
 * функции OpenAI. Аргументы строкой (тоже привычка OpenAI) разбираются тем же
 * ремонтом, что и сам блок.
 */
function readArguments(
  value: Record<string, unknown>,
  strict: boolean,
): Record<string, unknown> | undefined {
  const raw = value.arguments ?? value.input ?? value.parameters;
  // Инструмент без единого аргумента — законный инструмент; пустой объект
  // здесь означает «аргументов нет», а не «мы их потеряли».
  if (raw === undefined || raw === null) return {};
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    // У формы без тега ремонт запрещён и здесь: аргументы строкой — это тоже
    // текст, и «почти JSON» в нём означал бы догаданное содержимое файла.
    if (strict) return strictObject(raw);
    const parsed = repairJson(raw);
    return repaired(parsed) ? parsed.value : undefined;
  }
  return undefined;
}

/**
 * Метка языка первой строкой забора (```json, ```ts) — обычный markdown.
 * Снимаем её только когда за ней идёт объект: иначе это просто код.
 */
function withoutLanguageTag(text: string): string {
  const match = /^[A-Za-z][\w+#-]{0,14}[ \t]*\r?\n/.exec(text);
  if (!match) return text;
  const rest = text.slice(match[0].length).trimStart();
  return rest.startsWith('{') ? rest : text;
}

/**
 * Имя объявленного инструмента, названное в тексте полем `name`. Нужно ровно
 * для одного вопроса: блок, который строгим разбором вызовом не стал, — это
 * промах модели (тогда о нём надо сказать) или просто чужой текст (тогда молчим)?
 *
 * Условие узкое намеренно: имя должно стоять ПОЛЕМ `name` и совпасть с
 * инструментом, который объявил клиент. Строка `{"name": "my-package"}` из
 * package.json под него не попадает.
 */
function declaredName(text: string, allowed: ReadonlySet<string>): string | undefined {
  const match = /"name"\s*:\s*"([^"\\]{1,64})"/.exec(text);
  const name = match?.[1]?.trim();
  return name && allowed.has(name) ? name : undefined;
}

/**
 * Форма без тега: забор без метки и голый объект.
 *
 * Единственное правило — блок целиком разбирается строгим `JSON.parse`. Ремонт
 * здесь запрещён: раунд `unwrap` выдёргивает первый объект из ЛЮБОГО текста, и
 * с ним вызовом становился не «блок, который и есть вызов», а «блок, где
 * где-то есть объект с подходящим именем» — то есть любой пример, любая цитата
 * протокола и любой кусок файла, который агент прочитал и показал.
 *
 * Молчим только там, где вызовом никто и не пытался быть. Названо объявленное
 * имя, а вызова не вышло — это промах, и он уходит в изъяны: иначе форма, ради
 * которой грамматику и расширяли, при малейшем промахе исчезает из отчётности
 * бесследно.
 */
function readLooseCall(text: string, allowed: ReadonlySet<string>): CallReading {
  // Массив в корне — «несколько вызовов в одном блоке» (правило 1 промпта).
  if (!text || text.startsWith('[')) return { pass: true };

  // Забор с тегами внутри — это цитата протокола, а не вызов. Выполнять её
  // нельзя ни при каких условиях, но и молчать не о чем: модель написала вызов
  // и обернула его так, что он не выполнится.
  if (text.includes(CALL_OPEN)) {
    const quoted = declaredName(text, allowed);
    return {
      flaw: {
        reason: serverText('gateway-flaw-fenced'),
        ...(quoted ? { name: quoted } : {}),
      },
    };
  }

  const value = strictObject(text);
  if (!value) {
    const named = declaredName(text, allowed);
    return named
      ? { flaw: { reason: serverText('gateway-flaw-loose-whole'), name: named } }
      : { pass: true };
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  // Объект без имени инструмента — просто JSON в ответе: модель показала данные.
  if (!name) return { pass: true };
  if (!allowed.has(name)) {
    // Чужое имя — промах только там, где объект и по ФОРМЕ вызов: с полем
    // аргументов. Иначе это данные: `{"name":"my-package","version":"1.0.0"}`
    // из package.json назвало «имя», но вызовом быть не пыталось.
    const shaped =
      value.arguments !== undefined || value.input !== undefined || value.parameters !== undefined;
    return shaped
      ? { flaw: { reason: serverText('gateway-flaw-undeclared'), name } }
      : { pass: true };
  }

  const args = readArguments(value, true);
  if (!args) return { flaw: { reason: serverText('gateway-flaw-args'), name } };

  return { call: { name, arguments: args, round: 'none' } };
}

/**
 * Внутренность блока → вызов. `allowed` пуст — проверять имя не по чему
 * (клиент не присылал инструментов), и тогда любое имя считается чужим: вызов
 * без объявленного инструмента выполнять некому.
 */
export function readCall(
  inner: string,
  allowed: ReadonlySet<string>,
  form?: CallForm,
): CallReading {
  if (form?.loose === true) return readLooseCall(withoutLanguageTag(inner.trim()), allowed);

  const text = inner.trim();
  if (!text) return { flaw: { reason: serverText('gateway-flaw-empty') } };
  // Массив в корне — это «несколько вызовов в одном блоке» (правило 1 промпта).
  // Ремонт нашёл бы в нём первый объект и молча выполнил один вызов из двух.
  if (text.startsWith('[')) return { flaw: { reason: serverText('gateway-flaw-several') } };

  const parsed = repairJson(text);
  if (!repaired(parsed)) return { flaw: { reason: parsed.reason } };

  const value = parsed.value;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return { flaw: { reason: serverText('gateway-flaw-no-name') } };
  if (!allowed.has(name)) return { flaw: { reason: serverText('gateway-flaw-undeclared'), name } };

  const args = readArguments(value, false);
  if (!args) return { flaw: { reason: serverText('gateway-flaw-args'), name } };

  return { call: { name, arguments: args, round: parsed.round } };
}

/**
 * Сколько знаков с конца куска придержать, чтобы не разрезать открывающий тег.
 *
 * Без этого `<tool_` в конце чанка уезжает клиенту текстом, а вызов теряется:
 * граница чанка — место, где ломаются все потоковые разборщики, и ограждение
 * здесь единственное.
 */
export function holdBack(text: string, opens: readonly string[]): number {
  let hold = 0;
  for (const open of opens) {
    const limit = Math.min(open.length - 1, text.length);
    for (let size = limit; size > hold; size -= 1) {
      if (text.endsWith(open.slice(0, size))) {
        hold = size;
        break;
      }
    }
  }
  return hold;
}

/** Самый ранний из открывающих тегов. */
export function findOpen(
  text: string,
  forms: readonly CallForm[],
): { index: number; form: CallForm } | undefined {
  let best: { index: number; form: CallForm } | undefined;
  for (const form of forms) {
    const index = text.indexOf(form.open);
    if (index < 0) continue;
    if (!best || index < best.index) best = { index, form };
  }
  return best;
}
