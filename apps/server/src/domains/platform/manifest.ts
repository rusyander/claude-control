import {
  platformManifestError,
  type PlatformManifestField,
} from '@agentdeck/contracts/platform-presets';
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
const WHY: Record<PlatformManifestField | 'manifest', string> = {
  manifest: 'переопределения — объект полей',
  clientTools: 'инструменты — «native» или «shim»',
  effort: 'усилие — да или нет',
  anthropicMessages: 'путь ручки относительно версии: строчная латиница, цифры, «/», «_», «-»',
  imagesApi: 'путь ручки относительно версии: строчная латиница, цифры, «/», «_», «-»',
  nonStreamTimeoutSec: 'целое число секунд от 0 до 3600',
  responseCeilingSec: 'целое число секунд от 0 до 3600',
  thinkingField: 'поле на проводе: имена через точку, не больше пяти, без служебных имён объекта',
};

export function assertManifest(raw: unknown): void {
  const field = platformManifestError(raw);
  if (field) throw invalidField(field === 'manifest' ? field : `manifest.${field}`, WHY[field]);
}
