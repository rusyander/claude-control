/**
 * Имя модели у маршрутизатора llama-server. Сборка 11583 (замер 02.11) переименовывает секцию
 * пресета: метку размера после двоеточия пишет заглавными (`qwen3.8:27b` → `qwen3.8:27B`,
 * `gemma-4:e4b` → `gemma-4:E4B`), а дальше ищет имя ТОЧНО — `/models/load`, `?model=` и запрос
 * чата с именем человека получают 404 / 400 «model not found». Ядро называет модель так, как её
 * перечислил сам маршрутизатор (`GET /models`).
 */

/**
 * Обратный путь: клиент просил `asked`, маршрутизатор отвечает `routerId` — наружу уходит имя
 * клиента. Траты и строки состояния по модели, каталог панели считают модель по имени запроса:
 * `qwen3.8:27B` рядом с `qwen3.8:27b` раскололо бы одну модель на две.
 */
export interface NameBack {
  routerId: string;
  asked: string;
}

/** Имя модели в ответе (`model` верхнего уровня, `message.model` у Anthropic) — имя клиента. */
export function restoreModelName(value: unknown, back: NameBack): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  let changed = false;
  if (record.model === back.routerId) {
    record.model = back.asked;
    changed = true;
  }
  const message = record.message;
  if (typeof message === 'object' && message !== null) {
    const inner = message as Record<string, unknown>;
    if (inner.model === back.routerId) {
      inner.model = back.asked;
      changed = true;
    }
  }
  return changed;
}

/**
 * Строки потока SSE (целые, с переводами строк): кадр `data: {…}` с именем маршрутизатора
 * пересобирается с именем клиента; прочие строки (`event:`, `[DONE]`, пустые) — байт в байт.
 */
export function restoreSseLines(text: string, back: NameBack): string {
  if (!text.includes(back.routerId)) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data:') || !line.includes(back.routerId)) return line;
      const cr = line.endsWith('\r') ? '\r' : '';
      const payload = line.slice(5, cr ? -1 : undefined);
      try {
        const frame: unknown = JSON.parse(payload);
        if (!restoreModelName(frame, back)) return line;
        return `data: ${JSON.stringify(frame)}${cr}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

/** Имя из списка маршрутизатора: точное, иначе единственное совпадающее без учёта регистра. */
export function matchRouterId(ids: readonly string[], model: string): string | undefined {
  if (ids.includes(model)) return model;
  const lower = model.toLowerCase();
  const same = ids.filter((id) => id.toLowerCase() === lower);
  return same.length === 1 ? same[0] : undefined;
}
