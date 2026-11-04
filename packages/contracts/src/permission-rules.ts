/**
 * Виды действий, по которым разложены строки разрешений групп разделения
 * (`split-groups.ts`): что группа решает сама, а что отдаёт человеку.
 *
 * Прежде этот же список был правилами автоподтверждения чата — тумблерами в
 * меню «Настройки чата» и настройкой `autoApproveRules`. Их сняли (этап 10,
 * G12): о правах шага судит ядро (06 §Human points), и тумблер, которого ход
 * через ядро не читает, обещал бы то, чего нет. Остались только имена видов.
 */
export const PERMISSION_RULE_IDS = [
  'externalWrite',
  'gitWrite',
  'filesDelete',
  'gitHistory',
  'database',
  'infrastructure',
  'packagePublish',
  'externalDestroy',
  'networkExec',
  'editInMainCopy',
] as const;

export type PermissionRuleId = (typeof PERMISSION_RULE_IDS)[number];
