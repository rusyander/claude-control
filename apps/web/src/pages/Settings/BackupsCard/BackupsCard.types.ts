export interface BackupEntry {
  name: string;
  target: string;
  createdAt: string;
  sizeBytes: number;
  canRestore: boolean;
  /** Копия зашифрована — восстановление требует парольную фразу. */
  encrypted: boolean;
}
