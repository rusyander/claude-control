/** Инструмент проверок не на node и подкоманды, о которых спрашивается ядро (`*` — любая). */
export interface CaptureTool {
  tool: string;
  ask: '*' | readonly string[];
}

/** Что обёртка PATH несёт прокладке одним словом: имя, настоящий argv инструмента, подкоманды. */
export interface CaptureWrapSpec {
  tool: string;
  /** Настоящий исполняемый файл и его префикс (`cmd /c`, node скрипта) — от `resolveExecutable`. */
  real: string[];
  ask: '*' | readonly string[];
}
