import type { InboxQuestion } from '@agentdeck/contracts/chat-inbox';
// Прямо из модулей стора, а не из `runs/index`: тот тянет транспорт (`expo/fetch`,
// `react-native`), а разбор сводки проверяется тестами без них.

/** Тело вызова пишет модель — берём только то, что похоже на вопрос (как сервер). */
export function parseQuestions(raw: string): InboxQuestion[] {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return [];
  const out: InboxQuestion[] = [];
  for (const item of list as { [key: string]: unknown }[]) {
    if (!item || typeof item.question !== 'string' || !item.question.trim()) continue;
    const options = Array.isArray(item.options)
      ? (item.options as { [key: string]: unknown }[])
          .filter((option) => option && typeof option.label === 'string' && option.label.trim())
          .map((option) => ({
            label: String(option.label),
            ...(typeof option.description === 'string' && option.description
              ? { description: option.description }
              : {}),
          }))
      : [];
    out.push({
      question: item.question,
      ...(typeof item.header === 'string' && item.header ? { header: item.header } : {}),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return out;
}
