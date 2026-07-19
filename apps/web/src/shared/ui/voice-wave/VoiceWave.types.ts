export interface VoiceWaveProps {
  /** Скользящее окно громкости: новый сэмпл справа. */
  levels: number[];
  /** Идёт ли запись: в тишине показывается «дышащая» волна. */
  active: boolean;
  className?: string;
}
