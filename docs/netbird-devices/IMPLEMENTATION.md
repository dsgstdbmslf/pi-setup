# netbird-devices — план реализации

Актуальные изменения после независимого ревью: раздел «Ревью» в конце этого файла и `REVIEW.md`.
Они уточняют исторические описания этапов ниже (в частности, белый список bash и NOPASSWD).

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

### Этап B — выполнено: уточнения и отклонения

Файлы: `extensions/netbird-devices.ts` (entry), `extensions/netbird-devices/{hub,tools,remote-ops}.ts`; тесты
`test/netbird-devices-{hub,tools}.test.ts` и хелпер `test/netbird-devices-fake-ssh.ts` (фейковый `ssh`, принимает только заданных пользователей).

- **`hub.ts`** (без импортов Pi, все внешние зависимости подменяются): `new Hub({paths, settings, vmUser, sshBin, hostname, confFile, run, apiToken, fetchPeers, checkPort, now})`.
  `refresh(force?)` (кэш 60 с: `99-netbird.conf` + API + `ip addr show wt0` + `getent hosts` + `ss -tlnH`/`ss -tnH state established`; входящие пиры, которых нет в списке SSH,
  получают имя через `getent` и `sshEnabled: false`), `devices()` (работает и до `refresh`: синхронно читает drop-in), `localNames()`/`localLabel()`/`domains()`,
  `modeOf(d)` (settings → `defaultMode`; переопределение в сессии — этап C), `protectedGlobs(d)`, `online(devices)` (порт SSH 1.5 с параллельно или API `connected`),
  `inboundDevices`, `connect(d, {ask})` → `Conn` (общий для параллельных вызовов; пользователь: settings → спросили раньше → автоопределение `detectUser`; кэш probe в памяти и в `state.json`:
  30 мин для автоопределённого пользователя, 24 ч для заданного; `ask` вызывается один раз, если никто не подошёл), `setUser`, `forget` (закрывает ControlMaster всех возможных пользователей,
  удаляет ключ хоста и кэш), `closeAll`, `resolveHere(pinned?)` (закрепление → входящие → idle → недавний выбор) и `rememberHere`.
- **`remote-ops.ts`**: операции для `create{Read,Write,Edit,Bash}ToolDefinition(cwd, {operations})` поверх `ssh.ts`. `Conn = {device, target, user, home, probe}`. Варианты имён (U+202F, NFD/NFC, кавычки)
  подбираются в `access` при ENOENT (один дополнительный вызов только при промахе), реальное имя запоминается на время вызова и проходит `check` (защищённые пути). Картинка определяется по расширению
  (без обращения к устройству). `mkdir` у write — no-op: каталоги создаёт сам скрипт записи (отказ в подтверждении не оставит каталог). `bash`: `bashWrapper` (cwd = home устройства, локальный cwd
  игнорируется), стриминг stdout/stderr, таймаут `timeout:<сек>` (по умолчанию 30 мин), `aborted`, лимит вывода 64 МБ.
- **`tools.ts`** (pure): `parseDeviceArg` (пусто/имя этой машины/`local` → локально, `here`, имя/алиас/peer/FQDN/IP; ошибка со списком известных устройств), `isRemoteArg`,
  **`remoteGate`** (временный шлюз этапа B, см. ниже), `displayArgs` (рендер), `imageMimeFromPath`, `osLabel`, `deviceRows`, `guardReason`.
- **Шлюз этапа B (`remoteGate`)**: `read` — всегда, кроме защищённых путей (отказ); `write`/`edit`/`bash` — только при режиме устройства `full` (**в том числе чтение-только команды bash**, как в задаче),
  и даже в `full` отказ для защищённых путей, опасных команд (`decide` → ask) и команд, начинающихся с `sudo` (этап D). Режим пока можно задать только в `settings.json`
  (`netbirdDevices.devices.<name>.mode` / `defaultMode`); `/nb mode` и диалоги — этап C. Для проверок можно положить `.pi/settings.json` с настройкой в каталог проекта и запускать `pi -a` (trust проекта).
- **Entry**: переопределение `read/write/edit/bash` — `{...create*ToolDefinition(cwd), parameters: Type.Object({...properties, device?}), execute, renderCall, renderResult}`: без `device`/с локальным именем
  вызывается `execute` встроенного определения без изменений; с `device` путь заранее разворачивается `resolveRemotePath(path, home)` и вызывается встроенное определение с удалёнными `operations`
  (`exposeSessionEnvironment: false` у bash). Остальное (`prepareArguments` у edit, `outputSchema`, промпт-сниппеты) наследуется из встроенных определений.
  Рендер: `renderCall`/`renderResult` делегируют встроенным, подставляя `context.args` из `displayArgs` (`mac:~/x`, `[mac] ls`; у edit `edits` убраны, чтобы встроенное превью не читало локальный файл
  с тем же путём — дифф берётся из `details.diff` результата). Инструмент `devices` (`list`/`here`, `promptSnippet` + 2 `promptGuidelines`), блок ssh/scp/curl… к устройствам в `tool_call` bash без `device`,
  футер (`⌂ cloudcli` ↔ `→ mac · full`, возврат через 8 с после `agent_settled`), `/nb [list] | here [device|auto] | refresh | user <device> <user|auto> | forget <device>` с автодополнением,
  закрытие диалогов на `session_shutdown`, закрытие ControlMaster при `quit`. API-токен читается `loadKeys(api-keys.json, "netbird")` из `tavily/keys.ts`.
- **Изменения модулей этапа A**: `ssh.ts` — добавлен `stopMaster(t)` (`ssh -O exit`), `stripSshNoise` вырезает ещё и `ControlSocket … already exists, disabling multiplexing` (гонка параллельных первых вызовов);
  `tools.ts`/`hub.ts` — новые. Остальные интерфейсы не менялись.
- **Известные ограничения**: чтение текстовых файлов целиком через `cat` (до 32 МБ, без `createReadStream`); порядок `tool_call`-обработчиков: если `bitwarden-ssh` загружен раньше, он может открыть окно
  «Load SSH key?» до того, как наш блок отклонит команду; `.pi/settings.json` доверенного проекта может задавать режим устройства (граница — trust проекта).

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

### Этап C — выполнено: интерфейсы, отклонения, ограничения

Файлы: `extensions/netbird-devices.ts` (entry), новый `extensions/netbird-devices/session-policy.ts`; правки `remote-ops.ts`, `tools.ts`, `classifier.ts`, `settings.ts`;
тесты `test/netbird-devices-session.test.ts` (+ правки `netbird-devices-tools.test.ts`).

- **`session-policy.ts`** (pure): `SessionPolicy` — режимы сессии (`modeFor/setMode/overridden/restoreModes(entries)`; `MODE_ENTRY = "netbird-devices-mode"`, данные `{device, mode}`,
  последнее по устройству побеждает, восстановление с нуля из `getBranch()`), одобрения «всегда» (`isApproved/approve`, ключ — `policy.approvalKey`), кэш вердиктов классификатора, серия deny.
  `authorize({device, label, baseMode, action, protectedHit, cacheSalt, ask?, classify?, onModeChange?})` → `{ok:true, how, classifier?}` | `{ok:false, how, message, classifier?}`: `decide()` →
  allow / deny (сообщение агенту) / classify (кэш → серия ≥3 → `classify()`; `undefined`/исключение → ask) / ask (`ask` undefined = нет UI → отказ с причиной; `deny`/закрытый диалог → «denied by user»).
  `always` не применяется к опасному, `full` тоже (и опасное не кэшируется — `decide` игнорирует `approved`). После вопроса пользователю серия deny обнуляется. `nextMode` — цикл ro→ask→auto→full.
  Кэш классификатора для write включает sha256 содержимого (`cacheSalt`), а не только путь.
- **`tools.ts`**: `remoteGate` и `STAGE_C_NOTE` удалены. Вместо них `remoteAction(input)` → `{action, protectedHit}` (`sudo cmd` → root-действие для `cmd`; для bash защищённые пути — `protectedInCommand`) и
  `earlyRefusal(input, mode, device)` — отказы без диалога (write/edit/root в `ro`; root пока всегда отказ: этап D — `decide` для root вызывается, поэтому `ro` даёт «read-only», остальное «not implemented yet (stage D)»).
- **`remote-ops.ts`**: `createWriteOps(c, before?)`/`createEditOps(c, before?)` с хуком `BeforeWrite({path, content, old?, isNew})`, вызываемым перед записью (бросает → ничего не пишется, каталоги не создаются);
  у write старое содержимое читается отдельным `readFile` (ENOENT → `isNew`), у edit берётся из `readFile` инструмента. `createReadOps(c, check)` — `check` может быть async (проверка найденного варианта имени).
- **Entry**: вызов `authorize` перед каждым удалённым read/bash и в хуке `writeFile`; `early()` до чтения/записи. Диалог `confirm`: `ctx.ui.select(заголовок+дифф/команда+причина, варианты из `confirmOptions`)` под `withUILock`,
  сигнал = `session_shutdown` + сигнал вызова инструмента (`AbortSignal.any`), футер `→ mac · ask · ⏸ ждёт тебя` пока открыт. Для защищённых путей вариант «full» убран (full их не снимает). Режим «full» из диалога
  и `/nb mode` сохраняются `pi.appendEntry("netbird-devices-mode", {device, mode})`; `session_start`/`session_tree` восстанавливают из `getBranch()`; при новой сессии (не reload) одобрения и кэш сбрасываются.
- **Режимы**: `/nb mode [device] [ro|ask|auto|full]` (без аргументов — `ui.select`: устройство, если текущее неизвестно; затем режим; `/nb mode ro` — для текущего), `alt+m` (`registerShortcut`; в `keybindings.md`
  и в других расширениях репо не занята) — по кругу для текущего устройства = последнее, с которым работал агент, иначе «here» (без окна выбора). Агент менять режимы не может (инструмента нет).
  Устройство в записях — `Device.name` (например `sergeys-macbook-pro`, не алиас).
- **Безопасность настроек**: `settings.loadGlobalSettings(file)` читает `netbirdDevices` только из `~/.pi/agent/settings.json`; `pi.getSettings()` (сливает проектный `.pi/settings.json`) больше не используется
  (тест-страж по исходнику entry + тест загрузчика). Режимы/protected/rootPrompt/defaultMode/classifierModel из проекта не действуют. Известное отличие: `getAgentDir()` учитывает `PI_CODING_AGENT_DIR`.
- **Классификатор**: модель `state.classifierModel` → `settings.classifierModel`; `modelRegistry.find(provider, id)` + `modelRegistry.streamSimple(model, {systemPrompt, messages:[user]}, {maxTokens: 300, signal})`,
  `await stream.result()`; таймаут 20 с (+ отмена вызова и `session_shutdown`); `stopReason` error/aborted, нет модели, непарсящийся ответ → `undefined` → ask. Вход: `classifier.ts` `buildClassifierPrompt` + новый
  `userMessagesFromBranch(getBranch(), 8)` (только `role:"user"`, без ответов ассистента и вывода инструментов). `usage` каждого вызова — в `details.netbirdClassifier[]` результата инструмента
  (`{decision, reason, model, usage}`; при бросающем инструменте теряется). `/nb classifier [provider/model|default]` (без аргумента — выбор из `getAvailable()`; `default` — вернуть настройку), хранится в `state.json`.
- **Отклонения/ограничения**: `usage` классификатора только в `details`, в итоги сессии Pi сам не суммируется; для `write` старый файл читается целиком для диффа (большой/бинарный файл — дифф сводкой); в `edit`
  локальный предпросмотр у Pi берёт дифф из `details.diff` после выполнения; режим `full` из диалога сохраняется в сессии и поэтому возвращается при `--resume` (как и обычный `/nb mode`); диалог показывает до 3000 символов диффа
  (`lineDiff` ≤ 40 строк, остальное свёрнуто); причина классификатора обрезана до 200 символов; журнал (`journal.ts`) пока не подключён — этап D.
- **Ручная проверка** (Mac, `~/pi-nb-test/`, `pi -ne -e ./extensions/netbird-devices.ts`): `ask` write/edit → диалог с диффом, «Отклонить» → «denied by user», файл не изменён; `bash cat` без диалога;
  `alt+m` ask→auto→full→ro, футер `→ mac · auto`…; `ro` → write отклонён; `/nb mode` → окно выбора; `auto` → классификатор `anthropic/claude-haiku-5-5` разрешил явную просьбу (usage в details сессии),
  противоречивую — вернул ask → диалог; `--resume` восстановил режим из сессии; `/nb classifier` — список 457 моделей, сохранение/сброс в `state.json`.

## Этап D — root, журнал, README, финальная проверка (воркер 4)

- Root (§8): `splitSudo`; `rootPrompt` auto/native/pi; нативный путь `rootNativeWrapper`, 196 → окно Pi
  (`askSecret`, только TUI), 197 → «отменено пользователем»; путь Pi — `rootStdinWrapper`, пароль только в stdin.
  Футер `🔑 пароль root`. `/nb test-root <device>` (`sudo -k -A true`).
- Журнал: запись каждого удалённого действия (`journal.ts`), `/nb log [device] [n]`.
- README: раздел расширения (настройки, команды, модель безопасности §4 — кратко и честно).
- Проверка §16 на Mac (пользователь за Mac, согласие на системное окно дано).

Готово: всё из §16 пройдено (кроме Linux), тесты зелёные, коммит.

### Этап D — выполнено: интерфейсы, проверка, ограничения

Файлы: новый `extensions/netbird-devices/root.ts`, правки `extensions/netbird-devices.ts`, `tools.ts` (убран временный отказ root в `earlyRefusal`),
`extensions/bitwarden-ssh.ts` (только `blockedElsewhere` + одна проверка в `tool_call`), `README.md`; тесты `test/netbird-devices-root.test.ts`, дополнение `test/bitwarden-ssh-load.test.ts`.

- **`root.ts`** (без Pi): `chooseRootPath(pref, userIsAtDevice)`, `runRoot(conn, {command, pref, userIsAtDevice, from, askPassword, onWaiting, signal, timeoutMs, onData, run?})` →
  `{exitCode, path: "native"|"pi"|"native→pi"}`; `RootCancelled` (197 → «cancelled by the user on <device>»; пустой пароль/отмена в Pi). 196 → окно Pi (при `rootPrompt: "native"` — ошибка).
  Пароль только в `stdin` ssh для `rootStdinWrapper` (`Buffer`, обнуляется `fill(0)` после вызова; строка в замыкании обнуляется), не логируется и не возвращается; без TUI `askPassword` бросает `SECRET_INPUT_NEEDS_TUI`.
  `testRoot` — `sudo -k -A true` тем же путём. Нативный вызов живёт ≥150 с (окно ждёт 120 с).
- **Entry**: `bash` с `sudo <cmd>` (`splitSudo`) → `decide` (root) → `createRootOps` (подменяет операции bash), `userIsAt` (`resolveHere` без вопросов: «активно» = устройство найдено как here) выбирает native/pi при `auto`.
  Футер `🔑 пароль root` на время вызова. `/nb test-root <device>`, `/nb log [device] [n]` (по умолчанию 20).
- **Журнал**: `journaled(...)` оборачивает каждый удалённый read/write/edit/bash/sudo: устройство (короткое имя), пользователь, инструмент, путь/команда ≤200, решение (`auto`/`approved`/`asked→allowed`/`asked→denied`/`classifier:*`/`denied`),
  результат (`✓/✗`, `exit N`, `+a −b`, размер записи), длительность. Содержимое, вывод и пароли не пишутся; для ошибок вывода команды не сохраняется (только код выхода). Ошибка записи журнала — один `notify`, дальше тихо.
- **Координация с bitwarden-ssh**: entry публикует `globalThis.__piNetbirdDevicesGuard(command, device?) → string|undefined` (та же проверка, что и блок в `tool_call`; снимается на `session_shutdown`);
  `bitwarden-ssh` перед «Load SSH key?» вызывает её и пропускает команду, которую netbird-devices заблокирует. Тест в `bitwarden-ssh-load.test.ts` (проверяет, что функция опрашивается и окна нет;
  `ssh -G` читает passwd-home, поэтому положительный контроль «окно открывается» в песочнице невозможен).
- **Окружение**: для e2e-тестов bitwarden-ssh в `node_modules` (в `.gitignore`) добавлен симлинк `typebox` (без него 7 тестов были `skip`); с ним `npm test` выполняет все тесты.
- **Проверка §16 на Mac (sergeys-macbook-pro, `pi -ne -e bitwarden-ssh.ts -e netbird-devices.ts` в tmux)**: `/nb` и `devices list` — mac online, iphone/ipad/nl offline; `here` → mac;
  `bash device:"here"` `ls` — работает; `read` `device:"here"` `~/pi-nb-test/red.png` — картинка прочитана («red»); `edit` в `ask` — диалог с диффом, «Разрешить один раз» → записано;
  `/nb test-root mac` — нативное окно macOS, пароль введён → «root works on mac (password dialog: native)»; `bash` `sudo true` (device mac) — окно, exit 0 за 11 с; `bash` `ssh sergeys-macbook-pro true` без device — блок с подсказкой.
  `/nb log` показал все действия; в `log.jsonl` нет паролей. Ветка отмены (197) и путь Pi проверены только юнит-тестами.
- **Известное**: путь Pi (`rootPrompt: "pi"`) на устройстве не проверялся вживую; «Load SSH key?» от bitwarden-ssh вживую не проверялся (хранилище было залочено, ключей нет) — только тестом; Linux-окна не проверялись.

## Тест-план (сводно)

Unit (`node --test`): все pure-модули, включая регресс-кейсы из таблицы правок. Ручной (§16 PLAN) — на Mac, папка
`~/pi-nb-test/`; Linux-ветка не проверяется (компьютера нет в NetBird SSH).

## Риски

- API Pi для переопределения встроенных инструментов/рендера может отличаться от ожиданий → сверяться с `dist/`.
- `ControlMaster` + NetBird SSH: если мультиплексирование не поддерживается сервером — фоллбэк без него.
- System Events Automation на macOS может быть запрещён → путь Pi.
- Прерывание удалённых команд без tty (PLAN §4.9).

## Ревью — исправления безопасности и корректности

- `SessionPolicy`: одобрения и кэш ограничены устройством и endpoint/login/home; кэш классификатора
  дополнительно учитывает последние сообщения пользователя, выбранную модель и хэш содержимого записи.
  Неполный preview команды/диффа → вопрос пользователю, не `allow` по видимому префиксу.
- `policy.ts`: read-only shell теперь консервативен: без `sed`/`awk`/`find`, Git (в т.ч. fsmonitor,
  external diff и pager из config), package managers, `journalctl`/`dmesg`/`spctl`/`pmset`; неизвестные
  expansion, назначения окружения, произвольный executable с именем `cat`/`ls` и похожие редиректы
  не проходят. Динамические пути и рекурсивный поиск содержимого считаются возможным защищённым доступом.
- Пути сравниваются с case folding + NFC + dot normalization; glob `**` покрывает переводы строк.
  `ssh.canonicalPath()` проверяет symlink файла/родителей (в т.ч. нового файла и буквальных аргументов
  bash); >8 shell-путей → вопрос вместо пропуска проверок, ошибки разрешения — отказ.
  Проверка находится на фактическом пути операций Pi после их нормализации; `edit` отдельно проверяет
  чтение перед построением диффа. Остаточные ограничения: TOCTOU, hard links, mount aliases, обратные
  алиасы symlink-защищённых каталогов и произвольные программы bash; это не файловая песочница.
- Root: wrapper вызывает `/usr/bin/sudo`, askpass использует только системный PATH, а не writable
  login PATH (иначе подменённый `sudo` мог бы прочитать/вывести пароль). `ask` дополнительно
  подтверждает команду, т.к. `NOPASSWD` может вовсе не вызвать askpass.
  Без UI отказ до запуска; Pi-пароль в одном обнуляемом Buffer без дополнительной строки `password + newline`.
  Pre-abort и abort после диалога не запускают ssh; timeout/abort native не вызывают fallback.
  Реальный код команды 196/197 переводится в 1, чтобы не принять его за статус диалога и не запустить
  действие повторно. chmod helper — fail closed; EXIT/HUP/INT/TERM очищают приватный каталог.
  Linux kdialog/ssh-askpass требуют `timeout`, иначе 196 → Pi (zenity имеет собственный timeout).
- Любой `session_shutdown`, включая reload/new/resume/fork, отменяет диалоги/операции и закрывает
  ControlMaster; hub отслеживает probe-пользователей и ждёт уже начатые подключения. Namespace
  ControlPath уникален на runtime, с фиксированным 40-символьным хэшем: чужая сессия не закрывается.
  SSH проверяет приватного владельца cm-родителя и known_hosts (0600); вспомогательные таймеры очищаются.
  Ограничение вывода применяется к stdout+stderr до стриминга/записи локального временного файла.
- Журнал учитывает `isError` и реальный `structuredContent.exit_code` (не пишет `✓ exit 0` при exit 3).
  Локальные read/write/edit/bash по-прежнему напрямую делегируют встроенным определениям Pi.
- Тесты загружают `test/isolated-env.ts`: удаляются askpass/agent/display/BW-секреты, startup ENV/BASH_ENV
  и унаследованный sudo shim из PATH; `SSH_ASKPASS_REQUIRE=never`. В bitwarden entry e2e `ssh -G` без
  `-F` принудительно использует fixture config, а не passwd-home с настоящими `Match exec`.
- Новые регрессии: `test/netbird-devices-{review,entry}.test.ts`; дополнены hub/session/tools/root
  и bitwarden load/integration тесты. Никаких подключений к устройствам пользователя при ревью.

### Follow-up после Mac smoke

- `safe-git.ts`: один строгий parser используется политикой и переписыванием исполнения для
  `status/log/diff/show/branch` (только listing flags)/`rev-parse/ls-files`, с глобальным `-C`.
  Только одна простая команда; неизвестные/сокращённые опции, `-c`, `--output`, helpers, pipelines
  не проходят. Разрешённый вызов **всегда** переписывается в bash/root operations, сырой Git не запускается.
- `/usr/bin/env -i` → `/usr/bin/git --no-pager --no-optional-locks` с явными config overrides:
  fsmonitor/pager/hooks/external diff/textconv/credentials/signatures/submodules/maintenance отключены,
  global/system config и унаследованные GIT_EXTERNAL_DIFF/GIT_PAGER/PAGER/askpass/trace не используются,
  сеть запрещена через GIT_ALLOW_PROTOCOL, lazy fetch отключён. `git config` читает только имена
  filter.* keys с NUL-разделителями; clean/smudge/process/required принудительно отключаются,
  ошибки парсинга конфигурации — fail closed. Это закрывает clean/process filters, которые иначе
  выполняются даже в status/diff с `--no-textconv`.
- Подтверждения root в Pi явно показывают `sudo <cmd>`/`as root`; stripSshNoise и оба stream adapters
  удаляют `mux_client_*:` diagnostics (включая Broken pipe), сохраняя обычный stderr.
- `test/netbird-devices-git.test.ts`: policy/rewrite cases, реальный Git во временном репозитории
  с вредоносными pager/fsmonitor/diff/textconv/filter/credential settings, hostile env/PATH,
  отсутствие index writes, реальный remote-ops adapter и fake root stream; без устройств пользователя.
