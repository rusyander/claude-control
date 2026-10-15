import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';

/** Почему кнопку нечем включить: окно называет причину и ведёт на нужную вкладку. */
export type LocalToggleBlock = 'runtime' | 'models' | 'agents';

export type LocalToggleState =
  | { kind: 'unknown' }
  | { kind: 'blocked'; reason: LocalToggleBlock; installed: { tag: string; title: string }[] }
  | {
      kind: 'ready';
      model: string;
      title: string;
      active: boolean;
      /** Включено, а сервер ещё не поднял эту модель: первый ход подождёт загрузки. */
      starting: boolean;
    };

/**
 * Что кнопке делать по снимку раздела. Готово — когда есть сервер моделей, а контур
 * смотрит на скачанную модель: «модель для агентов» выбирается на вкладке «Агенты», и
 * кнопка берёт её вместе с настройками (квантование, окно, кеш) — второго выбора в шапке
 * нет. Порядок причин — порядок шагов человека: сервер, модель, выбор для агентов.
 */
export function localToggleState(data: LocalModelsInfo | undefined): LocalToggleState {
  if (!data) return { kind: 'unknown' };
  const titleOf = (tag: string): string =>
    data.catalog.models.find((model) => model.tag === tag)?.title ?? tag;
  const installed = data.installed.map((item) => ({ tag: item.tag, title: titleOf(item.tag) }));
  if (data.runtime.source === 'none') return { kind: 'blocked', reason: 'runtime', installed };
  if (installed.length === 0) return { kind: 'blocked', reason: 'models', installed };
  const { configured, active, model } = data.connect;
  if (!configured || !model || !installed.some((item) => item.tag === model))
    return { kind: 'blocked', reason: 'agents', installed };
  const server = data.server;
  const starting = active && !(server.running && server.model === model);
  return { kind: 'ready', model, title: titleOf(model), active, starting };
}
