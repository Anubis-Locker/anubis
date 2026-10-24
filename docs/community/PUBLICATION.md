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
| `Install-command` | Installation |
| `RDP` | Remote-desktop |
| `Profile`, `Default-Profile` | Profiles-and-passwords |
| `Quick-connect`, `Start-session` | Quick-start |
| `Batch-operation`, `Quick-commands`, `Data-import` | Bookmarks-and-batch |
| `AI-model-config-guide`, `AI-bookmark`, `Theme-AI-editor` | AI |
| `Custom-sync-server`, `WebDAV-sync`, `Create-personal-access-token`, `gitee-data-sync-warning` | Sync-and-backup |
| `privacy-notice` | Security-and-privacy |
| `Know-issues` | Troubleshooting |
| `Common-settings`, `Layout`, `Terminal-config` | Configuration |
| `How-to-use-ssh-tunnel`, `SSH-Key-Content-vs-Key-Path`, `SSH-agent`, `Connection-Hopping-Behavior-Change`, `Warning-about-sftp-follow-ssh-path-function` | SSH-and-files |
| `Widgets` | MCP как начальная навигация; не выдавать её за полный каталог виджетов |

Это карта редакционного соответствия, не готовые HTTP redirects и не исчерпывающее покрытие старых инструкций. Специализированные страницы `Use-X11`, `proxy-format`, `Mouse-events-require-alt` и `Terminal-keywords-highlight-regular-expression-exmaples` требуют отдельного точного руководства/сохранённого проверенного маршрута. Нельзя отправлять их на Home и считать содержание восстановленным.

Канонические `REMOTE-ACCESS.md`, `ADMIN-VS-USER.md`, `WINDOWS-INSTALLER.md`, `MACHINE-PROTOCOLS.md`, `EMBEDDED-WEBSITES.md`, `DEFAULTS.md` и `RELEASE.md` должны оставаться доступными по ссылкам из Wiki либо получить явно переписанные ссылки после переноса. Межпапочные ссылки на `community` также адаптируются к публичному размещению.

## Предложение: ровно 20 topics основного приложения

Это GitHub repository topics, не категории Discussions. Они описывают возможности, а не статус релиза или аудит безопасности.

```text
anubis
terminal
ssh
sftp
ftp
telnet
serial-port
rdp
vnc
spice
remote-access
connection-manager
file-transfer
electron
react
windows
macos
linux
model-context-protocol
self-hosted
```

Topics остальных трёх проектных репозиториев определяются по их собственным исходникам отдельно. Здесь они не назначены. Несвязанные репозитории организации в этот пакет не входят.

## Редакционные границы

Не добавлять badge «тесты пройдены», «production ready», счётчики пользователей и отзывы без проверяемого основания. Сдержанные значки в заголовках допустимы; они не заменяют описание работающей функции. Не публиковать credentials даже в примере и не обещать отключение шифрования или удалённый reset.

[Материалы сообщества](README.md) · [Wiki](../wiki/Home.md)
