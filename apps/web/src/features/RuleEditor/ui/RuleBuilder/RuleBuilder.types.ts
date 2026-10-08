import type { RuleSection } from '../../model/ruleSections.types';

export interface RuleBuilderProps {
  sections: RuleSection[];
  onChange: (sections: RuleSection[]) => void;
}
