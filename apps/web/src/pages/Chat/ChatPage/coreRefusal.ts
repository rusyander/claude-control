import { REFUSAL_CODES, type RefusalCode } from '@agentdeck/contracts/core/routes';
import type { ServerMessageNestedParams } from '@agentdeck/contracts/server-messages';

/**
 * Отказ ядра запуску хода чата (W3-17a, поднят из прежнего экрана `/core/chat`): CLI без хука ядра
 * (`no_core_hook`), переходник-заготовка, иной код суда совместимости, отказ переноса слоя панели
 * в сеанс. Сервер присылает его кодом ошибки хода (`refusal-text.ts`); здесь код становится строкой
 * отказа в ленте `/chat`. Такой чат на прежний исполнитель не откатывается и не пишется дальше:
 * композера нет, строка называет причину.
 *
 * Контур без шлюза и маршрут без модели — не отказ запуска, а обычная ошибка хода: человек
 * выбирает модель или чинит контур и пишет снова, композер остаётся.
 */

/** Коды со своим объяснением; прочие коды суда — общая строка с кодом. */
const EXPLAINED = ['no_core_hook', 'adapter_not_built'] as const;
type ExplainedRefusal = (typeof EXPLAINED)[number];

/**
 * Модель вне списка маршрута человек чинит выбором модели в этом же чате — это ошибка хода с
 * композером, а не отказ CLI (контурный случай и так идёт своим текстом `core-chat-contour-model`).
 */
const FIXABLE_IN_CHAT: readonly RefusalCode[] = ['model_absent'];

/** Код ошибки хода сервера → ключ строки отказа (тексты `coreChat.launchRefused.*`). */
const CARRY_KEY = {
  'core-chat-kit-hooks': 'kitHooks',
  'core-chat-kit-mcp': 'kitMcp',
  'core-chat-kit-missing': 'kitMissing',
  'core-chat-layer-untrusted': 'layerUntrusted',
  'core-chat-layer-mode': 'layerMode',
  'core-chat-layer-sources': 'layerSources',
  'core-chat-layer-build': 'layerBuild',
  'core-chat-layer-fit': 'layerFit',
  'core-chat-carry-unsupported': 'carryUnsupported',
} as const;
type CarryKey = (typeof CARRY_KEY)[keyof typeof CARRY_KEY];

export type CoreRefusalKey = ExplainedRefusal | 'other' | CarryKey;

export interface CoreRefusal {
  key: CoreRefusalKey;
  params: Record<string, string>;
}

const isRefusalCode = (v: unknown): v is RefusalCode =>
  typeof v === 'string' && (REFUSAL_CODES as readonly string[]).includes(v);

/** Подстановки строкой: вложенное сообщение строке отказа не нужно. */
function flatParams(params: ServerMessageNestedParams | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') out[name] = String(value);
  }
  return out;
}

/** Ошибка хода → строка отказа; иная ошибка (или её нет) — `null`, она идёт карточкой ленты. */
export function coreRefusalOf(stream: {
  error?: string | undefined;
  errorCode?: string | undefined;
  errorParams?: ServerMessageNestedParams | undefined;
}): CoreRefusal | null {
  if (!stream.error || !stream.errorCode) return null;
  const params = flatParams(stream.errorParams);
  if (stream.errorCode === 'core-chat-refused') {
    const code = params.code;
    if (!isRefusalCode(code) || FIXABLE_IN_CHAT.includes(code)) return null;
    const key = (EXPLAINED as readonly string[]).includes(code)
      ? (code as ExplainedRefusal)
      : 'other';
    return { key, params: { code, setting: params.setting ?? '' } };
  }
  const carry = (CARRY_KEY as Record<string, CarryKey | undefined>)[stream.errorCode];
  return carry ? { key: carry, params } : null;
}
