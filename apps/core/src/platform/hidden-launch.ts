/**
 * Кавычки PowerShell для запуска служебных процессов ядра на Windows (09 §own model server,
 * R:PR-04): `detached-launch` строит скрипт WMI `Win32_Process.Create` и отдаёт его
 * `-EncodedCommand` — разбор командной строки powershell.exe не видит ни одной кавычки из argv
 * (P54). Скрытая консоль `Start-Process -WindowStyle Hidden` как способ запуска ушла: серверы
 * идут хранителем (`kept-launch`), он вырывается из задания ядра и не открывает окон.
 */

/**
 * Строка в одинарных кавычках PowerShell. Одинарной кавычкой PowerShell считает не только `'`,
 * но и `‘ ’ ‚ ‛` (U+2018–U+201B): любая из них закрывает строку, и хвост пути исполнялся бы как
 * код (F-17). Поэтому удваивается каждый символ этого класса — удвоенный читается как он сам.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}

export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}
