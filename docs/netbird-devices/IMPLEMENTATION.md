# netbird-devices — план реализации

Источник требований: `docs/netbird-devices/PLAN.md` (читать целиком). Этот файл — разбивка на задачи,
порядок, интерфейсы, тесты и критерии готовности. Исполнители — Pi-агенты (Sonnet 5.5, thinking medium),
по очереди в одном workspace; коммит после каждого этапа в текущую ветку `extensions/netbird-devices`, **без пуша**.

Общие правила для всех этапов:
- Стиль и общие решения — как в `extensions/bitwarden-ssh.ts` и `extensions/bitwarden-ssh/` (диалоги, `withUILock`
  через `globalThis.__piSharedUiLock`, `secret-input.ts`, `exec.ts`, state/atomic write, тесты `test/bitwarden-ssh*.test.ts`).
- Pure-модули без импортов Pi (тестируются `node --test test/*.test.ts`, `node_modules` нет). Импорты Pi — только в
  entry `extensions/netbird-devices.ts` и, при необходимости, в тонких адаптерах.
- Перед работой с harness прочитать `docs/extensions.md` целиком, `docs/tui.md`, `docs/keybindings.md` и примеры
  `examples/extensions/{ssh.ts,gondolin/index.ts,tool-override.ts,permission-gate.ts,protected-paths.ts,plan-mode/}`
  (в `/home/orca/.local/lib/node_modules/@earendil-works/pi-coding-agent/`), плюс `dist/core/tools/{read,edit,write,bash}.js`
  и `renderers/edit.js`.
- На устройствах пользователя — только чтение и папка `~/pi-nb-test/` (см. §16 PLAN). Не печатать окружение целиком,
  не трогать `~/.ssh/pi-bitwarden/config`, сокет netbird и `bw`.
- `npm test` (`node --test test/*.test.ts`) зелёный в конце каждого этапа; новые тесты в `test/netbird-devices*.test.ts`.

## Правки к уже написанным модулям (этап A)

| # | Модуль | Проблема | Правка |
|---|---|---|---|
| 1 | `remote.ts` `rootStdinWrapper` | Если у пользователя `NOPASSWD`, sudo не читает пароль и он уходит в **stdin команды агента** (`sudo cat` → пароль в выводе → модели). | Команда под root запускается с `exec </dev/null` в начале (`/bin/bash -c 'exec </dev/null; <cmd>'`); то же в `rootNativeWrapper` и `bashWrapper` (stdin команды агента всегда пуст). Тест. |
| 2 | `policy.ts` `decide` | Read-only bash (`cat ~/.ssh/id_rsa`, `grep -r . ~/.aws`) обходит защищённые пути. | `decide` получает `protectedHit` и для bash: entry вычисляет его по словам команды (`protectedInCommand(command, home, globs)` — новый pure-хелпер: слова, похожие на путь, `~`/`$HOME` раскрыть, относительные — от cwd). Read-only команда с попаданием → `ask` с ⚠. |
| 3 | `policy.ts` `READ_ONLY`/`READ_ONLY_SUB` | Пишут файлы/исполняют: `sort -o`, `uniq IN OUT`, `xxd -r`, `base64 -o/-d … >`, `codesign -s/--sign`, `tree -o`, `rg --pre`, `git branch <name>`/`git remote add`/`git tag <name>`, `git diff --output`, `date -s`/`date <arg>`, `hostname <name>`, `mount <args>`, `env`/`printenv` (секреты устройства в контекст). | Убрать/ограничить: `sort`/`uniq`/`xxd`/`base64`/`tree`/`rg`/`codesign`/`date`/`hostname`/`mount` — через `READ_ONLY_SUB` с запретом опасных флагов/аргументов; git `branch` только `-a/-r/-l/--list/-v/--show-current`/без аргументов, `remote` только `-v`/`show`/`get-url`, без `--output`. `env`/`printenv` убрать из белого списка (→ ask). Тесты на каждый случай. |
| 4 | `policy.ts` `DANGER` | `rm -rf ~/*`, `rm -rf $HOME/*`, `rm -rf ~/ `-варианты не ловятся. | Расширить регэксп (`~/*`, `$HOME/*`, `"${HOME}"`). Тесты. |
| 5 | `policy.ts` `decide`/диалог | Для опасных команд `approved` даёт allow; PLAN §9: опасное — **всегда** спросить. | Опасное не кэшируется: `approved` игнорируется при `danger`; диалог для опасного не предлагает «Всегда разрешать»/«full». |
| 6 | `guard.ts` `NET_VERBS` | `/usr/bin/ssh host`, `command ssh`, `exec ssh` пропускаются (префикс `/`). | Разрешить `/` перед глаголом; добавить `localhost`/`127.0.0.1`/`::1` в self в entry. Тесты. |
| 7 | `presence.ts` `IDLE_PROBE` (Linux) | `IdleSinceHintMonotonic` сравнивается с `/proc/uptime` (BOOTTIME) — расходится после сна; `L_*` не сбрасываются между итерациями. | Использовать `IdleSinceHint` (realtime, µs) против `date +%s`; сбрасывать `L_*` в цикле. |
| 8 | `remote.ts` `bashWrapper`/обёртки | Несуществующий `cwd` молча → home. | `cd <cwd> || { echo "pi-nb: no such directory: <cwd>" >&2; exit 2; }`. |
| 9 | `remote.ts` `pathVariantsScript` | Нет NFC-варианта (модель может прислать NFD). | Добавить `path.normalize("NFC")` и комбинацию с U+202F. |
| 10 | `discovery.ts` | `parseListeningPorts` учитывает порты на `127.0.0.1` — не ошибка, но `inboundPeers` всё равно фильтрует по локальному IP; ок. Нужен pure-парсер `getent hosts` и вычисление собственных NetBird-адресов из `ip -o -4 addr show wt0`. | Добавить `parseGetentHosts(out)`, `parseIpAddr(out, iface)`. |
| 11 | `settings.ts` | Нет `localName`-фоллбэка и авто-алиасов. | Pure `resolveDevices(settings, peers)` → список устройств с алиасами (`mac`/`linux`, если одно такого типа; алиасы lower-case), `findDevice(name)`. Можно в новом `devices.ts`. |

## Этап A — фундамент (воркер 1)

Файлы: правки выше + новые pure-модули + тесты.

- `extensions/netbird-devices/state.ts` — `~/.pi/agent/netbird-devices/state.json` (0600, каталог 0700, атомарная запись,
  как `bitwarden-ssh/state.ts`). Схема:
  ```ts
  interface DeviceState { user?: string; userSource?: "settings"|"asked"|"detected"; probe?: ProbeInfo & { at: number }; }
  interface State { version: 1; devices: Record<string, DeviceState>; classifierModel?: string; hereChoice?: { device: string; at: number }; }
  loadState(file): { state; warning? }; saveState(file, state); emptyState();
  ```
- `extensions/netbird-devices/journal.ts` — pure: `JournalEntry` (`ts, session, device, user, tool, summary≤200,
  decision, ok, detail?, ms`), `formatEntry(e)`, `formatLog(entries, {device?, n})` (формат §11), `shouldRotate(size)`;
  I/O: `appendJournal(file, e)` (ротация в `log.1.jsonl` при > 2 МБ), `readJournal(file, n)`.
- `extensions/netbird-devices/ui-text.ts` — pure: `footerText(state)` (4 формы §11), `formatDeviceTable(rows, here)`
  (формат §6 `devices list`), `confirmTitle/confirmBody(action, device, decision)`, `lineDiff` (можно реэкспорт/копия
  из bitwarden-ssh/ui-text.ts), `displayPath(device, abs, home)` → `mac:~/x`, `truncate`.
- `extensions/netbird-devices/devices.ts` — pure: `Device` (`name, peer, fqdn?, ips, sshEnabled, aliases, settings`),
  `buildDevices(settings, peers, localNames)`, `findDevice(devices, query)` (имя/алиас/peer/fqdn/ip, регистр не важен),
  `userCandidates(peerName, configured, cached, vmUser)` (§4.3: `sergeys-macbook-pro` → `sergey`, `sergeys`; root никогда).
- `extensions/netbird-devices/ssh.ts` — транспорт (Node `child_process.spawn`, без shell, **без импортов Pi**):
  ```ts
  sshArgs(t: Target, paths): string[]           // §5 Транспорт; -F /dev/null, BatchMode, ControlMaster/Path/Persist,
                                                // accept-new, UserKnownHostsFile, HostKeyAlias=<fqdn|peer>, -p port
  exec(t, script, { stdin?: Buffer|string, signal?, timeoutMs?, onData?(chunk) }): Promise<{ code, stdout: Buffer, stderr, signal? }>
  classifyError(r): "auth" | "hostkey-changed" | "jwt-required" | "timeout" | "unreachable" | undefined   // pure, тест
  probe(t), readFile(t, abs): Buffer, writeFile(t, abs, data) (через stdin: mkdir -p dirname; cat > tmp; mv),
  access(t, abs, mode), stat/isDirectory, resolveVariant(t, path) (pathVariantsScript), idle(t) (IDLE_PROBE)
  checkPort(ip, port, timeoutMs) (net.connect), detectUser(t candidates) — перебор кандидатов, затем console user.
  ```
  ControlPath: `~/.pi/agent/netbird-devices/cm/%C` (проверить длину < 100 как в `bitwarden-ssh/paths.ts`).
  JWT-баннер (`NetBird-JWT-Required`) → понятная ошибка (PLAN §4.2).
- Тесты: `test/netbird-devices.test.ts` — все pure-модули (settings, discovery, policy, guard, presence, classifier,
  remote-скрипты (по возможности прогон `sh -n`/реальный `/bin/sh` для `bashWrapper` локально), state, journal, ui-text,
  devices, `sshArgs`, `classifyError`). `ssh.ts` exec — тест с фейковым `ssh` в PATH или параметром `sshBin`.

Готово, когда: все правки 1–11 сделаны с тестами; новые модули есть; `npm test` зелёный; коммит
`feat(netbird-devices): foundation modules and tests`.

### Этап A — выполнено: уточнения и отклонения от описания выше

Правки 1–11 сделаны, каждая с регресс-тестом в `test/netbird-devices.test.ts`. Фактические интерфейсы:

- **Новый `paths.ts`** (не был в списке): `resolvePaths({agentDir, uid})` → `{dataDir, stateFile, knownHosts, journalFile, cmDir}`;
  `cmDir` падает на `/tmp/pi-nb-<uid>/cm`, если сокет не влезает в 100 байт. `ensureDir` — реэкспорт из `bitwarden-ssh/paths.ts`.
- **`ssh.ts`**: `sshArgs(t)`/`exec(t, script, opts)` принимают один `Target = {user, host, port?, hostKeyAlias?, paths: {knownHosts, cmDir}, sshBin?, connectTimeout?}`
  (пути и `sshBin` внутри `Target`, а не отдельным аргументом). `exec` не бросает: возвращает `{code, stdout: Buffer, stderr, signal?, timedOut?, aborted?, truncated?, spawnError?}`
  (`onData(chunk, "stdout"|"stderr")`, `maxBytes` по умолчанию 32 МБ). Остальные операции бросают `SshError {kind?, code?}`:
  `kind` — `"auth"|"hostkey-changed"|"jwt-required"|"timeout"|"unreachable"`, `code` — `ENOENT/EACCES/EISDIR` для файловых.
  `assertConnected(result, device, user)` превращает ошибки соединения в `SshError`; `describeError(kind, device, user)` — текст для агента/пользователя.
  Операции: `probe`, `readFile`, `writeFile` (stdin; атомарно через tmp+mv, режим сохраняется, симлинк пишется по месту, родители создаются; новый файл — `cat >` с umask),
  `writeScript`, `access(t, abs, "r"|"w"|"rw")` (бросает), `stat` → `"file"|"dir"|"other"|"none"`, `isDirectory`, `resolveVariant`, `idle`, `checkPort`,
  `detectUser(baseTarget, candidates, deviceName)` → `{user, probe, switchedToConsole, tried}` (бросает `SshError("auth")`, если никто не подошёл).
  `classifyError` классифицирует только выход 255 (или `timedOut`): ошибки самой удалённой команды не считаются ошибками соединения.
  Шум `Warning: Permanently added …` вырезается из stderr. `user`/`host`/`hostKeyAlias` валидируются (защита от инъекции опций ssh), после `--` идёт `user@host` и скрипт одним аргументом.
- **`state.ts`**: схема как в описании; `loadState` отбрасывает битые поля; использует `writeFileAtomic` из `bitwarden-ssh/state.ts`.
- **`journal.ts`**: помимо описанного — `cleanSummary`, `clock`, `decisionLabel`, `rotatedName`; `formatLog` выравнивает колонки. Метки решений в русском виде, как в PLAN §11
  (`asked→allowed` → «спросил → разрешено», `denied` → «отклонено»); длительность показывается для `bash`/`sudo` от 100 мс. `appendJournal` бросает при I/O-ошибке — вызывающий решает, глушить ли.
- **`ui-text.ts`**: `footerText({kind:"local",name} | {kind:"remote",device,mode,waiting?})` (строки футера — как в PLAN §11, по-русски);
  `formatDeviceTable(rows, here)`; `confirmTitle/Body(action, device, decision, home?)`; **`confirmOptions(action, device, decision)`** → `[{id:"once"|"always"|"full"|"deny", label}]`
  (для `decision.danger` только `once`/`deny`; подписи кнопок — как в PLAN §9, по-русски); `displayPath`, `formatBytes`, `actionSummary`; `lineDiff`/`truncate` — реэкспорт из `bitwarden-ssh/ui-text.ts`.
- **`devices.ts`**: `buildDevices(settings, peers, localNames, osHints?)` (`osHints` — ОС из probe-кэша для авто-алиасов `mac`/`linux`; пиры, чьи имя/FQDN/IP в `localNames`, исключаются),
  `findDevice`, `deviceNames` (для `guard`), `userFromPeerName`, `userCandidates(peerName, configured?, cached?, vmUser?)`. Поле `Device.connected` — из API.
- **`policy.ts`**: `Decision.danger?: boolean`; `protectedInCommand(command, home, globs, cwd?)` (отслеживает `cd`, `~`/`$HOME`/`${HOME}`, `--opt=path`, редиректы; best effort — глобы внутри слова не раскрываются);
  `rmRecursiveOfRoot` (разбор слов вместо регэкспа, рекурсивно заходит в `sh -c '…'`). `READ_ONLY_FN` — проверки аргументов функциями.
  Сверх таблицы: `command` разрешён только как `command -v/-V` (`command rm` исполнял), ограничены `ifconfig`/`dmesg`/`scutil`/`networksetup`, `awk` с `|`/`getline`/`-i`;
  `2>&1` больше не считается фоновым заданием; bash-команда (в т.ч. root) с попаданием в защищённый путь спрашивается в любом режиме (в `full` тоже), а не только read-only.
  `base64 -d` оставлен разрешённым (вывод только в stdout; запись через `>` ловится общей проверкой редиректов).
- **`guard.ts`**: loopback (`localhost`, `127.0.0.1`, `::1`) игнорируется прямо в `deviceTargetInCommand`, а не только через `self` в entry.
- **Окружение тестов**: старые тесты (`ask-user-question-ui`, `code-fence-hide`, `image-paste-markers`) импортируют `@earendil-works/pi-tui`, которого нет без `node_modules`.
  Для зелёного `npm test` в workspace создан (в `.gitignore`, не коммитится) каталог `node_modules/@earendil-works/` с симлинками на глобальные пакеты Pi
  (`pi-coding-agent` и `pi-coding-agent/node_modules/@earendil-works/pi-tui`). Без него эти три файла падают независимо от этой работы; 7 тестов bitwarden-ssh при этом остаются `skip`.
- Тесты: `test/netbird-devices.test.ts` (pure-модули, скрипты прогоняются реальным `/bin/sh`), `test/netbird-devices-ssh.test.ts` (`ssh.ts` с фейковым `ssh` через `sshBin`, он запускает скрипт локально).

## Этап B — entry, устройства, «где», футер, блок ssh, удалённые инструменты (воркер 2)

`extensions/netbird-devices.ts`:
- Загрузка настроек (`netbirdDevices` из `~/.pi/agent/settings.json`, предупреждения через `ctx.ui.notify`), state,
  api-ключ `netbird` из `~/.pi/agent/api-keys.json` (строка или пул как у tavily) → `GET {apiUrl}/api/peers` с
  `Authorization: Token …`, таймаут 5 с, ошибки — тихо в список предупреждений.
- Discovery: `99-netbird.conf` + API + `getent hosts` + `ss -tlnH`/`ss -tnH state established` + свои IP из `wt0`;
  online = порт открыт (`checkPort`, 1.5 с, параллельно) или API `connected`. Кэш ~60 с, `/nb refresh`.
- «Где» (§7): `resolveHere` + idle по запросу + выбор `ctx.ui.select` (под UI-локом), запоминание 30 мин в state.
- Футер `setStatus("netbird-devices", footerText…)`; возврат к `⌂ <local>` через ~8 с после `agent_settled`.
- Инструмент `devices` (`list`, `here`) — компактный текст §6.
- `tool_call` для `bash` без `device` → `guard.deviceTargetInCommand` → `{ block: true, reason: 'use device: "mac"' }`.
- Переопределение `read/write/edit/bash`: схема встроенного + `device?: string`; без `device`/локальное имя → встроенная
  локальная реализация без изменений. С `device` → `create*ToolDefinition(home, { operations })` с операциями из `ssh.ts`,
  пути заранее через `resolveRemotePath` (и `resolveVariant` для read при ENOENT). `bash` — `bashWrapper` с PATH из probe;
  стриминг вывода, отмена по `signal`. Рендер: `mac:~/path`, `$ [mac] cmd`; у `edit` превью не читает локальный файл.
  Пользователь: §4.3 (`detectUser`, спросить один раз через `ctx.ui.input`, сохранить в state).
- `promptGuidelines` 1–2 строки (§6). Системный промпт не менять динамически.
- На этом этапе **без** подтверждений: все удалённые write/edit/bash работают как в `full`, но только если
  `mode === "full"`; иначе — ошибка «confirmations arrive in stage C» (чтобы не было небезопасного промежуточного состояния).
  Read разрешён (кроме защищённых путей — пока отказ).
- `/nb`, `/nb here`, `/nb refresh`, `/nb user`, `/nb forget` с автодополнением.

Готово, когда: `pi -e ./extensions/netbird-devices.ts` грузится без ошибок (проверка в tmux/print-режиме); на Mac
`devices list`, `here`, `read` файла/картинки из `~/pi-nb-test/`, `bash` `ls ~/pi-nb-test` работают; блок
`ssh sergeys-macbook-pro` в bash; тесты зелёные; коммит.

## Этап C — режимы, диалоги, защищённые пути, классификатор (воркер 3)

- Режим на устройство: settings → `defaultMode`; переопределение в сессии `pi.appendEntry("netbird-devices-mode", …)`,
  восстановление из `sessionManager.getBranch()` на `session_start`/`session_tree`. `/nb mode [device] [mode]`,
  `alt+m` (проверить по `docs/keybindings.md`, что не занята) — по кругу для текущего устройства.
- `decide()` перед каждым удалённым действием; `edit/write` — подтверждение внутри `writeFile` операций (точный дифф;
  `mkdir` после подтверждения). Диалог `ctx.ui.select` под `__piSharedUiLock`: Разрешить один раз / Всегда (путь|команда)
  в сессии / Переключить <device> в full / Отклонить (для опасного — только 1 и 4). Без UI → отказ с причиной.
  Футер `⏸ ждёт тебя`. Диалоги закрываются на `session_shutdown` (AbortController как в bitwarden-ssh).
- Классификатор (§10): модель из state → settings; `/nb classifier` (выбор из `ctx.modelRegistry.getAvailable()`),
  `streamSimple`, maxTokens ~300, таймаут 20 с; сообщения пользователя из `getBranch()`; кэш по `approvalKey`;
  3 deny подряд → следующий сразу пользователю; ошибка → `ask`; usage добавить к результату.

Готово: unit-тесты логики режимов/кэша одобрений (вынести в pure `session-policy.ts`); ручная проверка на Mac в
`~/pi-nb-test/`: `ask` → диалог с диффом, `ro` → отказ, `auto` → классификатор; коммит.

## Этап D — root, журнал, README, финальная проверка (воркер 4)

- Root (§8): `splitSudo`; `rootPrompt` auto/native/pi; нативный путь `rootNativeWrapper`, 196 → окно Pi
  (`askSecret`, только TUI), 197 → «отменено пользователем»; путь Pi — `rootStdinWrapper`, пароль только в stdin.
  Футер `🔑 пароль root`. `/nb test-root <device>` (`sudo -k -A true`).
- Журнал: запись каждого удалённого действия (`journal.ts`), `/nb log [device] [n]`.
- README: раздел расширения (настройки, команды, модель безопасности §4 — кратко и честно).
- Проверка §16 на Mac (пользователь за Mac, согласие на системное окно дано).

Готово: всё из §16 пройдено (кроме Linux), тесты зелёные, коммит.

## Тест-план (сводно)

Unit (`node --test`): все pure-модули, включая регресс-кейсы из таблицы правок. Ручной (§16 PLAN) — на Mac, папка
`~/pi-nb-test/`; Linux-ветка не проверяется (компьютера нет в NetBird SSH).

## Риски

- API Pi для переопределения встроенных инструментов/рендера может отличаться от ожиданий → сверяться с `dist/`.
- `ControlMaster` + NetBird SSH: если мультиплексирование не поддерживается сервером — фоллбэк без него.
- System Events Automation на macOS может быть запрещён → путь Pi.
- Прерывание удалённых команд без tty (PLAN §4.9).
