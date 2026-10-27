/** Ключ `env` из automation.json: каталог от корня (`''` — весь проект) и его переменные. */
export interface SuiteEnvEntry {
  path: string;
  vars: Record<string, string>;
}

export interface SuiteEnvRead {
  entries: SuiteEnvEntry[];
  /** Поле есть, но не годится — причина словами; прогон отказывает, а не идёт без рецепта. */
  error?: string;
}
