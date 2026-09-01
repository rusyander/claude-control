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

If WScript.Arguments.Count >= 1 Then
    nodeExe = WScript.Arguments(0)
Else
    nodeExe = "node"
End If

If WScript.Arguments.Count >= 2 Then
    script = WScript.Arguments(1)
Else
    script = fso.BuildPath(here, "keepalive.mjs")
End If

cmd = """" & nodeExe & """ """ & script & """"

' 0 = скрытое окно, False = не ждать завершения.
shell.Run cmd, 0, False
