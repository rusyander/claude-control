import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';
import { chatRu } from './ru/chat.ts';
import { checksRu } from './ru/checks.ts';
import { commonRu } from './ru/common.ts';
import { composedRu } from './ru/composed.ts';
import { configRu } from './ru/config.ts';
import { contourRu } from './ru/contour.ts';
import { dlpRu } from './ru/dlp.ts';
import { filesRu } from './ru/files.ts';
import { gatewayRu } from './ru/gateway.ts';
import { gitRu } from './ru/git.ts';
import { integrationsRu } from './ru/integrations.ts';
import { mediaRu } from './ru/media.ts';
import { platformRu } from './ru/platform.ts';
import { sandboxRu } from './ru/sandbox.ts';
import { systemRu } from './ru/system.ts';
import { testsRu } from './ru/tests.ts';
import { transferRu } from './ru/transfer.ts';

/**
 * Тексты сервера по коду (`contracts/server-messages.ts`). Отдельный модуль, а
 * не ветка в `ru.ts`: список кодов растёт вместе с сервером, и `Record` по типу
 * кода ломает сборку, если код заведён, а перевода нет. Разложено по областям
 * (`ru/<область>.ts`) — одним файлом таблица давно переросла бы предел строк.
 *
 * Русский текст повторяет серверный по смыслу — сервер свою строку оставляет
 * запасной для записей без кода.
 */
export const serverMessagesRu: Record<ServerMessageCode, string> = {
  ...chatRu,
  ...checksRu,
  ...commonRu,
  ...composedRu,
  ...configRu,
  ...contourRu,
  ...dlpRu,
  ...filesRu,
  ...gatewayRu,
  ...gitRu,
  ...integrationsRu,
  ...mediaRu,
  ...platformRu,
  ...sandboxRu,
  ...systemRu,
  ...testsRu,
  ...transferRu,
};
