import type { ComposePort } from '@entities/Compose';

/**
 * Адрес порта в браузере. «Все интерфейсы» (`0.0.0.0`, пусто) открываем как
 * localhost — по `0.0.0.0` браузер на Windows не ходит. Порт UDP ссылкой не
 * бывает: браузер в него не постучится.
 */
export function portUrl(port: ComposePort): string | undefined {
  if (port.protocol !== 'tcp') return undefined;
  const host = !port.host || port.host === '0.0.0.0' ? 'localhost' : port.host;
  const bracketed = host.includes(':') ? `[${host}]` : host;
  return `http://${bracketed}:${port.published}`;
}
