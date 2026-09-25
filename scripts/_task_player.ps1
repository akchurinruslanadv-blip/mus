$env:MUSIK_ROOT       = 'C:\Users\Admin\Desktop\musik-project'
$env:MUSIK_LIBRARY    = 'C:\Users\Admin\Desktop\musik-project\dynamic'
$env:MUSIK_DB_PATH    = 'C:\Users\Admin\Desktop\musik-project\data\db\musik.db'
$env:MUSIK_PLAYER_ADDR = '127.0.0.1:8786'
$env:MUSIK_AUTH_DISABLED = '1'
$env:MUSIK_WORKER_AUTOSTART = '0'
$env:PATH             = 'C:\Users\Admin\Desktop\musik-project\bin;' + $env:PATH
& 'C:\Users\Admin\Desktop\musik-project\bin\musik-player.exe'
