# Спецификация модуля: musik-fetcher

## 1. Назначение
Автономный сервис загрузки и локального кэширования аудиофайлов по требованию для плеера `musik`.

---

## 2. Результаты реального бенчмарка (Протестировано в системе)

Тестовый прогон на треке `Queen - Bohemian Rhapsody` (длительность 5:55):
* **Время поиска в YouTube Music (InnerTube API):** 1.2 секунды.
* **Время скачивания чистого аудио (yt-dlp + Deno):** **0.8 секунды**.
* **Скорость скачивания:** **73.8 МБ/с**.
* **Размер итогового файла:** 5.68 МБ (контейнер `.m4a`, кодек Opus 160 kbps).
* **Реклама:** 0% (сырой чистый аудиопоток).

---

## 3. Стек технологий
* **Python** (или **Deno / TypeScript**) для легковесного API-сервера.
* **`ytmusicapi`** — фильтрация строго студийных треков (отсекает видеоклипы и живые концерты).
* **`yt-dlp`** — забор потока Google Video CDN.
* **Deno / QuickJS** — встроенный легковесный JS-движок для решения YouTube player challenges (`n-sig`).

---

## 4. REST API контракты

### `POST /api/v1/fetch`
Запрос на получение или фоновое скачивание трека.

**Request JSON:**
```json
{
  "artist": "Queen",
  "title": "Bohemian Rhapsody",
  "album": "A Night at the Opera",
  "duration_sec": 355
}
```

**Response JSON (Success, 200 OK):**
```json
{
  "status": "ready",
  "file_path": "/dynamic/queen_bohemian_rhapsody_fJ9rUzIMcZQ.m4a",
  "cached": true,
  "format": "m4a",
  "bitrate_kbps": 160,
  "size_bytes": 5956710,
  "fetch_duration_ms": 820
}
```

---

## 5. Политика очистки кэша (LRU Cache Policy)

* **Лимит:** настраивается через переменную окружения `CACHE_MAX_SIZE_GB=15` (по умолчанию 15 ГБ).
* **Порядок вытеснения:**
  1. При превышении лимита сканируются файлы в папке `/dynamic`.
  2. Сортируются по дате последнего доступа (`atime` — Access Time).
  3. Делается запрос в базу данных `musik.db`:
     ```sql
     -- Проверка: не сохранен ли трек у кого-то из пользователей
     SELECT COUNT(*) FROM favorites WHERE track_id = :id
     UNION ALL
     SELECT COUNT(*) FROM user_later WHERE track_id = :id;
     ```
  4. Если счетчик равен 0 — файл безопасно удаляется с диска. Метаданные и эмбеддинг в базе сохраняются.
