/**
 * Правила Continue, которые `cn` записанными примет, но не применит никогда.
 *
 * Его разбор (`permissionsYamlLoader.ts`, cn 1.5.47) сверяет уточнение в скобках
 * у `Read`, `Write` и `List` с аргументами `file_path`/`path`, а сами эти
 * инструменты принимают `filepath`/`dirpath`. Совпасть такому правилу не с
 * чем: `exclude: Read(.env)` лежит в файле, а `cn` файл читает (живая проба
 * 09.10.2026). Работают инструмент целиком, `(*)` — у `cn` он значит то же
 * самое — и уточнения `Bash`, `Edit`, `Fetch`.
 */
const DEAD_ARGUMENT = /^(Read|Write|List)\s*\((.*)\)$/;

export function continueUnenforced(rules: readonly string[]): string[] {
  return rules.filter((rule) => {
    const match = DEAD_ARGUMENT.exec(rule.trim());
    if (!match) return false;
    const argument = (match[2] ?? '').trim();
    return argument !== '' && argument !== '*';
  });
}
