import { serverText } from '../../../../lib/server-texts.ts';
/**
 * Ремонт JSON вызова — не больше двух раундов, и оба местные.
 *
 * Просить модель переписать блок здесь НЕЛЬЗЯ: ремонт зовётся и посреди потока,
 * где второго запроса наверх уже не сделать, а лишний ход стоит человеку денег
 * и секунд. Поэтому чинится ровно то, что чинится детерминированно, и каждый
 * раунд назван: раунд виден в следе запроса, и «вызов доехал со второй попытки»
 * человек читает как повод поправить промпт, а не как случайность.
 *
 * Чего раунды не делают: не угадывают пропущенные значения, не переводят
 * одинарные кавычки в двойные (апостроф внутри текста тогда разваливает строку
 * молча) и не дописывают скобки. Неразобранный блок остаётся ТЕКСТОМ и назван
 * испорченным — это честнее, чем выполнить вызов, собранный догадкой.
 */

/** Какой раунд ремонта помог. `none` — разобралось как есть. */
export type RepairRound = 'none' | 'unwrap' | 'syntax';

export interface RepairSuccess {
  value: Record<string, unknown>;
  round: RepairRound;
}

export interface RepairFailure {
  /** Почему не вышло — коротко и по-русски: текст едет в след запроса. */
  reason: string;
}

export type RepairResult = RepairSuccess | RepairFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Строгий разбор: текст ЦЕЛИКОМ — объект JSON, и ничего больше.
 *
 * Это единственная дверь для форм без тега (`parse.ts`, свободный забор и голый
 * объект). Ремонт там запрещён не из аккуратности: `unwrap` выдёргивает первый
 * объект из ЛЮБОГО текста, и пущенный на эту ветку он превращает любой пример,
 * цитату и кусок прочитанного файла в исполняемый вызов.
 */
export function strictObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Внешний объект в куске текста. Скобки считаются с оглядкой на строки: `{`
 * внутри значения — обычный знак, и наивный поиск последней `}` отрезал бы
 * содержимое файла на первой же фигурной скобке в коде.
 */
function outermostObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/** Раунд 1: снять заборы markdown, пояснения до и после, взять сам объект. */
function unwrap(text: string): string | undefined {
  const withoutFences = text.replace(/```[a-z_]*\s*/gi, '').replace(/```/g, '');
  return outermostObject(withoutFences);
}

/**
 * Раунд 2: то, что модель ломает чаще всего, — настоящий перенос строки внутри
 * значения (правило 5 промпта требует `\n`, а 14B-модель про него забывает) и
 * запятая перед закрывающей скобкой.
 */
function fixSyntax(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += char;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        out += char;
        continue;
      }
      if (char === '"') {
        inString = false;
        out += char;
        continue;
      }
      // Управляющий знак внутри строки JSON запрещён — именно на нём разбор и
      // падает. Экранируем, а не выбрасываем: это содержимое файла.
      if (char === '\n') out += '\\n';
      else if (char === '\r') out += '\\r';
      else if (char === '\t') out += '\\t';
      else out += char;
      continue;
    }
    if (char === '"') inString = true;
    out += char;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Текст вызова → объект. Раунды идут по нарастающей и накапливаются: второй
 * чинит то, что осталось после первого.
 */
export function repairJson(text: string): RepairResult {
  const direct = strictObject(text);
  if (direct) return { value: direct, round: 'none' };

  const unwrapped = unwrap(text);
  if (unwrapped) {
    const value = strictObject(unwrapped);
    if (value) return { value, round: 'unwrap' };

    const fixed = strictObject(fixSyntax(unwrapped));
    if (fixed) return { value: fixed, round: 'syntax' };
  }

  const fixed = strictObject(fixSyntax(text));
  if (fixed) return { value: fixed, round: 'syntax' };

  return {
    reason: serverText(text.includes('{') ? 'gateway-flaw-not-json' : 'gateway-flaw-no-object'),
  };
}

export function repaired(result: RepairResult): result is RepairSuccess {
  return 'value' in result;
}
