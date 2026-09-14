import type { DlpBuiltinInfo, DlpRule } from '@agentdeck/contracts';
import { DLP_BUILTIN_IDS, DLP_BUILTINS, type DlpBuiltinId } from './builtins.mjs';
import { readRules } from './rules-store.ts';

/**
 * Встроенный набор правил — чем маскирует контур, когда раздел «Защита данных»
 * пуст (Р11, 15.09.2026).
 *
 * Маска контура включается сама, если контур объявил подмену данных: проба dev
 * показала, что на пути по ключу контур не подменяет ничего, и наша маска там —
 * единственная защита. Включить её и отправить запрос с пустым списком правил
 * значило бы ровно то ложное спокойствие, против которого написан раздел, —
 * поэтому пустой раздел здесь означает «все встроенные образцы».
 *
 * Названия и метки русские: это текст панели в отказе, журнале и метке в
 * запросе, а не строка интерфейса.
 */

const NAMES: Record<DlpBuiltinId, { name: string; label: string }> = {
  email: { name: 'Электронная почта', label: 'ПОЧТА' },
  phone_ru: { name: 'Телефон РФ', label: 'ТЕЛЕФОН' },
  phone_intl: { name: 'Международный телефон', label: 'ТЕЛЕФОН' },
  inn: { name: 'ИНН', label: 'ИНН' },
  snils: { name: 'СНИЛС', label: 'СНИЛС' },
  ogrn: { name: 'ОГРН и ОГРНИП', label: 'ОГРН' },
  passport_ru: { name: 'Паспорт РФ', label: 'ПАСПОРТ' },
  passport_ru_foreign: { name: 'Заграничный паспорт РФ', label: 'ПАСПОРТ' },
  passport_uz: { name: 'Паспорт Узбекистана и той же формы', label: 'ПАСПОРТ' },
  card: { name: 'Номер карты', label: 'КАРТА' },
  iban: { name: 'IBAN', label: 'СЧЁТ' },
  crypto_wallet: { name: 'Криптокошелёк', label: 'КОШЕЛЁК' },
  ipv4: { name: 'IP-адрес v4', label: 'IP' },
  ipv6: { name: 'IP-адрес v6', label: 'IP' },
  mac: { name: 'MAC-адрес', label: 'MAC' },
  uuid: { name: 'UUID', label: 'UUID' },
  url: { name: 'Адрес в сети', label: 'URL' },
  credentials_url: { name: 'Логин и пароль в адресе', label: 'ДОСТУП' },
  jwt: { name: 'JWT', label: 'ТОКЕН' },
  secret_key: { name: 'Ключи и токены сервисов', label: 'КЛЮЧ' },
};

/**
 * Что отклоняет запрос, а не маскирует: ключ и токен уходят целиком или не
 * уходят вовсе — модель меткой воспользоваться не может, а человек решил бы, что
 * ключ ушёл безопасно. Тот же выбор, что у стартового набора в разделе.
 */
export const BLOCKING_BUILTINS: readonly DlpBuiltinId[] = ['secret_key', 'jwt'];

export function builtinRuleSet(): DlpRule[] {
  return DLP_BUILTIN_IDS.map((id) => ({
    id: `builtin-${id}`,
    name: NAMES[id].name,
    enabled: true,
    kind: 'builtin' as const,
    builtin: id,
    terms: [],
    pattern: '',
    action: BLOCKING_BUILTINS.includes(id) ? ('block' as const) : ('mask' as const),
    label: NAMES[id].label,
  }));
}

/** Образцы для экрана: выражение и признак проверки кодом. */
export function builtinInfos(): DlpBuiltinInfo[] {
  return DLP_BUILTIN_IDS.map((id) => ({
    id,
    pattern: DLP_BUILTINS[id].source,
    validated: typeof DLP_BUILTINS[id].validate === 'function',
  }));
}

export type MaskRules =
  { source: 'own' | 'builtin'; rules: DlpRule[] } | { source: 'broken'; error: string };

/**
 * Правила маски контура. Свои включённые правила раздела — если они есть;
 * нет ни одного — встроенный набор. Битый файл — это ОШИБКА, а не «правил нет»:
 * встроенный набор поверх испорченного словаря молча потерял бы фамилии,
 * которые человек туда вписал.
 */
export function maskRulesFor(appDataDir: string): MaskRules {
  let rules: DlpRule[];
  try {
    rules = readRules(appDataDir);
  } catch (error) {
    return { source: 'broken', error: error instanceof Error ? error.message : String(error) };
  }
  const enabled = rules.filter((rule) => rule.enabled);
  return enabled.length > 0
    ? { source: 'own', rules: enabled }
    : { source: 'builtin', rules: builtinRuleSet() };
}
