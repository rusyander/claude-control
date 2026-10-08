export interface ProbeSectionProps {
  target: string;
  targetName: string;
  /**
   * Уровень пробы. Проектом она называет СВОЙ временный рабочий каталог, а не
   * проект человека: чужой репозиторий проба не трогает ни при каком уровне.
   */
  scope: 'global' | 'project';
}
