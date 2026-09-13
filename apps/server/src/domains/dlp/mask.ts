import type { DlpHit, DlpRule } from '@agentdeck/contracts';
import { scanText, type RuleMatch } from './rules.ts';

/**
 * Замена найденного на метки и хранилище соответствий.
 *
 * Соответствие «значение → метка» живёт ТОЛЬКО в памяти процесса панели: на
 * диск не пишется никогда, ни в журнал, ни в состояние. Иначе прокси,
 * защищающий данные от ухода наружу, сам сложил бы их в файл — с полным
 * списком того, что человек считает секретным.
 *
 * Одно и то же значение получает одну и ту же метку на всё время работы
 * прокси. Это нужно и модели (в разговоре `[ИМЯ_1]` — один и тот же человек), и
 * обратной подстановке в ответе: метка из вчерашней реплики обязана
 * разворачиваться в то же значение.
 */

/** Потолок словаря меток: 20 000 значений — это уже не разговор, а утечка цикла. */
const VAULT_LIMIT = 20_000;

export interface AliasVaultOptions {
  /**
   * Вид меток, которые выдаёт САМА сторона, куда уходит запрос
   * (`driver.placeholderPattern`). Наша метка этого вида не выдаётся никогда.
   *
   * Платформа разворачивает свои метки заменой строки по всему ответу, и наша
   * `[EMAIL_1]`, совпав с её ключом, развернулась бы в ЕЁ значение — клиент
   * получил бы чужой адрес молча (стенд платформа компании, 13.09.2026). Поэтому метка,
   * попавшая в этот вид, всегда несёт номер формы: `[EMAIL_1.1]` — модели по-
   * прежнему видно, что это одно лицо, а с ключом платформы она не совпадёт.
   */
  avoid?: RegExp;
}

export class AliasVault {
  readonly #byValue = new Map<string, string>();
  readonly #byPlaceholder = new Map<string, string>();
  readonly #counters = new Map<string, number>();
  /** Номер, уже выданный этой сущности, и сколько её форм уже встречалось. */
  readonly #identities = new Map<string, { number: number; forms: number }>();
  /** Без флага `g`: `test` со своим `lastIndex` отвечал бы через раз. */
  readonly #avoid: RegExp | undefined;

  constructor(options: AliasVaultOptions = {}) {
    const avoid = options.avoid;
    this.#avoid = avoid ? new RegExp(avoid.source, avoid.flags.replace('g', '')) : undefined;
  }

  /**
   * Метка для значения: та же самая при повторной встрече.
   *
   * `identity` разделяет «кто это» и «в какой форме написано»: «Иванов» и
   * «Иванова» — один человек, но подставить обратно нужно РОВНО ту форму,
   * которая была, иначе восстановленный путь к файлу перестанет существовать.
   * Поэтому номер у форм общий, а метки разные: `[ИМЯ_1]` и `[ИМЯ_1.2]` —
   * модели видно, что это одно лицо, а подстановка остаётся точной.
   */
  placeholderFor(label: string, value: string, identity?: string): string {
    const known = this.#byValue.get(value);
    if (known) return known;
    if (this.#byValue.size >= VAULT_LIMIT) return '';

    const safeLabel = normalizeLabel(label);
    const key = `${safeLabel}|${(identity ?? value).toLowerCase()}`;

    let entry = this.#identities.get(key);
    if (!entry) {
      const next = (this.#counters.get(safeLabel) ?? 0) + 1;
      this.#counters.set(safeLabel, next);
      entry = { number: next, forms: 0 };
      this.#identities.set(key, entry);
    }
    entry.forms += 1;

    const plain = `[${safeLabel}_${entry.number}]`;
    const placeholder =
      entry.forms === 1 && !this.#avoid?.test(plain)
        ? plain
        : `[${safeLabel}_${entry.number}.${entry.forms}]`;
    this.#byValue.set(value, placeholder);
    this.#byPlaceholder.set(placeholder, value);
    return placeholder;
  }

  /** Карта «метка → значение» для обратной подстановки в ответе. */
  reverse(): ReadonlyMap<string, string> {
    return this.#byPlaceholder;
  }

  get size(): number {
    return this.#byValue.size;
  }

  clear(): void {
    this.#byValue.clear();
    this.#byPlaceholder.clear();
    this.#counters.clear();
    // Сущности тоже: иначе после перезапуска то же значение получало бы
    // `[ИМЯ_1.2]`, `[ИМЯ_1.3]` — форму «уже встречалось», которой не было.
    this.#identities.clear();
  }
}

/**
 * Метка попадает в текст запроса, поэтому в ней только буквы, цифры и
 * подчёркивание: скобка или пробел внутри сломали бы обратный поиск.
 */
function normalizeLabel(label: string): string {
  const cleaned = [...label.toUpperCase()].filter((char) => /[\p{L}\d_]/u.test(char)).join('');
  return cleaned || 'ДАННЫЕ';
}

export interface MaskResult {
  text: string;
  hits: DlpHit[];
  /** Правило с действием `block`, если сработало: запрос дальше не идёт. */
  blockedBy?: { ruleId: string; ruleName: string };
}

/**
 * Заменить в тексте всё, что нашли правила. Замена идёт справа налево: позиции
 * совпадений посчитаны по исходному тексту, и левый сдвиг ломал бы их все.
 */
export function maskText(text: string, rules: readonly DlpRule[], vault: AliasVault): MaskResult {
  const matches = scanText(text, rules);
  if (matches.length === 0) return { text, hits: [] };

  const blocking = matches.find((match) => match.action === 'block');
  if (blocking) {
    return {
      text,
      hits: [countsOf(matches)].flat(),
      blockedBy: { ruleId: blocking.ruleId, ruleName: blocking.ruleName },
    };
  }

  const placeholders = new Map<RuleMatch, string>();

  // Метки выдаются СЛЕВА НАПРАВО: первый по тексту человек должен стать
  // `[ИМЯ_1]`, иначе нумерация в ответе читается задом наперёд.
  for (const match of matches) {
    if (match.action !== 'mask') continue;
    const placeholder = vault.placeholderFor(match.label, match.value, match.identity);
    if (placeholder) placeholders.set(match, placeholder);
  }

  // А замена — справа налево: позиции посчитаны по исходному тексту, и сдвиг
  // слева сломал бы все последующие.
  let out = text;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (!match) continue;
    const placeholder = placeholders.get(match);
    if (!placeholder) continue; // не замена либо словарь переполнен
    out = out.slice(0, match.start) + placeholder + out.slice(match.end);
  }

  return { text: out, hits: countsOf(matches, placeholders) };
}

/**
 * Сводка срабатываний для журнала и интерфейса: правило, метка, счётчик.
 * Самого значения здесь нет и быть не может — это ровно то, что защищаем.
 */
function countsOf(
  matches: readonly RuleMatch[],
  placeholders?: ReadonlyMap<RuleMatch, string>,
): DlpHit[] {
  const byKey = new Map<string, DlpHit>();

  for (const match of matches) {
    const placeholder = placeholders?.get(match) ?? '';
    const key = `${match.ruleId}\u0000${placeholder}`;
    const known = byKey.get(key);
    if (known) {
      known.count += 1;
      continue;
    }
    byKey.set(key, {
      ruleId: match.ruleId,
      ruleName: match.ruleName,
      action: match.action,
      placeholder,
      count: 1,
    });
  }

  return [...byKey.values()];
}

/** Сложить сводки нескольких кусков текста в одну. */
export function mergeHits(groups: readonly DlpHit[][]): DlpHit[] {
  const byKey = new Map<string, DlpHit>();
  for (const group of groups) {
    for (const hit of group) {
      const key = `${hit.ruleId}\u0000${hit.placeholder}`;
      const known = byKey.get(key);
      if (known) known.count += hit.count;
      else byKey.set(key, { ...hit });
    }
  }
  return [...byKey.values()];
}
