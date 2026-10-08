export function newRuleId(): string {
  // `crypto.randomUUID` требует защищённого контекста, а панель открывают и по
  // http на 127.0.0.1 — поэтому время плюс случайный хвост.
  return `dlp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
