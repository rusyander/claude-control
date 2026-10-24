/**
 * Когда разговор в последний раз видел человек: поток клиента (вкладка, телефон)
 * открылся или закрылся. Брокеру прав мало мгновенного «открыт ли поток сейчас»:
 * при перезапуске панели вкладка переподключается, а CLI шлёт запрос заново —
 * в эту секунду потока нет, и автономный чат отложил бы вызов в D-n, хотя
 * человек смотрит (check-chat-survives-restart, 23.10). Поэтому «смотрит» —
 * поток открыт сейчас ИЛИ был в окне срока, а до первого потока после старта
 * панели — пока панель моложе окна.
 */

/** Сколько записей держать: старые забываются, чтобы карта не росла без конца. */
const KEEP_MAX = 500;

export class ViewerPresence {
  private readonly seenAt = new Map<string, number>();
  private readonly bootedAt: number;

  /** Поле присваивается вручную: strip-only TypeScript без parameter properties. */
  constructor(bootedAt: number = Date.now()) {
    this.bootedAt = bootedAt;
  }

  /** Поток человека открылся или закрылся у разговора с этими ключами. */
  mark(keys: readonly string[], now: number = Date.now()): void {
    for (const key of keys) {
      this.seenAt.delete(key);
      this.seenAt.set(key, now);
    }
    // Map хранит порядок вставки: первые — самые давние.
    while (this.seenAt.size > KEEP_MAX) {
      const oldest = this.seenAt.keys().next().value;
      if (oldest === undefined) break;
      this.seenAt.delete(oldest);
    }
  }

  /**
   * Видел ли человек разговор за последние `windowMs`. Записи нет — судит
   * возраст панели: только что поднятая ещё не успела дождаться вкладок.
   */
  recentlySeen(keys: readonly string[], windowMs: number, now: number = Date.now()): boolean {
    if (windowMs <= 0) return false;
    const seen = keys.map((key) => this.seenAt.get(key)).filter((at) => at !== undefined);
    if (seen.length > 0) return now - Math.max(...seen) < windowMs;
    return now - this.bootedAt < windowMs;
  }
}
