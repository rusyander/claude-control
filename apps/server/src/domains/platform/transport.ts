import type { Platform } from '@agentdeck/contracts';
import {
  defaultPlatformTransport,
  platformRequestHeaders,
  platformRequestUrl,
  platformTransportErrors,
  type PlatformTransport,
  type PlatformTransportErrorCode,
} from '@agentdeck/contracts/platform-transport';
import { driverOf } from './drivers/index.ts';
import { invalidField } from './errors.ts';

/**
 * Единственная сборка запроса к контуру: адрес и заголовки (DRV-04/05).
 *
 * Проба, шлюз, эмбеддинги, агенты и картинки ходят через неё все. Раньше каждый
 * собирал своё: `Bearer` стоял литералом в трёх местах, и настройка, починенная
 * в одном, продолжала отправлять `Authorization` из другого — Azure отвечал 401
 * на картинке при зелёной пробе.
 */

type Addressed = Pick<Platform, 'baseUrl' | 'driver' | 'manifest'> & {
  transport?: PlatformTransport;
};

function transportOf(platform: Addressed): PlatformTransport {
  // Контур, сохранённый до этого поля и прочитанный мимо схемы, его не несёт.
  return platform.transport ?? defaultPlatformTransport();
}

/** Адрес запроса к контуру. `undefined` — базовый адрес не http(s). */
export function contourUrl(platform: Addressed, path: string): string | undefined {
  return platformRequestUrl(platform.baseUrl, transportOf(platform), path);
}

/** Заголовки запроса: лишние из настройки, `accept` и ключ в заголовке драйвера или своём. */
export function contourHeaders(
  platform: Addressed,
  token: string | undefined,
): Record<string, string> {
  return platformRequestHeaders(transportOf(platform), driverOf(platform).auth, token);
}

const WHY: Record<PlatformTransportErrorCode, string> = {
  token: 'не имя заголовка HTTP',
  line: 'не вида «Имя: значение» (номер строки или параметра)',
  secret: 'под этим именем едет ключ, а ключ хранится зашифрованным и идёт своим полем',
  reserved: 'этот заголовок панель ставит сама',
};

/**
 * Отказ на первой ошибке транспорта — при сохранении контура, до записи. Имя
 * называется, значение нет: в строке заголовка им как раз мог оказаться ключ.
 */
export function assertTransport(platform: Addressed): void {
  const driver = driverOf(platform);
  const [first] = platformTransportErrors(transportOf(platform), driver.auth.header);
  if (first)
    throw invalidField(`transport.${first.field}`, `«${first.subject}» — ${WHY[first.code]}`);
}
