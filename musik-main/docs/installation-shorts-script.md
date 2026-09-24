# Shorts: установка Musik на Linux-сервер

Цель ролика: за 90–95 секунд кратко представить проект и показать установку на любой Linux-сервер — VPS, выделенный сервер, домашнюю машину или VM.

Ссылка в описании:

`https://github.com/torwin-job/musik`

## Перед записью

- Сервер или виртуальная машина с Ubuntu 24.04 либо Debian 12.
- Рекомендуется: 4 CPU, 8 ГБ RAM, диск от 32 ГБ плюс место под музыку.
- Сервер доступен по SSH, известны пользователь и IP-адрес.
- На компьютере подготовлен один демонстрационный MP3/FLAC-файл.
- Первый Docker build и загрузку ML-модели лучше выполнить заранее или ускорить на монтаже.

Данные для нашей записи: проект запущен локально, музыка читается из `/home/void/Music/Music/`, интерфейс открыт на `http://localhost:8787`.

## Режим для стрима

- Приложение, база и ML-модель работают прямо на основном ПК в Docker.
- SSH и тестовый сервер для стрима не используются.
- В браузере показываем `http://localhost:8787`.
- Демонстрационный пароль: `musik-demo`.
- Музыка берётся из локальной папки `/home/void/Music/Music/`.
- Тяжёлая первоначальная сборка уже выполнена.

Перед стримом достаточно выполнить:

```bash
make dev-up
make dev-ps
```

После запуска открыть `http://localhost:8787`.

> `musik-demo` — пароль только для локальной разработки. Для публичного сервера нужен длинный случайный пароль и HTTPS.

## Вся озвучка

### 0:00–0:10 — Что это за проект

«Musik — это аналог VK и Яндекс музыке музыкальный сервер, с умной системой рекомендаций которая подставиваеться под твой вкс. Полное видео о том, как он работает, уже есть на канале, а это короткий гайд по установке».

### 0:10–0:17 — Что потребуется

«Для начала вам потребуется выделенный сервер. Это может быть обычный VPS, домашний сервер или виртуальная машина с Ubuntu либо Debian. Подключаемся к нему по SSH».

### 0:17–0:27 — Docker и инструменты

Ставим Git, Make и Docker с Compose.

### 0:27–0:35 — GitHub и клонирование

«Клонируем открытый репозиторий Musik и переходим в папку проекта».

### 0:35–0:50 — Настройка

«Копируем шаблон настроек, создаём папку библиотеки, задаём пароль и генерируем API-токен с секретом сессии. Пароль понадобится для входа».

### 0:50–1:00 — Запуск

«Одной командой собираем и запускаем Go-плеер и Python-воркер. Снаружи открыт только веб-порт 8787».

### 1:00–1:11 — Загрузка музыки

«В Musik нет HTTP-загрузки: аудиофайлы копируются прямо в библиотеку сервера. Поддерживаются MP3, FLAC, M4A, WAV, OGG и Opus».

### 1:11–1:23 — Сканирование

«Запускаем полное сканирование. Воркер найдёт треки, рассчитает эмбеддинги, кластеры и персональные миксы. Первый анализ на CPU может занять несколько минут».

### 1:23–1:35 — Результат

«Через SSH-туннель открываем localhost на порту 8787, вводим пароль — и личный музыкальный сервер готов. После добавления новых песен достаточно снова выполнить `make rescan`».


## План кадров и команды

### 0:00–0:10 — Что это за проект

**Кадр:** готовый интерфейс Musik, запуск трека.

**Текст на экране:**
`Musik · быстрый гайд по установке`

### 0:10–0:17 — Подключение к серверу

**Кадр:** панель VPS/виртуальной машины, затем терминал.

```bash
ssh USER@SERVER_IP
```

Для нашей записи:

```bash
ssh -i ~/.ssh/id_ed25519_proxmox_test root@192.168.31.203
```

### 0:17–0:27 — Docker и инструменты

**Кадр:** команды в терминале; длинный вывод ускорить.

```bash
apt update
apt install -y git make curl ca-certificates openssl
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sh /tmp/get-docker.sh
docker compose version
```

### 0:27–0:35 — GitHub и клонирование

**Кадр:** страница GitHub, затем терминал.

```bash
git clone https://github.com/torwin-job/musik.git
cd musik
```

### 0:35–0:50 — Настройка

**Кадр:** вставка одного блока команд.

```bash
cp .env.example .env
mkdir -p /srv/music

PASSWORD="musik-demo"
API_TOKEN="$(openssl rand -hex 32)"
SESSION_SECRET="$(openssl rand -hex 32)"

sed -i "s|^MUSIK_PASSWORD=.*|MUSIK_PASSWORD=$PASSWORD|" .env
sed -i "s|^MUSIK_API_TOKEN=.*|MUSIK_API_TOKEN=$API_TOKEN|" .env
sed -i "s|^MUSIK_SESSION_SECRET=.*|MUSIK_SESSION_SECRET=$SESSION_SECRET|" .env
sed -i "s|^MUSIK_LIBRARY=.*|MUSIK_LIBRARY=/srv/music|" .env

printf 'Пароль для входа: %s\n' "$PASSWORD"
```

**Важно для монтажа:** не показывать реальные секреты крупным планом; демонстрационный пароль после съёмки заменить.

### 0:50–1:00 — Запуск

**Кадр:** запуск Compose; процесс сборки ускорить или вырезать.

```bash
make up
docker compose ps
```

### 1:00–1:11 — Загрузка музыки

**Кадр:** новый локальный терминал на компьютере, не SSH-сессия.

```bash
scp -r "/путь/к/музыке/." USER@SERVER_IP:/srv/music/
```

Для нашей записи:

```bash
scp -i ~/.ssh/id_ed25519_proxmox_test -r \
  "/home/void/Music/Music/." root@192.168.31.203:/srv/music/
```

### 1:11–1:23 — Сканирование

**Кадр:** вернуться в SSH-сессию, папка `musik`.

```bash
cd ~/musik
make rescan
docker compose logs -f worker
```

Для выхода из логов нажать `Ctrl+C` — сервис продолжит работать.

### 1:23–1:35 — Результат

**Кадр:** браузер `http://localhost:8787`, ввод пароля `musik-demo`, каталог и воспроизведение.

**Финальная плашка:**
`github.com/torwin-job/musik`

## Полная последовательность команд

### 1. На сервере

```bash
apt update
apt install -y git make curl ca-certificates openssl
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sh /tmp/get-docker.sh

git clone https://github.com/torwin-job/musik.git
cd musik

cp .env.example .env
mkdir -p /srv/music

PASSWORD="musik-demo"
API_TOKEN="$(openssl rand -hex 32)"
SESSION_SECRET="$(openssl rand -hex 32)"

sed -i "s|^MUSIK_PASSWORD=.*|MUSIK_PASSWORD=$PASSWORD|" .env
sed -i "s|^MUSIK_API_TOKEN=.*|MUSIK_API_TOKEN=$API_TOKEN|" .env
sed -i "s|^MUSIK_SESSION_SECRET=.*|MUSIK_SESSION_SECRET=$SESSION_SECRET|" .env
sed -i "s|^MUSIK_LIBRARY=.*|MUSIK_LIBRARY=/srv/music|" .env

printf 'Пароль для входа: %s\n' "$PASSWORD"
make up
docker compose ps
```

### 2. На компьютере: открыть SSH-туннель

```bash
ssh -L 8787:127.0.0.1:8787 USER@SERVER_IP
```

Не закрывать эту SSH-сессию до конца стрима.

### 3. На компьютере с музыкой

```bash
scp -r "/путь/к/музыке/." USER@SERVER_IP:/srv/music/
```

### 4. Снова на сервере

```bash
cd ~/musik
make rescan
docker compose logs -f worker
```

После завершения открыть:

`http://localhost:8787`

## Команды после установки

```bash
cd ~/musik
docker compose start      # запустить уже созданные контейнеры
make up                   # первая сборка или пересборка после обновления
make rescan               # найти новые песни и перестроить рекомендации
make mixes                # отдельно обновить миксы
make smoke                # проверить API и авторизацию
docker compose ps         # состояние контейнеров
docker compose logs -f    # все логи
docker compose stop       # остановить, не удаляя контейнеры
```

## Технические замечания

- Библиотека `/srv/music` подключается к Docker-контейнерам только для чтения. Файлы добавляются на сервере.
- Web UI использует один пароль владельца; регистрации пользователей нет.
- Порт `8787` подходит для локальной сети. Для публикации в интернет нужны домен, HTTPS, reverse proxy и firewall.
- Не включать `MUSIK_AUTH_DISABLED=1` на доступном из сети сервере.
- Если используется LXC, для Docker могут потребоваться `nesting=1` и `keyctl=1`.
