import type { DlpRule, DlpBuiltinInfo } from '@agentdeck/contracts';
import type { BuiltinNames } from '@entities/Dlp';

export interface Props {
  rule: DlpRule;
  /** Тексты встроенных образцов с сервера — из них правило становится своим выражением. */
  builtins?: readonly DlpBuiltinInfo[];
  /** Названия и метки образцов по умолчанию — из словаря интерфейса. */
  builtinNames: BuiltinNames;
  builtinLabels: BuiltinNames;
  onChange: (next: DlpRule) => void;
  onRemove: (id: string) => void;
}
