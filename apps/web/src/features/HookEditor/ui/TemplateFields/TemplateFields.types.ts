export interface TemplateFieldsProps {
  template: string;
  onTemplateChange: (template: string) => void;
  message: string;
  onMessageChange: (message: string) => void;
  guardPatterns: string;
  onGuardPatternsChange: (patterns: string) => void;
  command: string;
  onCommandChange: (command: string) => void;
}
