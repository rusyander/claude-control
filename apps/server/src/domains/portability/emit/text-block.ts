import type { EnvItem, PermissionDecision } from '@agentdeck/contracts/portable-env';

/**
 * ОБЛАСТЬ ПАНЕЛИ в чужом файле инструкций — и то, во что превращается запись,
 * доехавшая текстом.
 *
 * Файл инструкций у цели чужой и написан человеком. Поэтому перенос занимает в
 * нём область между метками и не трогает ничего снаружи: перезапись файла
 * целиком стёрла бы собственный текст человека, а дописывание в конец на каждом
 * применении плана наращивало бы копии — инвариант 10 требует обратного.
 *
 * Живёт отдельным модулем, потому что область одна и та же у двух разных
 * писателей: универсального (`write-instructions.ts`, девять чужих CLI) и
 * claude-овского (`claude.ts`). Вторая копия меток означала бы, что перенос
 * «туда» и «обратно» ведёт в одном файле ДВЕ области, каждая со своей историей.
 */

/** Метки области, которую ведёт панель. ASCII намеренно: их читает код, а не человек. */
export const BLOCK_BEGIN = '<!-- agentdeck:portability:begin -->';
export const BLOCK_END = '<!-- agentdeck:portability:end -->';

/** Область панели целиком, с предупреждением человеку первой строкой. */
export function blockOf(blocks: readonly string[]): string {
  const head =
    '<!-- Этот раздел ведёт панель: правки внутри него перезапишет следующий перенос. -->';
  return [BLOCK_BEGIN, head, '', blocks.join('\n\n'), BLOCK_END].join('\n');
}

/**
 * Вставить область в текст: есть метки — заменяем ровно её, нет — дописываем в
 * конец. Текст человека снаружи меток не меняется ни в том, ни в другом случае.
 */
export function spliceBlock(original: string, block: string): string {
  const start = original.indexOf(BLOCK_BEGIN);
  const end = original.indexOf(BLOCK_END);
  if (start !== -1 && end > start) {
    return `${original.slice(0, start)}${block}${original.slice(end + BLOCK_END.length)}`;
  }
  if (!original.trim()) return `${block}\n`;
  return `${original.replace(/\s+$/, '')}\n\n${block}\n`;
}

/** Действует ли запись у источника. Вид без выключателя считается действующим. */
export function isEnabled(item: EnvItem): boolean {
  return 'enabled' in item ? item.enabled : true;
}

/**
 * Запись плоским текстом. Вид назван вслух: инструкция «делай как скилл» без
 * слова «скилл» читается моделью как часть общих правил, и человек потом не
 * поймёт, откуда взялся текст.
 */
export function textOf(item: EnvItem): string {
  switch (item.kind) {
    case 'instructions':
      return `## ${item.fileName}\n\n${item.text.trim()}`;
    case 'skill':
      return `## Скилл «${item.name}»\n\n${item.description}\n\n${item.body.trim()}`;
    case 'command':
      return `## Команда /${item.name}\n\n${item.description}\n\n${item.prompt.trim()}`;
    case 'hook':
      // Хук текстом — это правило поведения, а не запуск скрипта: команда
      // названа, чтобы человек видел, что именно не исполняется автоматически.
      return `## Правило вместо хука: ${item.intent}\n\nКоманда у источника: \`${item.command}\``;
    case 'permission':
      // Право текстом обязано назвать САМ запрет — решение и правило, — а не
      // только его пересказ. `intent` у записи, собранной нормализатором,
      // правило действительно содержит (`deny: Read(.env) (project settings)`),
      // но это совпадение, а не договор: у записи, пришедшей из чужого файла или
      // написанной человеком, там проза. Живая проба 22.09.2026 поймала ровно
      // это: пробное право доехало к codex строкой «право обязано отказать в
      // чтении условленного файла», в которой нет ни имени файла, ни слова
      // «запрещено», — модель прочитала намерение и не узнала запрета.
      //
      // Три цели держат право только так (`codex`, `aider`, `goose`): для них
      // этот текст — весь перенос права, и его неполнота молча снимает запрет.
      return `## Право: ${DECISION_WORDS[item.decision]} \`${item.rule}\`\n\n${item.intent}`;
    default:
      return `## ${item.intent}`;
  }
}

/**
 * Решение по-русски. Словарь, а не `decision` как есть: текст читает МОДЕЛЬ
 * цели, и английское `deny` рядом с русской фразой она вправе принять за часть
 * правила, а не за приговор.
 */
const DECISION_WORDS: Record<PermissionDecision, string> = {
  allow: 'разрешено',
  ask: 'спрашивать',
  deny: 'запрещено',
};
