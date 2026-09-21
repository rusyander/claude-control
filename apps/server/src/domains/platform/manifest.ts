import {
  platformManifestError,
  type PlatformManifestField,
} from '@agentdeck/contracts/platform-presets';
import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';
import { invalidField } from './errors.ts';

/**
 * Отказ двери сохранения на негодном переопределении пресета (DRV-03).
 *
 * Схема общего PATCH читает переопределения поле за полем и негодное роняет
 * молча — так снимок с опечаткой не запирает весь раздел. Человеку же, который
 * вписал путь в мастере, молчание стоило бы «сохранено» и шлюза, по-прежнему
 * идущего как у пресета. Поэтому здесь отказ с именем поля и правилом, без
 * значения — по той же причине, что у транспорта.
 */
const WHY: Record<PlatformManifestField | 'manifest', [string, ServerMessageCode]> = {
  manifest: ['переопределения — объект полей', 'manifest-invalid-object'],
  clientTools: [
    'инструменты — «native», «native-no-call» или «shim»',
    'manifest-invalid-client-tools',
  ],
  effort: ['усилие — да или нет', 'manifest-invalid-effort'],
  anthropicMessages: [
    'путь ручки относительно версии: строчная латиница, цифры, «/», «_», «-»',
    'manifest-invalid-path',
  ],
  imagesApi: [
    'путь ручки относительно версии: строчная латиница, цифры, «/», «_», «-»',
    'manifest-invalid-path',
  ],
  nonStreamTimeoutSec: ['целое число секунд от 0 до 3600', 'manifest-invalid-seconds'],
  responseCeilingSec: ['целое число секунд от 0 до 3600', 'manifest-invalid-seconds'],
  thinkingField: [
    'поле на проводе: имена через точку, не больше пяти, без служебных имён объекта',
    'manifest-invalid-thinking-field',
  ],
  vendorPrefix: [
    'префикс полей: строчная латиница и цифры, первая — буква, до 32 знаков',
    'manifest-invalid-vendor-prefix',
  ],
};

export function assertManifest(raw: unknown): void {
  const field = platformManifestError(raw);
  if (!field) return;
  const name = field === 'manifest' ? field : `manifest.${field}`;
  const [why, code] = WHY[field];
  throw invalidField(name, why, code, { field: name });
}
