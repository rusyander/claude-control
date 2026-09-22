' Запуск сторожа без окна — для задач планировщика.
'
' node.exe из задачи создаёт консольное окно, и оно висит всё время работы
' сторожа: сворачивать его вручную после каждого входа в систему никто не
' станет. WScript.Shell.Run со стилем 0 не создаёт окна вовсе.
'
' Использование: wscript.exe keepalive-hidden.vbs [<node.exe>] [<keepalive.mjs>]
' Без аргументов: node из PATH и keepalive.mjs рядом с этим файлом.

Option Explicit

Dim shell, fso, here, nodeExe, script, cmd

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)

' Путь к node зашивается в задачу при установке. Сменился менеджер версий
' (nvm снят, node переставлен) — файла больше нет, и WSH раз в пять минут
' показывал окно «Не удается найти указанный файл». Мёртвый путь — не повод
' падать: берём node из PATH, как без аргументов.
nodeExe = "node"
If WScript.Arguments.Count >= 1 Then
    If fso.FileExists(WScript.Arguments(0)) Then nodeExe = WScript.Arguments(0)
End If

If WScript.Arguments.Count >= 2 Then
    script = WScript.Arguments(1)
Else
    script = fso.BuildPath(here, "keepalive.mjs")
End If

cmd = """" & nodeExe & """ """ & script & """"

' Сторожа нет вовсе (node не в PATH, файл сторожа удалён) — молча выходим:
' модальное окно WSH каждые пять минут хуже пропущенного подхвата, а причина
' видна в `pnpm keepalive:status`.
On Error Resume Next
' 0 = скрытое окно, False = не ждать завершения.
shell.Run cmd, 0, False
