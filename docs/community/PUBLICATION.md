# Перед публикацией: checklist сопровождающего

**Это план, не выполненная публикация.** Не включать публичное оформление до завершения функциональных исправлений и проверки поставляемого runtime.

На момент подготовки Wiki включена в настройках четырёх проектных репозиториев, но это не подтверждает опубликованные страницы: Wiki основного приложения пока не доступна как заполненное хранилище. Discussions основного приложения отключены. Ссылки внутри `docs/wiki` намеренно ведут на файлы репозитория; будущие публичные адреса здесь не объявлены действующими.

## Порядок

1. Зафиксировать реально выпущенные версии и принятые сценарии. Обновить [Versions](../wiki/Versions.md) только по фактам; не переносить private QA в рекламные утверждения.
2. Проверить README и Wiki на секреты, внутренние адреса, пользовательские SID, приватные имена машин и абсолютные QA-пути. Старые технические документы требуют отдельного редакционного аудита перед внешним копированием.
3. Выбрать размещение Wiki: `docs/wiki` в основном коде, отдельный GitHub Wiki либо сайт документации. Подготовить относительные ссылки под выбранный URL-контекст; не копировать `.md` вслепую.
4. Сохранить `Home` и `_Sidebar`, перенести страницы без потери навигации. Дать существующим ссылкам приложения совместимые маршруты.
5. После отдельного решения включить Discussions и создать категории. Опубликовать стартовую тему и несколько FAQ от команды, а не постановочный диалог.
6. Назначить topics и проверить ссылки с публичной неавторизованной страницы. Сохранить лицензии/copyright и не объявлять чужой код оригинальным.

## Совместимость маршрутов

Приложение использует `brand.docs.wikiBase` на `docs.anubis.locker/wiki` и legacy slugs из `src\common\brand.config.js`; публикация в GitHub Wiki сама по себе не исправит эти ссылки.

| Имеющийся slug / группа | Новая страница |
| --- | --- |
| `Install-command` | [Installation](../wiki/Installation.md) |
| `RDP` | [Remote-desktop](../wiki/Remote-desktop.md) |
| `Profile`, `Default-Profile` | [Profiles-and-passwords](../wiki/Profiles-and-passwords.md) |
| `Quick-connect`, `Start-session` | [Quick-start](../wiki/Quick-start.md) |
| `Batch-operation`, `Quick-commands`, `Data-import` | [Bookmarks-and-batch](../wiki/Bookmarks-and-batch.md) |
| `AI-model-config-guide`, `AI-bookmark`, `Theme-AI-editor` | [AI](../wiki/AI.md); stub endpoint не подтверждает работающую генерацию, в том числе тем |
| `Custom-sync-server`, `WebDAV-sync`, `Create-personal-access-token`, `gitee-data-sync-warning` | [Sync-and-backup](../wiki/Sync-and-backup.md); это раздел о синхронизации/секретах, не обещание актуального интерфейса стороннего провайдера |
| `privacy-notice` | [Security-and-privacy](../wiki/Security-and-privacy.md) |
| `Know-issues` | [Troubleshooting](../wiki/Troubleshooting.md) |
| `Common-settings`, `Layout`, `Terminal-config` | [Configuration](../wiki/Configuration.md) |
| `How-to-use-ssh-tunnel`, `SSH-Key-Content-vs-Key-Path`, `SSH-agent`, `Connection-Hopping-Behavior-Change`, `Warning-about-sftp-follow-ssh-path-function` | [SSH-and-files](../wiki/SSH-and-files.md) |
| `Widgets` | [MCP](../wiki/MCP.md) как навигация к конкретному виджету; не полный каталог и не реализация PRO Plugin Store |
| `Use-X11` | [Use-X11](../wiki/Use-X11.md); X11 через connection hopping не заявлен поддерживаемым текущим путём, Web не рисует X11 |
| `proxy-format` | [proxy-format](../wiki/proxy-format.md); HTTPS proxy не заявлен рабочим для текущего SSH/TCP connector |
| `Mouse-events-require-alt` | [Mouse-events-require-alt](../wiki/Mouse-events-require-alt.md); колесо не ограничивается Alt gate |
| `Terminal-keywords-highlight-regular-expression-exmaples` | [Terminal-keywords-highlight-regular-expression-exmaples](../wiki/Terminal-keywords-highlight-regular-expression-exmaples.md); опечатка slug сохранена |

У каждого значения `brand.docs.pages` есть тематическое назначение в таблице. Это карта редакционного соответствия, не готовые HTTP redirects и не обещание полного восстановления прежних специализированных инструкций. Нельзя заменять эти маршруты общим Home. Ограничения четырёх специальных настроек описаны в отдельных source-guided страницах; они не подтверждают новую живую приёмку.

Канонические `REMOTE-ACCESS.md`, `ADMIN-VS-USER.md`, `WINDOWS-INSTALLER.md`, `MACHINE-PROTOCOLS.md`, `EMBEDDED-WEBSITES.md`, `DEFAULTS.md` и `RELEASE.md` должны оставаться доступными по ссылкам из Wiki либо получить явно переписанные ссылки после переноса. Межпапочные ссылки на `community`, source-файлы и `package.json` также адаптируются к публичному размещению.

## Предложение: ровно 20 topics основного приложения

Это GitHub repository topics, не категории Discussions. Список согласован с утверждённым планом основного приложения; он описывает возможности, а не статус релиза или аудит безопасности.

```text
anubis
anubis-security-tool
terminal
ssh
sftp
ftp
rdp
vnc
spice
telnet
serial-port
electron
remote-access
windows
macos
linux
mcp
self-hosted
developer-tools
system-administration
```

Topics остальных трёх проектных репозиториев определяются по их собственным исходникам отдельно. Здесь они не назначены. Несвязанные репозитории организации в этот пакет не входят.

## Редакционные границы

Не добавлять badge «тесты пройдены», «production ready», счётчики пользователей и отзывы без проверяемого основания. Сдержанные значки в заголовках допустимы; они не заменяют описание работающей функции. Не публиковать credentials даже в примере и не обещать отключение шифрования или удалённый reset.

[Материалы сообщества](README.md) · [Wiki](../wiki/Home.md)
