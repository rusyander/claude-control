/** Режим панели: готовые заготовки событий или свой ввод JSON. */
export type ProbeMode = 'fixtures' | 'custom';

export interface HookProbePanelProps {
  sandboxId: string;
  hookId?: string;
  scriptName?: string;
}
