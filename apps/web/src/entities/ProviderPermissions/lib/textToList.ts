export function textToList(text: string): string[] {
  const list: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim();
    if (name && !list.includes(name)) list.push(name);
  }
  return list;
}
