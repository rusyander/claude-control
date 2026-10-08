import type { ProviderInfo } from '@agentdeck/contracts';

/** Как сейчас решаются правки в этом разговоре — строка над лентой. */
export type EditsState = 'allowed' | 'ask' | 'denied' | 'cli';

/**
 * Переключателя «Разрешить правки» на телефоне нет (он в шапке разговора в
 * панели), но человек должен видеть, что сделает CLI с просьбой о записи. Нет
 * `editsWhenOff` — до CLI переключатель не доходит, решают его настройки.
 */
export function editsState(
  provider: Pick<ProviderInfo, 'editsWhenOff'> | undefined,
  allowEdits: boolean | undefined,
): EditsState {
  const whenOff = provider?.editsWhenOff;
  if (!whenOff) return 'cli';
  if (allowEdits === true) return 'allowed';
  return whenOff === 'ask' ? 'ask' : 'denied';
}
