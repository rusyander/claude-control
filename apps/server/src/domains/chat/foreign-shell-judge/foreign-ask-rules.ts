import { getProvider } from '../../../providers/registry.ts';
import {
  readProviderPermissions,
  type ProviderPermissionsValues,
} from '../../provider-permissions/provider-permissions.ts';
import { resolveProviderPermissionsTargetFor } from '../../provider-permissions/target.ts';

/**
 * Правила `ask`/`deny` самого чужого CLI для команд оболочки — в форме
 * `Tool(spec)` судьи (`guardedPatterns` `shouldAutoApprove`), P-05.
 *
 * CLI применяет свои правила ДО вопроса панели, но при включённых правках
 * панель отвечала «да» и на то, что правило `ask` человека отдало человеку.
 * Теперь совпадение с таким правилом — человеку (одиночный чат) или D-n (группа).
 * Источник — файл прав, объявленный провайдером (`permissionsConfig`), тем же
 * чтением, что раздел «Права»; проектных путей прав провайдеры не объявляют —
 * проектный файл не читается (правило 3: только задокументированное).
 * - qwen: `permissions.ask|deny`, синтаксис Claude (`Bash(git push *)`); имена
 *   оболочки `Bash`, `Shell`, `ShellTool`, `run_shell_command`;
 * - opencode: `permission.bash` — уровень `ask`/`deny` целиком или карта шаблонов;
 * - прочие CLI команду в просьбе не несут или правил команд не имеют — пусто.
 * Файл не прочитался — правило на всю оболочку (fail-closed): решает человек.
 */
export function foreignShellRules(providerId: string): string[] {
  const target = resolveProviderPermissionsTargetFor(getProvider(providerId));
  if (!target || (target.format !== 'qwen-json' && target.format !== 'opencode-json')) return [];
  let values: ProviderPermissionsValues;
  try {
    values = readProviderPermissions(target);
  } catch {
    return twins(undefined);
  }
  return shellRulesOf(values);
}

/** Правила из прочитанных значений — без диска, для тестов и сборки. */
export function shellRulesOf(values: ProviderPermissionsValues): string[] {
  if (values.kind === 'qwen') {
    return [...values.ask, ...values.deny].flatMap((rule) => {
      const match = /^\s*(Bash|Shell|ShellTool|run_shell_command)\s*(?:\((.*)\))?\s*$/.exec(rule);
      if (!match) return [];
      const spec = match[2]?.trim();
      return twins(spec || undefined);
    });
  }
  if (values.kind === 'opencode') {
    const bash = values.entries.find((entry) => entry.tool === 'bash');
    if (!bash) return [];
    if (bash.mode === 'level') {
      return bash.level === 'ask' || bash.level === 'deny' ? twins(undefined) : [];
    }
    return (bash.patterns ?? [])
      .filter((rule) => rule.level === 'ask' || rule.level === 'deny')
      .flatMap((rule) => (rule.pattern.trim() === '*' ? twins(undefined) : twins(rule.pattern)));
  }
  return [];
}

/** Одно правило — для обоих чтений судьи: Bash и PowerShell. */
function twins(spec: string | undefined): string[] {
  return spec ? [`Bash(${spec})`, `PowerShell(${spec})`] : ['Bash', 'PowerShell'];
}
