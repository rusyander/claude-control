import { currentConnection } from './connection';

export function authHeaders(): Record<string, string> {
  const { token } = currentConnection();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
