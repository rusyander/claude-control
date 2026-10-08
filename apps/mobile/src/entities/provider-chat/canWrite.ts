/**
 * Писать в разговор можно только активным CLI панели: все маршруты отправки
 * ходят от него. Чат другого CLI (открыт по уведомлению после переключения)
 * читается, но молчит — иначе вопрос ушёл бы не тому CLI.
 */
export function canWrite(activeProviderId: string | undefined, providerId: string): boolean {
  return Boolean(activeProviderId) && activeProviderId === providerId;
}
