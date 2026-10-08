import type { McpFormModalProps, SecretSlot } from '../ui/McpFormModal/McpFormModal.types';

/**
 * Пустые значения env и заголовков сохранённого сервера — то, что агент панели
 * оставил вводить человеку. Список фиксируется при открытии: иначе поле
 * исчезало бы с первой набранной буквы.
 */
export function emptySecretSlots(server: McpFormModalProps['server']): SecretSlot[] {
  if (!server) return [];
  const empty = (field: SecretSlot['field'], record: Record<string, string> = {}): SecretSlot[] =>
    Object.entries(record)
      .filter(([, value]) => value.trim() === '')
      .map(([key]) => ({ field, key }));
  return [
    ...empty('env', server.env),
    ...(server.transport === 'stdio' ? [] : empty('headers', server.headers)),
  ];
}
