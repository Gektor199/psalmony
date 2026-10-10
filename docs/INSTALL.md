# Установка Psalmony 0.4.3

В репозитории находятся PWA, сервер Node.js/PostgreSQL, собственный UDP-аудиосервер и исходники desktop-клиентов macOS/Windows. Готовые установщики, пользовательские данные и секреты не входят в Git.

## 1. Локальный запуск через Docker

Нужны Git и запущенный Docker Engine / Docker Desktop с Compose v2. Node.js и PostgreSQL на хост устанавливать не требуется.

```sh
git clone https://github.com/Gektor199/psalmony.git
cd psalmony
cp .env.example .env
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3180/api/health
```

В Windows PowerShell вместо `cp` можно использовать `Copy-Item`, а вместо `curl` — `Invoke-RestMethod`.

Откройте **http://127.0.0.1:3180**. Успешный health-ответ содержит `ok: true` и `database: "postgresql"`. Первое открытие создаёт гостевую библиотеку; регистрация сохраняет её в аккаунте. Схема PostgreSQL создаётся сервером при запуске.

Порты доступны только на текущем компьютере: веб-приложение — 3180, PostgreSQL — 54329. Пароль из `.env.example` предназначен только для локальной разработки.

Команды обслуживания:

```sh
docker compose logs --tail=100 psalmony postgres
docker compose stop
docker compose up -d
# После получения обновлений:
git pull --ff-only
docker compose up -d --build
```

Данные сохраняются в отдельных именованных volumes `psalmony-postgres` и `psalmony-data` (Compose добавляет префикс проекта). Не используйте `docker compose down -v`: команда удаляет данные. Смена `POSTGRES_PASSWORD` не меняет пароль уже созданного пользователя БД автоматически.

## 2. Разработка и проверки

Нужны Node.js 24+ и PostgreSQL из Compose. `npm ci` устанавливает также CLI для desktop-сборки.

```sh
npm ci
docker compose up -d postgres
# Если приложение уже работает в Docker:
docker compose stop psalmony
npm run dev
```

По умолчанию сервер использует `postgres://psalmony:psalmony-local@127.0.0.1:54329/psalmony`. Node-процесс не загружает `.env` автоматически: если изменён пароль, передайте согласованный `DATABASE_URL` через окружение. Пример для POSIX shell:

```sh
DATABASE_URL='postgres://psalmony:YOUR_PASSWORD@127.0.0.1:54329/psalmony' npm run dev
```

Проверки из второго терминала:

```sh
npm run check
npm test
TEST_BASE=http://127.0.0.1:3180 npm test
```

В PowerShell для последней команды сначала выполните `$env:TEST_BASE='http://127.0.0.1:3180'`, затем `npm test`. При нестандартной БД задайте тот же `DATABASE_URL` и тестам. Интеграционные тесты создают и удаляют собственные записи: запускайте их на локальной тестовой БД. Без `TEST_BASE` API-интеграция пропускается.

## 3. Собственный аудиосервер локально

Сгенерируйте ключ `openssl rand -hex 32` и вставьте его в `AUDIO_TICKET_SECRET` в локальном `.env`. Один и тот же ключ нужен API и relay; не отправляйте его в Git.

```sh
docker compose -f compose.yaml -f compose.audio.yaml up -d --build
docker compose -f compose.yaml -f compose.audio.yaml logs --tail=100 audio
```

Relay слушает только `127.0.0.1:22126/udp`. Для звука нужен desktop-клиент. Браузерная PWA не подключается к этому UDP-протоколу. Максимум — восемь участников комнаты; участники входят через аккаунты и группы Psalmony.

**Важно:** готовый desktop-клиент подключается к API в Екатеринбурге. Для локального пилота перед сборкой замените `BACKEND` в `desktop/src-tauri/src/gateway.rs` на `http://127.0.0.1:3180`; запускайте debug-сборку (`cd desktop && npx tauri dev`). В debug-режиме разрешён аудиоадрес `127.0.0.1:22126`. Release-сборка допускает только явно заданный адрес в `Engine::connect` файла `desktop/src-tauri/src/audio.rs`.

## 4. Сборка macOS

Нужны Node.js 24+, Rust/Cargo, Xcode Command Line Tools. Команды выполняются на Mac из корня репозитория:

```sh
npm ci
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run desktop:mac
```

Результаты:

- `releases/Psalmony-0.4.3-mac-universal.dmg`;
- `desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Psalmony.app`.

Откройте DMG и перенесите Psalmony в Applications. Минимальная версия macOS в конфигурации — 12.0. Сборка universal поддерживает Intel и Apple Silicon. Подпись ad-hoc, нотариализации Apple нет; это пилот, не релиз App Store. Системный запрос доступа к микрофону появляется при использовании звука.

## 5. Сборка Windows

На Windows нужны Node.js 24+, Rust с MSVC toolchain, Visual Studio Build Tools с C++/Windows SDK и WebView2 Runtime для запуска клиента.

```powershell
npm ci
rustup target add x86_64-pc-windows-msvc
cd desktop
npx tauri build --target x86_64-pc-windows-msvc --config src-tauri/tauri.windows.conf.json
```

Установщик: `desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Psalmony_0.4.3_x64-setup.exe`. Запустите его и следуйте мастеру установки. Authenticode-подписи нет. Установка и звук на физическом Windows пока не проверены.

Использованный в пилоте вариант кросс-компиляции с Apple Silicon Mac:

```sh
brew install llvm nsis
cargo install cargo-xwin --locked
rustup target add x86_64-pc-windows-msvc
PATH="/opt/homebrew/opt/llvm/bin:$PATH" npm run desktop:windows
```

На Intel Mac у Homebrew другой префикс; вместо фиксированного пути используйте `$(brew --prefix llvm)/bin`. Кросс-компиляция не заменяет проверку на Windows.

## 6. Развёртывание на своём Linux-сервере

Для обычной PWA можно использовать корневой Compose за HTTPS reverse proxy. PostgreSQL оставьте на loopback или во внутренней Docker-сети. Задайте сильный `POSTGRES_PASSWORD` и `COOKIE_SECURE=true`. Прокси должен передавать исходный `Host`, направлять запросы на порт приложения 3180 и принимать вложения до 30 МБ. Не включайте secure-cookie для локального HTTP-запуска.

`deploy/ekaterinburg/compose.yaml` — профиль сервера **91.226.80.181**. Он включает приложение, PostgreSQL, собственный UDP relay, отдельный Jamulus и Caddy с автоматическим HTTPS. Веб-адрес: https://psalmony.91.226.80.181.sslip.io. Московский профиль сохранён только для истории конфигурации.

Создайте `deploy/ekaterinburg/.env` с `POSTGRES_PASSWORD` (случайный hex удобен для URL) и `AUDIO_TICKET_SECRET` (32 байта в hex, 64 символа). Файл должен иметь права 600. При переносе существующей базы сохраните действующие секреты. Затем из корня репозитория:

```sh
mkdir -p releases
docker compose -f deploy/ekaterinburg/compose.yaml --env-file deploy/ekaterinburg/.env up -d --build
docker compose -f deploy/ekaterinburg/compose.yaml --env-file deploy/ekaterinburg/.env ps
curl https://psalmony.91.226.80.181.sslip.io/api/health
```

Откройте TCP 80/443 для HTTPS и UDP 22126 для собственного аудио, UDP 22124 для Jamulus. PostgreSQL доступен только во внутренней Docker-сети. Caddy сохраняет сертификаты в отдельных volumes. Установщики 0.4.3 кладутся в `releases` и доступны по `/downloads/`.

Для другого сервера замените IP и домен в Compose/Caddyfile, `BACKEND` в `desktop/src-tauri/src/gateway.rs`, разрешённый адрес в `Engine::connect` в `audio.rs` и ссылки загрузки в `public/rehearsal.js`, затем пересоберите клиенты. Клиенты до 0.4.3 используют старый сервер и требуют обновления. После смены домена в браузере нужно заново войти в аккаунт; локальный офлайн-кэш старого домена автоматически не переносится.

Для резервной копии сохраняйте согласованно дамп PostgreSQL и volume вложений. При обновлении сохраняйте имя Compose-проекта и расположение volumes. Не заменяйте существующие секреты при обычном обновлении.

## 7. Первая проверка звука

Откройте сет-лист → «Открыть комнату» → «Настройки звука», выберите устройства, подключитесь. Слева виден вход устройства до Mute. Справа — полученные с сервера каналы, включая собственный возврат. Фейдеры меняют ваш личный микс. Микрофон и громкость первоначально выключены; собственный возврат также начинается с нуля. Для прослушивания себя используйте наушники.

Ping и Jitter описывают сеть, Delay — расчётная оценка, не измеренная полная задержка аудиотракта. В последнем Mac-пилоте реальный возврат получен, но соединение было нестабильным; совместная игра восьми физических музыкантов не подтверждена. Подробнее: [VALIDATION.md](VALIDATION.md).

`audio-smoke.mjs` и `relay-return-smoke.mjs` в `scripts/` — операторские проверки пилота в Екатеринбурге: содержат фиксированный SSH-хост и ID тестируемой группы, создают временного участника. Они не нужны для установки и не запускаются автоматически. Остальные desktop smoke-скрипты требуют уже запущенного клиента; некоторые кратко включают микрофон при нулевой громкости выхода. Запускайте их только в контролируемой тестовой сессии.

Jamulus остаётся отдельным необязательным пилотом, описанным в README. Мобильные приложения распространяются как PWA; исходников нативных iOS/Android клиентов здесь нет.
