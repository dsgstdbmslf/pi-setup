# Независимое ревью netbird-devices

Рабочая копия: `/home/orca/orca/workspaces/pi-setup/Netbird-devices`, ветка `extensions/netbird-devices`.
Проверены этапы `7f5e5ff`, `b882e3e`, `3913241`, `e18fcb3` относительно `6ec5d12`, план,
IMPLEMENTATION, README, все модули расширения, изменение bitwarden-ssh, тесты и API установленного Pi.
Архитектура сохранена; устройств пользователя ревьюер не касался, sudo и системные окна не запускал.

## Найдено и исправлено

Подтверждённых critical после ревью нет. Ниже серьёзность исходной проблемы.

| Серьёзность | Находка и исправление | Файлы / регрессии |
|---|---|---|
| **high** | Wrapper вызывал `sudo` из login PATH. Подложенный исполняемый файл мог принять пароль на stdin и вывести его вместо запуска sudo. Теперь `/usr/bin/sudo`, системный PATH для native helper и его утилит; агентская команда по-прежнему получает пустой stdin. | `remote.ts`; `netbird-devices-review.test.ts`: bait sudo в writable PATH, NOPASSWD, приватность helper; `root.test.ts` |
| **high** | Read-only список разрешал выполнение/запись: `sed e/w`, `awk printf >`, `find -delete` первым аргументом, произвольный `/tmp/cat`, PATH/LD_PRELOAD assignments, `printf -v PATH`, `>/dev/null.out`, `sysctl -f`, `journalctl --setup-keys`, `file -C`, смешанные изменяющие аргументы plutil/scutil. Git мог запускать external diff/fsmonitor/pager из config. Список сокращён и проверки стали fail closed; Git/package managers/embedded programs требуют авторизации. | `policy.ts`; `review.test.ts`, `netbird-devices.test.ts`, entry e2e |
| **high** | «Всегда разрешать» и classifier cache имели ключ только действия, без устройства; одобрение могло переноситься на другую машину/аккаунт. Classifier allow сохранялся после противоположной просьбы пользователя. Добавлены device + endpoint/login/home, а в classifier key — актуальные user messages, модель и хэш записываемого содержимого. | `session-policy.ts`, entry; `review.test.ts`, `entry.test.ts` (смена намерения), session tests |
| **high** | Защищённые пути обходились регистром macOS, Unicode normalization, переводом строки в `**`, quoted path с пробелами; glob/переменные и рекурсивные поиски могли не называть секретный файл явно. Добавлены case folding/NFC/dot normalization, dotAll, консервативный вопрос для динамических путей/поиска. | `policy.ts`; `review.test.ts`, entry e2e |
| **high** | Простой symlink обходил защищённый путь при read/write/edit и `bash cat alias`. Теперь проверяются канонические файл/родители/home и буквальные аргументы bash; >8 shell-путей → вопрос, а не пропуск проверки. `edit` авторизует защищённое чтение до построения диффа. | `ssh.ts` (`canonicalPath`), entry, `remote-ops.ts`, `policy.ts`; symlink/новые родители/loop/hostile names в review и entry tests |
| **high** | Классификатор мог разрешить скрытый хвост команды или изменения, отсутствующие в обрезанном/сводном диффе. Неполный preview теперь требует пользователя, не вызывает classifier allow. | `classifier.ts`, `session-policy.ts`; `review.test.ts` |
| **high** | В `ask` root рассчитывал только на гипотетический парольный диалог: native NOPASSWD запускал команду без подтверждения. Native root мог запускаться вообще без Pi UI. Теперь `ask` явно подтверждает root, а без UI root отклоняется до запуска. | `policy.ts`, entry; matrix tests, entry e2e (no-UI full root не вызывает ssh) |
| **medium** | Код 196/197 самой root-команды принимался за статус helper; 196 мог вызвать fallback и повторное выполнение уже сделанного действия. Wrapper теперь отделяет зарезервированные статусы: код самой команды переводится в 1. Abort/timeout не вызывает fallback. | `remote.ts`, `root.ts`; fake native/NOPASSWD execution, статусы cancel/unavailable, cleanup в `review.test.ts` |
| **medium** | Тесты наследовали SSH/SUDO/GIT askpass, socket настоящего Pi, SSH agent, DISPLAY и sudo shim. Кроме того, обычный `ssh -G` читает passwd-home, а не тестовый HOME, и мог выполнить реальные Match exec. Добавлен ранний scrub окружения (npm preload + прямые imports); default `ssh -G` в bitwarden entry e2e принудительно читает fixture config. | `test/isolated-env.ts`, `package.json`, bitwarden load/integration tests; regression с sentinel socket/env/PATH в `review.test.ts` |
| **medium** | Reload/new/resume/fork оставляли ControlMaster; старый/другой Pi мог использовать тот же socket. Не учитывались probe-логины, отменённый вызов всё равно мог стартовать ssh, таймеры жили после завершения. Теперь cleanup на каждом shutdown, отдельный namespace runtime, учёт in-flight/attempted logins, pre-abort без spawn, сигналы в file operations, очищаемые таймеры и принудительная граница ожидания classifier даже при некооперативном provider. | entry, `hub.ts`, `ssh.ts`, `remote-ops.ts`; hub/entry/review tests, RPC dialog shutdown |
| **medium** | Проверялся только листовой cm-каталог; небезопасный родитель `/tmp` fallback мог позволить подмену. known_hosts создавался с обычной umask, а не гарантированными 0600. Теперь проверяется владелец/тип родителя, known_hosts — owned regular file без symlink и 0600. | `ssh.ts`; `review.test.ts` |
| **medium** | Лимит вывода считал только stdout, но stderr без ограничения шёл в стриминг/локальный spool. Теперь лимит общий и применяется до callback. | `ssh.ts`; stderr flood regression в `ssh.test.ts` |
| **medium** | Встроенный read мог выбрать вариант имени по локальной ФС и тем самым изменить запрошенное имя на удалённой машине. Remote operations теперь закреплены за исходным remote path; варианты выбираются только на устройстве и проверяются политикой. | entry, `remote-ops.ts`; `tools.test.ts` |
| **low** | Журнал помечал вернувшийся `isError` как успешный `exit 0`; remote timeout 0/отрицательный молча становился 30 минутами. Исправлены реальный exit/isError и валидация timeout. Legacy edit display-args больше не могут включить локальное превью через oldText/newText/file_path. | entry, `remote-ops.ts`, `tools.ts`; entry/review/tools tests |

## Пароль root: результат проверки

- Подтверждённой утечки через штатный результат/details/журнал/ошибки/сессию не найдено; опасный
  PATH-hijack закрыт. Полный пароль не вставляется в скрипт/argv или текст ошибки.
- В Pi-пути пароль записывается в один Buffer с завершающим newline; ссылка на строку сбрасывается,
  Buffer обнуляется в finally при успехе, неправильном пароле, исключении, timeout и abort.
  Нет дополнительной JS-строки `password + newline`. JS immutable strings невозможно гарантированно
  физически стереть из heap; сброс ссылок не является криптографическим zeroization.
- `exec </dev/null` остаётся перед командой root: NOPASSWD не отдаёт ей непрочитанный пароль.
- Native helper — umask 077, mode 0700, приватный mktemp-каталог, checked chmod, cleanup EXIT/HUP/INT/TERM.
  Его stdout предназначен только sudo; коды 196/197 проверены реальным shell с fake sudo/zenity, без GUI.
- Отмена до ssh не запускает процесс; после закрытия Pi-диалога пароль не используется. Для native
  kdialog/ssh-askpass добавлен timeout, либо безопасный fallback в Pi при отсутствии timeout.

## Осталось / принятые ограничения

- **medium, известная граница §4 PLAN:** это не песочница. Локальный агент по-прежнему способен
  открыть socket из Python, а доступ NetBird без auth доступен любому процессу VM. Нужны ACL/JWT
  или отдельный непривилегированный пользователь; менять это без владельца нельзя.
- **medium, best effort:** hard links, mount aliases, symlink TOCTOU и обратные алиасы symlink-защищённых
  директорий не устраняются предварительным stat. В bash невозможно полностью вывести файловые
  обращения произвольных программ, их config/input files и всех вариантов аргументов; канонизируются
  буквальные аргументы, но это не полноценный shell/interpreter sandbox. Добавлять canonical secret-store
  paths в protected; для строгой границы нужен другой execution boundary. Ограничения отражены в README.
- **medium, известное §4.9:** после разрыва SSH удалённые процессы/системное окно могут некоторое время
  жить независимо от Pi. Cleanup и таймауты усилены, но поведение NetBird SSH сервера не гарантирует
  завершение всего удалённого дерева. Настоящие macOS/Linux GUI и реальные устройства заново не тестировались
  по условиям задания; ранее проверенный Mac и непроверенный Linux не выдаются за новое подтверждение.
- **low:** classifier usage остаётся в `details.netbirdClassifier`, а не в нативном `result.usage` Pi;
  отклонённые/бросающие вызовы не учитывают его в итогах. Это известное отклонение IMPLEMENTATION,
  не дефект защиты; отдельная доработка учёта, без изменения поведения в этом ревью.
- **low:** mode overrides восстанавливаются из session branch, approvals — только в памяти;
  пользовательский pin here теряется при пересоздании runtime на reload. Нет миграции исторических
  ControlMaster предыдущей версии: они доживут свой ControlPersist, новые runtime имеют отдельные имена.
- **low:** root требует `/usr/bin/sudo`; необычные Linux layouts вместо доверия writable PATH
  безопасно отказывают. Native NOPASSWD законно не спрашивает пароль в full/auto; это теперь описано.
- **low:** Node пишет обычное MODULE_TYPELESS_PACKAGE_JSON warning для TS-тестов; перевод всего проекта
  на `type: module` не относится к безопасности расширения.

## Проверки

- `npm test`: **361 passed, 0 failed, 0 skipped** (последний полный прогон ~105.6 s).
- `pi -ne -e ./extensions/netbird-devices.ts --mode rpc --no-session`, отдельный временный agent dir:
  процесс **exit 0**, `get_commands` **success**, `/nb` зарегистрирован, stderr Pi пуст.
- `git diff --check`: чисто.
- Local read/write/edit/bash без device сравниваются с встроенными определениями Pi в entry e2e.
- Здесь не было подключений к устройствам пользователя, пользовательского sudo или настоящих GUI prompts.

Коммит исправлений: `fix(netbird-devices): review fixes`; хэш передан координатору после создания коммита.

## Follow-up: узкий безопасный Git и root UI

- После предоставленного координатором Mac smoke восстановлены простые read-only Git вызовы:
  status/log/diff/show, branch только listing flags, rev-parse, ls-files, глобальный -C.
  Policy разрешает их только через общий строгий parser; выполнение всегда переписывается в
  системный Git с чистым окружением, no-pager/no-optional-locks и отключёнными внешними helpers,
  fsmonitor/textconv/filters/hooks/credentials/submodules/сетью. Неподдерживаемые flags/пайпы → ask.
- Регрессии `netbird-devices-git.test.ts` используют настоящий Git в локальном временном репозитории
  с исполняемыми вредоносными config hooks/filters и hostile env/PATH: они не выполняются,
  index не переписывается, partial clone не запускает transport и не создаёт FETCH_HEAD.
- Root подтверждения явно показывают sudo/as root; mux_client_* diagnostics убраны из stderr
  и root/non-root streaming adapters, обычные ошибки сохраняются.
- `npm test`: **364 passed, 0 failed, 0 skipped**; Pi extension load повторён отдельно, без устройств
  пользователя. Коммит: `fix(netbird-devices): safe read-only git and root dialog polish`.
