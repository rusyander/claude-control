import type { Step, StubModel, StubModelOptions } from '../index.d.mts';

export declare const PANEL_MARK: '<!-- agentdeck:platform -->';
export declare const BRIDGE_SERVER: 'panel-bridge';

/** Вызов моста в истории запроса и его результат. */
export interface PanelAgentCall {
  name: string;
  args: unknown;
  text: string;
  isError: boolean;
}

export interface PanelAgentRequest {
  /** Просьба платформы целиком; `undefined` — служебный запрос CLI, не ход агента. */
  prompt: string | undefined;
  /** Текущая просьба человека (`Human (current request): …` или вся просьба). */
  current: string | undefined;
  calls: PanelAgentCall[];
  searches: number;
  offered: string[];
}

export interface PanelAgentProgramInput {
  current: string;
  prompt: string | undefined;
  /** `say` — реплика модели перед вызовом, тем же ответом (текст + вызов). */
  tool: (
    name: string,
    args?: unknown,
    options?: { say?: string },
  ) => Promise<{ text: string; isError: boolean }>;
}

/** Строка — ответ текстом; шаг — как есть (ошибка, пустой ответ). */
export type PanelAgentProgram = (input: PanelAgentProgramInput) => Promise<string | Step>;

export declare function actionOf(name: string): string | undefined;
export declare function parsePanelAgentRequest(
  body: unknown,
  offered?: string[],
): PanelAgentRequest;
export declare function decidePanelAgentStep(
  program: PanelAgentProgram,
  parsed: PanelAgentRequest,
): Promise<Step>;

export interface PanelAgentModel extends StubModel {
  turns: PanelAgentRequest[];
}

export declare function startPanelAgentModel(
  program: PanelAgentProgram,
  options?: Omit<StubModelOptions, 'script'>,
): Promise<PanelAgentModel>;
