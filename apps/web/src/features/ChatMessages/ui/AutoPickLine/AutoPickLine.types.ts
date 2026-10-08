export interface AutoPickLineProps {
  /** Что автономия чата выбрала за человека — по вопросу на строку. */
  picks: readonly { question: string; label: string }[];
}
