/** Режим панели: готовые заготовки событий или свой ввод JSON. */
export type ProbeMode = 'fixtures' | 'custom';

export interface HookProbePanelProps {
  sandboxId: string;
  hookId?: string;
  scriptName?: string;
  /**
   * Песочница собрана. До этого прогонять нечего: сервер откажет «ещё не
   * собрана», а человек, нажавший кнопку в первую секунду, увидит отказ вместо
   * результата. Поэтому кнопки прогона ждут сборку.
   */
  isReady: boolean;
}
