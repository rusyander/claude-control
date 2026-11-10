import { agentRuns } from '@shared/lib/agent-runs';
import { notesMessage } from '../lib/notesMessage';
import type { DiffNotesSend, NotesMode, SendNotesInput } from './sendNotes.types';

/**
 * Куда уходит готовое сообщение (D21). Агент работает: «Сейчас» — слово на
 * ходу (`steer`, ядро доставляет его шагу как `message-to-step`), «В очередь» —
 * в очередь прогона, она уйдёт следующим ходом. Агент свободен — обе кнопки
 * значат одно: обычная отправка, ждать нечего.
 *
 * На ходу «принято» — всегда: `steer` при отказе сам ставит слово в очередь,
 * очередь живёт в сторе и переживает перезагрузку, так что текст не теряется.
 */
async function deliver(port: DiffNotesSend, mode: NotesMode, prompt: string): Promise<boolean> {
  if (!port.isRunning || !port.chatId) return port.dispatch(prompt);
  const message = { ...port.message, prompt, files: [] };
  if (mode === 'now') {
    await agentRuns.steer(port.chatId, message);
    return true;
  }
  agentRuns.enqueue(port.chatId, message);
  return true;
}

/**
 * Отправить лоток заметок одним сообщением. Лоток пустеет только после «да»
 * отправки: отказ (нет сети, сервер не принял) оставляет заметки на месте —
 * писать их заново человеку не придётся.
 */
export async function sendNotes({
  port,
  mode,
  notes,
  labels,
  clear,
}: SendNotesInput): Promise<boolean> {
  if (notes.length === 0) return false;
  const accepted = await deliver(port, mode, notesMessage(notes, labels));
  if (accepted) clear();
  return accepted;
}
