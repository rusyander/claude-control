/**
 * Как агенту писать кейс — одна строка на все места, где агенту это говорят:
 * дописка к промпту чата (`e2e-chat`), пропуск конца хода (`turn-gate`).
 * Кейс «прогнать тесты — все проходят» владелец назвал хламом (15.10): его
 * нечем опровергнуть, и человек, открыв его, не узнает, что проверено.
 * Текст английский — его читает модель; линтер ловит то же правилом `vague-case`.
 */
export const CASE_STANDARD =
  'Write every case for a human reader: title = the behaviour checked; one step per behaviour; ' +
  'each step\'s "expected" = what is actually seen (screen text, response status or field, file ' +
  'content, report line), never "all pass", "works" or "no errors" (lint rule vague-case and the ' +
  'turn end flag those); a case backed by a test names that test in the expected (file › test); ' +
  'steps are objects {"action","expected"}.';
