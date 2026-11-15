# Hand-off: планирование постройки расширения netbird-devices

## Твоя роль
Ты — агент-планировщик. Задача: превратить `docs/netbird-devices/PLAN.md` в детальный пошаговый план реализации
(задачи, порядок, интерфейсы модулей, тест-кейсы, критерии готовности, риски) и согласовать спорные места с
пользователем. **Код расширения не пишешь**, пока пользователь не попросит; ничего не коммитишь и не пушишь без просьбы
(правила git — `/home/orca/.pi/agent/AGENTS.md`, `/home/orca/orca/AGENTS.md`).

## Где
- Рабочая копия: `/home/orca/orca/workspaces/pi-setup/Netbird-devices` (репо `pi-setup`, текущая ветка).
- План и все решения/оговорки: `docs/netbird-devices/PLAN.md` — **прочитай целиком первым**.
- Уже написанные pure-модули (без тестов): `extensions/netbird-devices/{settings,discovery,policy,guard,presence,classifier,remote}.ts`.
  Проверь их на соответствие плану и отметь, что нужно поправить.
- Образец стиля и общих решений: `extensions/bitwarden-ssh.ts` и `extensions/bitwarden-ssh/` (диалоги, `withUILock`,
  маскированный ввод `secret-input.ts`, `exec.ts`, тесты `test/bitwarden-ssh*.test.ts`), README репо.

## Обязательное чтение по Pi
Перед планированием изменений harness: `docs/extensions.md` целиком, `docs/tui.md`, `docs/keybindings.md`
(в `/home/orca/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs`), примеры `examples/extensions/ssh.ts`,
`gondolin/index.ts`, `tool-override.ts`, `permission-gate.ts`, `protected-paths.ts`, `plan-mode/`.
Ключевые места в `dist/core/tools/`: `read.js` (берёт `ctx.cwd`, раскрывает `~` локально), `edit.js`
(дифф в `execute`, пишет через `ops.writeFile`), `write.js` (`mkdir` до записи), `renderers/edit.js`
(превью читает **локальный** файл по `args.path` — для удалённых вызовов так нельзя).

## Ключевые факты (проверены)
- Сокет netbird только для root (намеренно) → `netbird status/ssh proxy` недоступны; не предлагать менять права.
- Пиры с NetBird SSH — из `/etc/ssh/ssh_config.d/99-netbird.conf`; имена по IP — `getent hosts <ip>`.
- Mac `sergeys-macbook-pro` / 100.71.171.69: NetBird SSH 0.82 без аутентификации, пользователь `sergey`, macOS 27.0 arm64,
  SSH-сессия в контексте `Background` (нативное окно только через System Events + разовое разрешение Automation).
- Пользователь сейчас подключён к VM с Mac (порт 6768); `lastrcv` из `ss` не показывает активность (keepalive).
- Linux-компьютера пользователя в списке SSH-пиров нет.

## Ограничения при работе
- Не выполнять на устройствах пользователя ничего, кроме чтения, и **не открывать системные окна** без явного согласия.
- Не печатать окружение целиком (в контекст уже утёк `ORCA_AGENT_HOOK_TOKEN`); секреты не выводить.
- Не трогать `~/.ssh/pi-bitwarden/config` (генерируемый) и Bitwarden через `bw`.

## Что сдать
1. `docs/netbird-devices/IMPLEMENTATION.md`: этапы из PLAN §15, разбитые на задачи с файлами, сигнатурами
   (ssh.ts, state.ts, journal.ts, ui-text.ts, entry), событиями Pi и порядком; тест-план (unit для pure-модулей,
   ручная проверка §16); критерии готовности каждого этапа.
2. Список правок к уже написанным модулям (если найдёшь расхождения с планом/багами).
3. Вопросы пользователю из PLAN §17 и всё новое — задать через `ask_user_question`, ответы внести в PLAN.md.
