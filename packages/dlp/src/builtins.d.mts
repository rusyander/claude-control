/**
 * Типы для `builtins.mjs`.
 *
 * Сам файл — `.mjs` без импортов: его текст уезжает в сгенерированный хук
 * промпта, куда типы не пройдут. Объявление нужно тем, кто зовёт образцы из
 * TypeScript: прокси, шлюзу контура, разделу правил.
 */

export type DlpBuiltinId =
  | 'email'
  | 'phone_ru'
  | 'phone_intl'
  | 'inn'
  | 'snils'
  | 'ogrn'
  | 'passport_ru'
  | 'passport_ru_foreign'
  | 'passport_uz'
  | 'card'
  | 'iban'
  | 'crypto_wallet'
  | 'ipv4'
  | 'ipv6'
  | 'mac'
  | 'uuid'
  | 'url'
  | 'credentials_url'
  | 'jwt'
  | 'secret_key';

export interface DlpBuiltinSpec {
  source: string;
  validate?: (value: string) => boolean;
}

export const DLP_BUILTIN_IDS: readonly [DlpBuiltinId, ...DlpBuiltinId[]];
export const DLP_BUILTINS: Record<DlpBuiltinId, DlpBuiltinSpec>;
