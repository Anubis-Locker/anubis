# Два уровня доступа: admin и user

## Идея
Требование заказчика: административный доступ настраивается по умолчанию и пользователю не виден; пользовательский доступ пользователь настраивает сам.

- **Admin-уровень** — значения задаются при сборке (`src\common\brand.config.js`) или переменными окружения `ANUBIS_ADMIN_*` при (первом) запуске (например, из установщика / системной политики). Они **не показываются и не редактируются** в Settings.
- **User-уровень** — всё остальное (тема, раскладка, SSH-профили, quick commands, шрифты и т.д.) — без изменений.

## Реализация (реальная защита, не только UI)
| Слой | Файл | Что делает |
|---|---|---|
| main | `src\app\common\admin-policy.js` | Вычисляет политику (brand + env), `applyAdminPolicy(config, {partial})` принудительно проставляет значения, `getAdminLockedKeys()`, `ensureMcpToken()` |
| main | `src\app\lib\get-config.js` | При каждом чтении конфига применяет политику и передаёт в renderer `config.adminLockedKeys` |
| main | `src\app\lib\user-config-controller.js` | `saveUserConfig`: значения из IPC/UI переписываются политикой до записи в БД; `adminLockedKeys` в БД не пишется |
| main | `src\app\lib\admin-startup.js` (вызов в `create-app.js`) | На старте перезаписывает отклонившиеся значения в сохранённом конфиге, применяет автозапуск ОС и регистрацию deep link |
| main | `src\app\widgets\widget-mcp-server.js` | Подставляет MCP-токен, пользователь его не может очистить/заменить |
| main | `src\app\lib\crash-reporter.js` | Отправка отчётов об ошибках и разового heartbeat при старте — включено по умолчанию, URL/вкл.-выкл. только через admin-policy |
| renderer | `src\client\common\admin-policy.js` | `ADMIN_LOCKABLE_KEYS`, `isAdminLocked(key, config)` — для форм |
| renderer | `setting-common.jsx`, `ai-config.jsx`, `ai-presets.js`, `setting-sync-form.jsx` | Скрытие/блокировка полей («управляется администратором») |

Если пользователь правит файл/БД или вызывает `saveUserConfig` напрямую, значения будут возвращены при следующем чтении/сохранении/старте. Списки ключей в main и renderer сверяет тест `src\test\unit-ci\admin-policy.spec.js`.

## Admin-locked ключи
| Ключ | Значение по умолчанию | Как изменить (только сборка/env) | В UI |
|---|---|---|---|
| `syncSetting.cloudApiUrl` | `brand.sync.cloudApi` | `brand.config.js` → `sync.cloudApi` или `ANUBIS_ADMIN_SYNC_API` | URL скрыт, показана пометка |
| `baseURLAI`, `apiPathAI`, `authHeaderNameAI` | `brand.ai.baseURL`, `/chat/completions`, `Authorization: Bearer` | `brand.config.js` → `ai.baseURL` или `ANUBIS_ADMIN_AI_BASE_URL` | поля disabled, пресеты скрыты |
| `enableGlobalProxy`, `proxy` | не заданы (не блокируются) | `ANUBIS_ADMIN_PROXY=socks5://host:port` — тогда включаются и блокируются | блок Global proxy скрыт |
| `checkUpdateOnStart` | `brand.update.enabled` (true); серверы — `brand.update.baseUrls` (build-time) | `brand.config.js` → `update` или `ANUBIS_ADMIN_UPDATE_ENABLED=0/1` | переключатель скрыт |
| `mcpServerEnabled` (+ MCP-токен) | true; токен случайный, `userData\admin-mcp-token` | `ANUBIS_ADMIN_MCP_ENABLED=0/1`; токен — удалить файл для перевыпуска | токен в UI не показывается |
| `errorReportEnabled`, `errorReportUrl` | true; `https://api.anubis.locker/api/report` (`brand.domains.api`) | `ANUBIS_ADMIN_ERROR_REPORT=0/1`, `ANUBIS_ADMIN_ERROR_REPORT_URL` | в UI нет |
| `autoStartOnLogin` | true (только упакованное приложение) | `ANUBIS_ADMIN_AUTOSTART=0/1`; `ANUBIS_ADMIN_AUTOSTART_USER_CAN_DISABLE=1` снимает блокировку — тогда переключатель в Settings доступен | скрыт, если заблокирован |

Отправляются: при ошибке — текст/стек (до 8 КБ), версия, платформа, арх; при старте приложения — только разовый "heartbeat" (без текста/стека), чтобы `api.anubis.locker` мог показать список установленных экземпляров (`/api/installs`). Оба типа событий включают случайный `installId`, который хранится в userData (`install-id`, ничего не говорит о пользователе) — это не телеметрия использования, `brand.update.sendTelemetry` остаётся `false` (отправляется только версия при проверке обновлений).

Отчёты об аварийном завершении дочернего процесса/рендерера также отправляются серверу. Ошибки сохранения `installId`, недоступность API и некорректное подтверждение приёма записываются в локальный журнал; запрос ограничен пятью секундами. Идентификатор установки связывает её отчёты между запусками, но не содержит имени пользователя.

## Ограничения
- Переменные окружения читает процесс приложения; для защиты от пользователя задавайте их на уровне системы/установщика, а значения по умолчанию фиксируйте в `brand.config.js` при сборке.
- `brand.config.js` целиком попадает в renderer — секретов там быть не должно (поэтому токен MCP генерируется локально).
- Это защита от случайных/UI-правок; локальный администратор ОС может пересобрать или изменить приложение.
