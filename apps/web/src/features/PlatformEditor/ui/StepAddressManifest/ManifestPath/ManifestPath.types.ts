export interface ManifestPathProps {
  label: string;
  hint: string;
  presetValue: string;
  sample: string;
  value: string | undefined;
  valid: (value: string) => boolean;
  error: string;
  onChange: (value: string | undefined) => void;
}
