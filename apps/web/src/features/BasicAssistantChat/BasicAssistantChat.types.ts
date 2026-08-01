/** Одна реплика в ленте basic-чата: то же, что уходит в историю запроса. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}
