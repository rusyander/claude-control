import type { ProviderHooksInfo } from '@claude-control/contracts';

/** Одна строка формы «правило на событие». */
export interface RuleRow {
  id: number;
  event: string;
  matcher: string;
  command: string;
  timeout: string;
}

export interface ProviderHookRulesEditorProps {
  data: ProviderHooksInfo;
  projectId?: string;
}
