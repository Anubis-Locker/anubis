# Самостоятельное размещение

Разделите роли компонентов, прежде чем развёртывать их. Это не один универсальный сервер.

| Компонент | Назначение и источник |
| --- | --- |
| Приложение | [anubis](https://github.com/Anubis-Locker/anubis): Desktop, shared renderer и служебные контракты |
| Web-обёртка | [anubis-web](https://github.com/Anubis-Locker/anubis-web): runnable Web, CLI и собственная конфигурация |
| Ресурсы | [anubis-resource](https://github.com/Anubis-Locker/anubis-resource): брендовые ресурсы |
| Managed access | [anubis-managed-access](https://github.com/Anubis-Locker/anubis-managed-access): отдельный компонент управляемого доступа |
| Службы в app source | `services`: management API/dashboard, release API, AI stub, примеры Nginx |

Используйте инструкции и dependency manifests конкретного компонента. Не выдумывайте npm-пакеты или GitHub-ссылки для локальных вспомогательных модулей. Наличие исходной папки не означает опубликованный сервис.

Для standalone Web предусмотрите отдельный приватный writable-каталог конфигурации, сильные независимые credentials, HTTPS и резервные копии. Enrollment не заменяет Web-login. Актуальные CLI flags сверяйте с закреплённой версией Web-обёртки.

Для management API нужны защищённое хранилище состояния, отдельный административный секрет, маршрутизация туннеля и TLS. Не помещайте секреты в URL, brand config или аргументы запуска. Не выполняйте auto-approve новых устройств.

Для update-сервиса соблюдайте контрольные суммы, неизменяемость опубликованных файлов и разделение стабильного/экспериментального канала. [RELEASE.md](../RELEASE.md) — контракт процесса публикации, а не указание публиковать текущую частную версию.

[Reverse proxy](Reverse-proxy.md) · [Web-вход](Web-auth.md) · [Главная](Home.md)
