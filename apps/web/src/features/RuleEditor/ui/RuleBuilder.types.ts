import type { RuleSection } from '../model/ruleSections';

export interface RuleBuilderProps {
  sections: RuleSection[];
  onChange: (sections: RuleSection[]) => void;
}
