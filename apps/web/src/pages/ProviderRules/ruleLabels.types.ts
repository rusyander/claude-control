/** Что у формата каталога правил отличается в форме (MAP 24). */
export interface RuleFormatTraits {
  /** Расширение файла правила: `.mdc` у Cursor, `.md` у Continue и Qwen. */
  extension: string;
  /** Есть ли у формата `alwaysApply`. У Qwen «всегда» = правило без шаблонов. */
  alwaysApply: boolean;
  /** Ключ подписи с учётом формата. */
  text: (name: string) => string;
}
