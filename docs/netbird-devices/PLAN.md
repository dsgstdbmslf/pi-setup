# netbird-devices — план расширения Pi

Статус: этапы A–D реализованы и закоммичены в ветке `extensions/netbird-devices` (без пуша); §16 проверен на Mac (Linux — нет).
Рабочая копия: `/home/orca/orca/workspaces/pi-setup/Netbird-devices` (репозиторий `pi-setup`,
пакет Pi `git:github.com/dsgstdbmslf/pi-setup`, загружается `extensions/*.ts`).

## 1. Цель

Расширение Pi (не Orca: никаких зависимостей от Orca), которое даёт агенту:

1. Список устройств NetBird: какие онлайн, у каких включён NetBird SSH, ОС, под каким пользователем входить.
2. Понимание, за каким компьютером сейчас пользователь («подключись к моему компьютеру»).
3. Файловые инструменты на удалённой машине с нормальными диффами и чтением картинок (скриншоты с Mac).
4. Режимы доступа по устройствам с подтверждениями (окна как у `bitwarden-ssh`), защищённые папки.
5. Строку статуса и журнал действий по машинам.
6. Пароль root через системное окно на самом устройстве (Mac/Linux): описано действие, пароль и секреты
   агенту не попадают.
7. Простой и нативный сетап, экономия токенов.
8. Агент работает с устройствами только через расширение, а не через `ssh` в bash.

## 2. Решения пользователя (зафиксировано)

| Вопрос | Решение |
|---|---|
| Источник списка устройств | Без настройки (`99-netbird.conf` + проверка портов + `ss`), **опционально** API-токен NetBird |
| Пользователь для входа | Определять **автоматически**; пользователь может работать с разных аккаунтов. Сообщать об ограничениях |
| Режим по умолчанию | `ask` |
| Модель классификатора | `anthropic/claude-haiku-5-5` по умолчанию; выбор из **всех моделей, подключённых к Pi** (например `openai-codex/gpt-6.1-terra`) |
| Форма инструментов | Параметр `device` у встроенных `read`/`write`/`edit`/`bash` + один маленький инструмент `devices` |
| Футер | Показывает **одно** устройство — текущее. По умолчанию эта VM; когда агент работает на Mac/Linux — оно. Без списка всех устройств |
| Режимы | `ro` / `ask` / `auto` (классификатор) / `full`; переключаются **в пределах сессии** |
| Несколько устройств одновременно | Нужен механизм разрешения конфликта (см. §7) |

## 3. Что выяснили об окружении

- VM: hostname `old-man.vpspay.net`, имя в NetBird `cloudcli` (`cloudcli.netbird.cloud`, `100.71.73.147`, интерфейс `wt0`).
  В футере по умолчанию — имя NetBird (`cloudcli`), настраивается `localName`.
- NetBird 0.82.0. **Сокет демона `/var/run/netbird.sock` доступен только root** — намеренно
  (`/etc/systemd/system/netbird.service.d/10-socket-perms.conf`, аудит 2026-10-11: у IPC нет проверки
  вызывающего). Поэтому `netbird status`, `netbird ssh detect/proxy` от пользователя `orca` не работают.
  Не предлагать ослаблять права сокета.
- `/etc/ssh/ssh_config.d/99-netbird.conf` читается всеми и содержит пиры с включённым NetBird SSH:
  `sergeys-macbook-pro` (100.71.171.69), `iphone-1037955`, `ipad-1037955`, `personal-project-nl` (100.71.201.21).
  **Linux-компьютера пользователя там нет**: либо не включён `--allow-server-ssh`, либо другое имя/сеть. Имя неизвестно.
- Обратный DNS NetBird работает: `getent hosts 100.71.171.69` → `sergeys-macbook-pro.netbird.cloud`.
- Mac: `SSH-2.0-NetBird-SSH-Server-0.82.0`, **без** `NetBird-JWT-Required` → аутентификация отключена.
  Вход методом `none` под любым **существующим** пользователем; несуществующий → `User authentication failed`.
  Пользователь `sergey` (uid 501), macOS 27.0, arm64, shell `/bin/zsh`, console user `sergey`.
  `launchctl managername` = `Background` (сессия SSH не в GUI-контексте).
- `personal-project-nl`: порт 22 не отвечал (таймаут) на момент проверки.
- Сейчас пользователь подключён к VM с Mac: входящие соединения `100.71.171.69 → 100.71.73.147:6768` (порт Orca).
  Активность по `lastrcv` в `ss -ti` **не годится** (keepalive каждые ~7 с у всех соединений).
- Модели в Pi: `anthropic/claude-haiku-5-5`, `openai-codex/gpt-6.1-terra` и др. есть.
- Pi 1.5.2, Node 22. Тесты репо: `node --test test/*.test.ts`, модули без импортов Pi (нет `node_modules`).

### Действия на Mac во время исследования (только чтение)
`id -un`, `sw_vers -productVersion`, `stat -f%Su /dev/console`, `ioreg HIDIdleTime`, `launchctl managername`,
`uname -m`, `which python3 base64 file`, вход несуществующим пользователем, `ssh -N` с методом `none`.
Системные окна **не открывались**.

### Инцидент
При просмотре `env` в контекст модели попал `ORCA_AGENT_HOOK_TOKEN`. Риск низкий; пользователю предложено перевыпустить.
Впредь не печатать окружение целиком (фильтровать `TOKEN|KEY|SECRET|PASS`).

## 4. Модель безопасности и оговорки (важно)

1. **Мак открыт для любого процесса VM.** NetBird SSH с отключённой аутентификацией + ACL, разрешающий VM → Mac:22,
   значит любой процесс любого пользователя VM может войти на Mac как `sergey`. Блок `ssh` в bash агента —
   **ограждение от привычек модели, а не песочница** (агент может открыть сокет через python и т.п.).
   Реальная граница: ACL NetBird (только эта VM → Mac:22), отдельный пользователь без admin, или JWT.
2. **JWT-режим** (`NetBird-JWT-Required`) с этой VM не заработает: нужен `netbird ssh proxy`, а он ходит в root-сокет;
   плюс OIDC-вход на headless-сервере. Пока: обнаруживать баннер и сообщать понятной ошибкой.
3. **Автоопределение пользователя** работает только при отключённой аутентификации NetBird SSH (или ключах в
   `ssh-agent` для обычного OpenSSH). Порядок: настройка `user` → кэш → кандидаты из имени пира
   (`sergeys-macbook-pro` → `sergey`, `sergeys`) → API (если есть) → `$USER` VM. После входа — переключение на
   **пользователя за экраном** (`stat -f%Su /dev/console` / `loginctl show-seat seat0`), если он другой и вход
   под ним проходит. Если ничего не подошло — один раз спросить в Pi и запомнить. root никогда не кандидат.
4. **Системное окно на macOS** из фоновой SSH-сессии: прямой `display dialog` упадёт (-1713). Используем
   `tell application "System Events" to display dialog … with hidden answer`. macOS **один раз** спросит разрешение
   Automation (кто-то из netbird/ssh хочет управлять System Events). Если отказано/недоступно (-1743 и т.п.) —
   откат на маскированное окно Pi. **Ещё не проверено на устройстве** — проверять только с согласия пользователя
   (`/nb test-root mac`), он должен быть за Mac.
5. **Linux-окно**: zenity / kdialog / ssh-askpass в графической сессии пользователя (подбор `XDG_RUNTIME_DIR`,
   `WAYLAND_DISPLAY`, `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`). Best effort; при неудаче — окно Pi.
6. **Пароль root**: в нативном пути пароль идёт «окно → sudo» на самом устройстве и не покидает его.
   В пути через Pi пароль проходит через память процесса Pi и ssh (stdin `sudo -S`), но **не** к модели, не в логи.
   Агентская команда не может перехватить пароль: sudo запускается нами, команда агента — уже под root внутри
   `sudo -- /bin/bash -c`. Остаточный риск: процесс того же пользователя на устройстве может подменить
   временный askpass-хелпер (пишется заново в `mktemp -d` с umask 077 на каждый вызов) — задокументировать.
   `sudo -k` — пароль спрашивается **каждый** раз, кэш не используется.
7. **Классификатор** видит только сообщения пользователя и само действие, **никогда** вывод инструментов
   (защита от prompt injection из файлов на устройстве). Ошибка/таймаут/нет модели → `ask`.
   Жёсткие правила (защищённые пути, опасные команды) проверяются **до** классификатора, ослабить их он не может.
8. **Ключи хостов**: собственный `known_hosts` расширения, `StrictHostKeyChecking=accept-new`, `HostKeyAlias=<fqdn пира>`.
   Смена ключа → ошибка и `/nb forget <device>`.
9. Прерывание: без tty удалённый процесс может продолжить работу после отмены (зависит от NetBird SSH сервера).
10. Скриншоты экрана (`screencapture`) — не в первой версии: приватность + TCC Screen Recording. Чтение готовых
    файлов-картинок работает через `read`.
11. Не трогать `~/.ssh/pi-bitwarden/config` и сокет netbird; расширение использует `ssh -F /dev/null` с явными
    опциями (не зависит от `~/.ssh/config`, но `SSH_AUTH_SOCK` от `bitwarden-ssh` подхватывается).

## 5. Архитектура

```
extensions/netbird-devices.ts          — вход: инструменты, команды, события, футер
extensions/netbird-devices/
  settings.ts     ✅ настройки netbirdDevices (pure)
  discovery.ts    ✅ 99-netbird.conf, API /api/peers, ss → пиры, входящие соединения (pure)
  policy.ts       ✅ режимы, защищённые пути (glob), read-only команды, опасные команды, decide() (pure)
  guard.ts        ✅ поиск ssh/scp/curl… к устройствам в bash агента (pure)
  presence.ts     ✅ «где пользователь»: resolveHere(), IDLE_PROBE (pure)
  classifier.ts   ✅ промпт и разбор ответа классификатора (pure)
  remote.ts       ✅ скрипты: probe, bash-обёртка, askpass macOS/Linux, root-обёртки, варианты путей (pure)
  ssh.ts          ✅ запуск ssh с ControlMaster, exec/stream/stdin, операции read/write/edit/bash
  state.ts        ✅ ~/.pi/agent/netbird-devices/state.json (пользователи, probe-кэш, модель классификатора)
  journal.ts      ✅ журнал JSONL, ротация, форматирование
  ui-text.ts      ✅ футер, таблица устройств, текст диалогов (pure)
  root.ts         ✅ root: native/pi окно пароля, `/nb test-root` (этап D)
test/netbird-devices*.test.ts           ✅
README.md (раздел расширения)          ✅
```

### Транспорт
`ssh -F /dev/null -p <port> -o BatchMode=yes -o ConnectTimeout=8 -o ControlMaster=auto
-o ControlPath=~/.pi/agent/netbird-devices/cm/%C -o ControlPersist=10m -o StrictHostKeyChecking=accept-new
-o UserKnownHostsFile=~/.pi/agent/netbird-devices/known_hosts -o HostKeyAlias=<fqdn> user@<ip>`.
Без shell на стороне VM (spawn с массивом аргументов). Команды на устройстве — POSIX sh через login-shell пользователя;
команда агента — в `/bin/bash -c` с `PATH`, взятым один раз из `$SHELL -lc` (чтобы был Homebrew).

### Probe (один round trip, кэш на устройство+пользователя)
ОС, arch, версия, user, home, shell, PATH, console user, наличие sudo (`PROBE_SCRIPT` в `remote.ts`).

## 6. Инструменты для агента (экономия токенов)

- Встроенные `read`, `write`, `edit`, `bash` переопределяются: схема + необязательный `device`
  («имя устройства NetBird или "here"; пропусти для этой машины»). Выполнение — через `create*ToolDefinition(home, { operations })`
  с удалёнными операциями. **Пути предварительно разрешаются** (`~`, относительные) от home устройства, т.к.
  встроенные инструменты раскрывают `~` локально и берут `ctx.cwd`.
- `device: "here"` → устройство, за которым пользователь (§7). `device` = имя VM/`local` → локально.
- `read`: картинки работают (buffer → resize встроенным кодом). Для скриншотов macOS — подбор вариантов имени
  (узкий пробел перед AM/PM, NFD, curly quote) на устройстве одним вызовом.
- `edit`: подтверждение **внутри** `EditOperations.writeFile` — там есть точное новое содержимое и исходник
  (кэш из `readFile`) → дифф в диалог → запись или ошибка «отклонено». Дифф в чате — встроенный рендер из `details.diff`.
- `write`: `mkdir` откладывается до подтверждения (выполняется в `writeFile`).
- `bash`: решение до запуска. Команда, начинающаяся с `sudo `, → путь root (§8). `sudo` в середине команды
  упадёт без tty (fail closed), подсказка в ошибке.
- Рендер: для вызовов с `device` подставлять в отображение `mac:~/path` / `$ [mac] cmd`; у `edit` не давать
  встроенному превью читать **локальный** файл с тем же путём (передавать display-args без `edits`).
- `devices` (actions `list`, `here`): компактный текст, напр.
  ```
  here: mac (input 3s ago)
  cloudcli — this VM (local)
  mac    sergeys-macbook-pro  macOS 27.0 arm64  sergey  ● online  ssh  mode auto
  nl     personal-project-nl  ?                 ○ offline
  ```
- `promptGuidelines` (1–2 строки): работать с устройствами через `device`, «"here" = компьютер пользователя»,
  не использовать ssh в bash. Системный промпт не меняется по ходу (кэш); изменения сводки — сообщением.

## 7. «Где пользователь» и несколько устройств

Сигналы по порядку:
1. Закрепление `/nb here mac` (до конца сессии; `/nb here auto` снимает).
2. Входящие NetBird-соединения к **слушающим** портам VM (`ss -tlnH` + `ss -tnH state established`, локальный адрес —
   наш NetBird IP, пир в 100.64.0.0/10). Одно устройство → оно.
3. Несколько → время бездействия ввода на каждом (macOS `ioreg HIDIdleTime`; Linux logind `IdleSinceHint`/`xprintidle`),
   только по запросу. Лучший < 2 мин и остальные ≥ 10 мин → он.
4. Иначе, если пользователь выбирал < 30 мин назад — тот же.
5. Иначе окно выбора в Pi «Где ты? mac / linux-pc» (без токенов модели), запоминается на 30 мин.
   Без UI — агенту возвращается список кандидатов.

## 8. Root

`rootPrompt` устройства: `auto` (по умолчанию) | `native` | `pi`.
- `auto`: если устройство = «here» и активно → нативное окно; иначе окно Pi.
- Нативный путь: `rootNativeWrapper()` — временный askpass, `SUDO_ASKPASS=… sudo -k -A -- /bin/bash -c <cmd>`;
  коды 196 (окно недоступно → повтор через Pi) и 197 (отменено пользователем).
- Путь Pi: маскированный ввод (`askSecret` из `extensions/bitwarden-ssh/secret-input.ts`, только TUI; в RPC — отказ),
  пароль на stdin `sudo -S -k -p ''`.
- Текст окна: «Pi agent on cloudcli asks to run as root: <команда> … Enter your password only if you expect this.»
- Футер во время ожидания: `→ mac · auto · 🔑 пароль root`.

## 9. Режимы и решения (`policy.decide`)

| | `ro` | `ask` | `auto` | `full` |
|---|---|---|---|---|
| read | ✓ | ✓ | ✓ | ✓ |
| read защищённого | спросить | спросить | спросить | спросить |
| write/edit | ✗ | спросить | классификатор | ✓ |
| write защищённого | ✗ | спросить | спросить | спросить |
| bash read-only (белый список) | ✓ | ✓ | ✓ | ✓ |
| bash прочее | спросить | спросить | классификатор | ✓ |
| bash опасное | спросить ⚠ | спросить ⚠ | спросить ⚠ | спросить ⚠ |
| sudo (root) | ✗ | окно пароля | классификатор → окно пароля | окно пароля |

- Окно подтверждения (`ctx.ui.select`): **Разрешить один раз / Всегда разрешать это (путь|команда) в сессии /
  Переключить <device> в full до конца сессии / Отклонить**. Заголовок + дифф/команда + причина/⚠.
  Один диалог за раз — общий `__piSharedUiLock` (как в `bitwarden-ssh`, `ask-user-question`); диалоги закрываются
  при `session_shutdown`.
- Режим в сессии: `/nb mode [device] [ro|ask|auto|full]` (без аргументов — выбор), горячая клавиша `alt+m` —
  по кругу для текущего устройства. Сохраняется `pi.appendEntry("netbird-devices-mode", …)`, восстанавливается из
  `getBranch()` на `session_start`/`session_tree`. Агент режимы менять **не может**.
- Защищённые по умолчанию: `~/.ssh/**`, `~/.gnupg/**`, `~/.aws/**`, `~/.kube/**`, `~/.config/gh/**`, `~/.netrc`,
  `~/Library/Keychains/**`, `~/Library/Cookies/**`, профили браузеров, `~/.pi/agent/auth.json`, `api-keys.json`,
  `/etc/shadow`, `/etc/sudoers*`, `**/.env`, `**/.env.*` + свои из настроек.

## 10. Классификатор

- Модель: `netbirdDevices.classifierModel` → переопределяется `/nb classifier` (выбор из `ctx.modelRegistry.getAvailable()`
  или `ctx.scopedModels`), выбор хранится в `state.json`.
- Вызов `ctx.modelRegistry.streamSimple(model, { systemPrompt, messages: [user] }, { maxTokens: ~300, signal })`.
- Вход: устройство/ОС/пользователь, последние сообщения пользователя (из `sessionManager.getBranch()`, ~4000 символов),
  действие (дифф ≤ 3000 символов / команда). Ответ JSON `{decision, reason}`.
- `deny` → агенту причина; 3 отказа подряд в сессии → следующий вопрос сразу пользователю.
- Кэш одинаковых действий в сессии; `usage` классификатора добавляется к результату инструмента (учёт в итогах).

## 11. Футер и журнал

Один ключ `setStatus("netbird-devices", …)`:
```
⌂ cloudcli                       по умолчанию
→ mac · auto                     агент работает на маке
→ mac · ask · ⏸ ждёт тебя        открыто подтверждение
→ mac · auto · 🔑 пароль root     открыто окно пароля
```
Возврат к `⌂ cloudcli` через ~8 с после `agent_settled`.

Журнал `~/.pi/agent/netbird-devices/log.jsonl` (ротация ~2 МБ): время, сессия, устройство, пользователь, инструмент,
кратко (путь/команда ≤ 200 символов), решение (`auto`/`asked→allowed`/`classifier:allow`/`denied`), результат, длительность.
Без содержимого файлов и вывода. `/nb log [device] [n]`:
```
13:42:05  mac  read  ~/Desktop/Screenshot 2026-11-15.png  1.2 MB  ✓
13:42:40  mac  edit  ~/proj/app.ts  +3 −1                ✓ спросил → разрешено
13:43:02  mac  bash  brew list | head                    ✓ exit 0 · 0.4s
13:44:10  nl   sudo  systemctl restart nginx             ✗ отклонено
```

## 12. Блок ssh в bash агента

`tool_call` для `bash` без `device`: если команда содержит сетевой глагол (`ssh scp sftp rsync mosh sshfs telnet nc
ncat socat curl wget git netbird autossh ssh-copy-id`) и цель — имя/FQDN/IP/алиас устройства, адрес из 100.64.0.0/10
или домен NetBird (кроме самой VM) → `block` с причиной «используй device: "mac"». `!`-команды пользователя не трогаем.

## 13. Команды `/nb`

`/nb` (устройства), `/nb mode`, `/nb here [device|auto]`, `/nb classifier [provider/model]`, `/nb log [device] [n]`,
`/nb refresh`, `/nb user <device> <user|auto>`, `/nb test-root <device>` (открывает окно пароля, `sudo -k -A true`),
`/nb forget <device>` (ключ хоста и кэш). С автодополнением.

## 14. Настройки и файлы

`~/.pi/agent/settings.json`:
```json
"netbirdDevices": {
  "defaultMode": "ask",
  "classifierModel": "anthropic/claude-haiku-5-5",
  "apiUrl": "https://api.netbird.io",
  "localName": "",
  "protected": [],
  "devices": {
    "mac": { "peer": "sergeys-macbook-pro", "aliases": ["мак"], "mode": "auto", "rootPrompt": "auto" }
  }
}
```
Токен API (необязательно, read-only сервисный пользователь): `~/.pi/agent/api-keys.json` → `"netbird": "nbp_…"`
(или формат пула ключей как у tavily). Авто-алиасы: `mac`/`linux`, если такое устройство одно.
Состояние: `~/.pi/agent/netbird-devices/{state.json,known_hosts,log.jsonl,cm/}` — права 600/700.

## 15. Этапы

1. ✅ ✅ Pure-модули (settings, discovery, policy, guard, presence, classifier, remote).
2. ✅ ssh.ts + state.ts + список устройств + «where» + футер + блок ssh в bash + инструмент `devices`.
3. ✅ Удалённые `read/write/edit/bash` с `device`, рендер, подбор путей скриншотов.
4. ✅ Режимы, диалоги, одобрения в сессии, `/nb mode`, `alt+m`, защищённые пути.
5. ✅ Классификатор + `/nb classifier`.
6. ✅ Root: нативные окна + окно Pi + `/nb test-root`.
7. ✅ Журнал + `/nb log`.
8. ✅ Тесты (`test/netbird-devices.test.ts`), README, проверка `pi -e ./extensions/netbird-devices.ts`.

## 16. Проверка на устройствах (только с согласия пользователя)

- `devices list` видит mac/iphone/ipad/nl, online-статус.
- `here` → mac, пока подключён только мак.
- `read` с `device:"here"` скриншота с рабочего стола → картинка.
- `edit` тестового файла в `~/pi-nb-test/` в режиме `ask` → диалог с диффом.
- `bash` `sudo true` → системное окно на Mac (разрешить Automation один раз), отмена → «отменено пользователем».
- `bash` `ssh sergeys-macbook-pro` без `device` → блок.

## 17. Открытые вопросы

Ответы пользователя:
- Linux-компьютер: пока делаем без него; Linux-ветку проверим позже.
- API-токен: поддержать **опционально**, без токена всё работает.
- `screenshot`: не в первой версии.
- Исполнители коммитят после каждого этапа в текущую ветку, без пуша.
- Проверка на устройствах: чтение на Mac + `~/pi-nb-test/`; пользователь сейчас за Mac — `/nb test-root mac` и
  системное окно можно проверять без дополнительного вопроса.
- ACL NetBird / отдельный пользователь — решение пользователя, остаётся в README как рекомендация.

Исходный список:

- Имя/наличие Linux-компьютера в NetBird и включён ли на нём NetBird SSH.
- Нужен ли API-токен (даст ОС, last_seen и пиров без SSH).
- Ограничить ли ACL NetBird доступ к Mac только с этой VM / отдельный пользователь (решение пользователя).
- Делать ли действие `screenshot` позже (TCC Screen Recording, всегда с подтверждением).
