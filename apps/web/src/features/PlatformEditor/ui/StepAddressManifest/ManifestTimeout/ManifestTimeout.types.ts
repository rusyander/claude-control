export interface ManifestTimeoutProps {
  label: string;
  hint: (presetValue: string) => string;
  presetValue: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}
