import type { DlpRule } from '@agentdeck/contracts';
import type { PanelAgentMessage } from '@agentdeck/contracts/panel-agent';
import { BLOCKING_BUILTINS, builtinRuleSet, maskRulesFor } from '../dlp/default-rules.ts';
import type { DlpBuiltinId } from '../dlp/builtins.mjs';
import { AliasVault, maskText } from '../dlp/mask.ts';
import { replaceSecrets } from '../../lib/secret-mask.ts';

/**
 * Маска реплик человека до модели (§3.4 задания агента панели): ключ, вставленный
 * в сообщение агенту, до модели не доходит — фильтром данных, который уже есть.
 *
 * Правила — из того же раздела, что у маски контура (`maskRulesFor`), и тот же
 * `maskText`. Второго набора образцов здесь нет, отличий три, и все о том, что
 * это окно, а не шлюз:
 * - раздел пуст — маскируются ТОЛЬКО ключи и доступы (`secret_key`, `jwt`,
 *   `credentials_url`), а не весь встроенный набор. Человек пишет агенту именно
 *   ссылку контура, адрес хоста, почту интеграции, id кейса — это и есть
 *   данные задачи; встроенный набор превращал «вот ссылка https://…» в `[URL_1]`,
 *   и агенту оставалось только переспросить (приёмка 17.09.2026, D1). Личные
 *   данные маскируются, когда человек сам завёл правила раздела;
 * - ключи и токены добавляются ВСЕГДА, даже поверх своих правил без них: ради
 *   них маска здесь и стоит, а свой словарь фамилий не повод пропустить ключ;
 * - «отклонить» здесь маскирует. Шлюз отклоняет запрос, потому что модели метка
 *   бесполезна; агенту ключ не нужен вовсе — он откроет поле пароля, — а отказ
 *   хода оставил бы человека с непонятной ошибкой вместо ответа «введите ключ
 *   в поле». Наружу значение не уходит ни так, ни так.
 * Битый файл правил — отказ хода, а не проход без маски (fail-closed, как у шлюза).
 */

export type MaskedMessages =
  { ok: true; messages: PanelAgentMessage[]; masked: number } | { ok: false; message: string };

/** Что маскируется всегда: ключи, токены и логин с паролем в адресе. */
export const AGENT_ALWAYS_MASKED: readonly DlpBuiltinId[] = [
  ...BLOCKING_BUILTINS,
  'credentials_url',
];

function agentRules(appDataDir: string): DlpRule[] | string {
  const set = maskRulesFor(appDataDir);
  if (set.source === 'broken') return set.error;
  // Пустой раздел — не «все встроенные», а только секреты (см. шапку).
  const own = set.source === 'own' ? set.rules : [];
  const present = new Set(own.map((rule) => rule.builtin).filter(Boolean));
  const secrets = builtinRuleSet().filter(
    (rule) =>
      rule.builtin && AGENT_ALWAYS_MASKED.includes(rule.builtin) && !present.has(rule.builtin),
  );
  return [...own, ...secrets].map((rule) =>
    rule.action === 'block' ? { ...rule, action: 'mask' as const } : rule,
  );
}

export function maskPanelAgentMessages(
  appDataDir: string,
  messages: readonly PanelAgentMessage[],
): MaskedMessages {
  const rules = agentRules(appDataDir);
  if (typeof rules === 'string') {
    return {
      ok: false,
      message: `Правила защиты данных не читаются (${rules}) — ход не запущен, чтобы сообщение не ушло в модель без маски. Исправьте правила в разделе «Защита данных».`,
    };
  }
  // Один словарь на ход: одно значение в разных репликах — одна метка.
  const vault = new AliasVault();
  let masked = 0;
  const out = messages.map((message) => {
    if (message.role !== 'user') return message;
    const result = maskText(message.content, rules, vault);
    // Второй проход — детектор секретов панели: встроенные образцы DLP знают
    // только ключи с префиксом вендора, а ключ контура, 32 hex, `key=…` и
    // «пароль …» уходили в модель и в файл разговора как есть (ревью 17.09.2026).
    // Метка — из того же словаря хода, чтобы один ключ везде назывался одинаково.
    const text = replaceSecrets(
      result.text,
      (value) => vault.placeholderFor('КЛЮЧ', value, value) || '[КЛЮЧ]',
    );
    if (text === message.content) return message;
    masked += 1;
    return { ...message, content: text };
  });
  return { ok: true, messages: out, masked };
}
