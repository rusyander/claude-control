import { kitCarryRefusalOf, type KitCarryRefusal } from '@agentdeck/contracts/core/session-carry';
import { serverText } from '../../../lib/server-texts/server-texts.ts';

/**
 * Отказ ядра в ходе чата — текстом панели по коду (s10 G7), а не английской строкой ядра. Ядро
 * пишет причину словами журнала («contour c1 is required and its gateway is down», «route … needs a
 * concrete model»); человек в чате видит понятную фразу на языке интерфейса: код едет рядом
 * (`run-errors.ts` восстанавливает его по русскому шаблону), клиент переводит своим словарём.
 *
 * Отказы, с которыми человек может что-то сделать сам, названы по смыслу (контур, модель, набор
 * панели: хуки шага, MCP в каталоге набора, каталог не найден; локальный слой: папке нет доверия,
 * слой сужен, сборка не годится или не влезла; CLI не несёт поле переноса); отказ оценки — с
 * кодом и причиной ядра в самом тексте (задачи нет, журнал не откроешь); любой другой отказ ядра
 * (команда, шаг без сеанса) — общим текстом с кодом ядра, причина словами ядра остаётся в журнале
 * задачи. Не отказ (ядро не запущено, сеанс оборвался, стоп) —
 * `undefined`: такой текст идёт как был.
 */

const CONTOUR_DOWN = /contour (\S+) is required and its gateway is down/;
const MODEL_NEEDED = /route (\S+) needs a concrete model/;
// Контур не открыл ключу модель (`compat-gate.ts` `compatRefusalReason`, s10 G7): маршрут контура —
// `gateway:<контур>` (`routes/gateway/gateway.ts`); иной маршрут без модели — общий текст с кодом.
const CONTOUR_MODEL =
  /model_absent: model (\S+) is not in the model list of route gateway:([\w.-]+)/;
const CARRY_CODE = {
  hooks: 'core-chat-kit-hooks',
  mcp: 'core-chat-kit-mcp',
  missing: 'core-chat-kit-missing',
  layerUntrusted: 'core-chat-layer-untrusted',
  layerMode: 'core-chat-layer-mode',
  layerSources: 'core-chat-layer-sources',
  layerBuild: 'core-chat-layer-build',
  layerFit: 'core-chat-layer-fit',
  unsupported: 'core-chat-carry-unsupported',
} as const satisfies Record<KitCarryRefusal['kind'], string>;
const REFUSED =
  /^core chat: (?:[\w-]+ refused \(([^)]+)\)|the core refused the chat \(([^)]+)\)|the chat step ended without a session \(([^)]+)\))/;
const COMPAT_CODE = /compat refused: ([a-z][a-z_]*)/;
const ESTIMATE_REFUSED = /^core chat: the core refused the chat \(([^)]+)\): ([\s\S]*\S[\s\S]*)$/;
export function coreRefusalText(message: string): string | undefined {
  const down = CONTOUR_DOWN.exec(message);
  if (down) return serverText('core-chat-contour-down', { contour: down[1] as string });
  const absent = CONTOUR_MODEL.exec(message);
  if (absent) {
    return serverText('core-chat-contour-model', {
      model: absent[1] as string,
      contour: absent[2] as string,
    });
  }
  const model = MODEL_NEEDED.exec(message);
  if (model) return serverText('core-chat-model-needed', { route: model[1] as string });
  // Отказ переноса слоя панели в сеанс (G13; локальный слой — G14 p7): что не так и где —
  // человеку есть что поправить. Ни одна строка `session-carry-*` ядра не уходит в чат сырой.
  const kit = kitCarryRefusalOf(message);
  if (kit) {
    const { kind, ...params } = kit;
    return serverText(CARRY_CODE[kind], params);
  }
  // Отказ на оценке (s10 G12 p7): задачи нет или она сразу кончилась, журнала у человека перед
  // глазами нет — причина ядра («…: base default branch not found») едет в самом тексте.
  const estimate = ESTIMATE_REFUSED.exec(message);
  if (estimate) {
    return serverText('core-chat-estimate-refused', {
      code: estimate[1] as string,
      reason: estimate[2] as string,
    });
  }
  const refused = REFUSED.exec(message);
  if (!refused) return undefined;
  // Суд совместимости назвал код (`compat refused: no_core_hook`, W3-17a): экран чата объясняет
  // его своей строкой — код суда, а не исход шага (`failed`), который ничего не говорит.
  const compat = COMPAT_CODE.exec(message)?.[1];
  return serverText('core-chat-refused', {
    code: (compat ?? refused[1] ?? refused[2] ?? refused[3]) as string,
  });
}
