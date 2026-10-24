# 🛡️ Anubis-Security-Tool

Терминал, удалённые подключения и передача файлов в одном рабочем пространстве.
Desktop для Windows, macOS и Linux; отдельная Web-дистрибуция и управляемый доступ к одобренным устройствам.

[Сайт](https://anubis.locker) · [Загрузки](https://download.anubis.locker) · [Документация](https://docs.anubis.locker/) · [Сообщить об ошибке](https://github.com/Anubis-Locker/anubis/issues)

> **Версии:** публичная поставка Desktop — **5.7.2**. [Исходники кандидата **5.7.3**](https://github.com/Anubis-Locker/anubis/tree/usability-repair-candidate) содержат исправления, но новый runtime ещё не установлен, не прошёл живую приёмку и не выпущен. Описание исходников не подтверждает возможности установленной версии. [Подробности](docs/wiki/Versions.md).

## Что внутри

- SSH и терминалы, SFTP/FTP, RDP, VNC, SPICE, serial и Telnet.
- Закладки, группы, профили параметров, quick commands и пакетные операции.
- Темы, прокси, SSH-туннели, синхронизация и интеграция с AI.
- Аутентифицированный MCP для доверенных инструментов.
- Managed Web-доступ через отдельную регистрацию, сверку fingerprint и одобрение администратора.

**Desktop, standalone Web и managed-device Web — не одно и то же.**
Выбор SYSTEM не показывает экран Windows; native machine GUI работает только с локальной машиной и не выбирает удалённое устройство по UUID.
HTTP/HTTPS-вкладка в Web загружает сайт из браузера оператора.
Семь пунктов PRO, включая Browser Control, — заглушки, а не установленные плагины.
AI endpoint по умолчанию пока отвечает заглушкой.

## 🚀 Начать работу

1. Выберите пакет своей платформы на [странице загрузки](https://download.anubis.locker), проверьте версию и контрольную сумму доступного релиза.
2. Установите приложение согласно [руководству](docs/wiki/Installation.md). Для Windows machine-пакета действуют отдельные требования UAC, x64 и совместимости службы.
3. Создайте **New bookmark**, выберите протокол и укажите адрес разрешённого сервера. Не помещайте пароль в URL.
4. Для доступа к одобренному устройству используйте **Managed devices → Open device**, а не прямое копирование URL.

[Первое подключение](docs/wiki/Quick-start.md) · [Удалённый доступ](docs/REMOTE-ACCESS.md) · [Решение проблем](docs/wiki/Troubleshooting.md)

## Разработка

Требуется Node.js 24.x. Команды выполняются в полном checkout приложения:

```powershell
npm install --legacy-peer-deps
npm start
# В другом терминале:
npm run app
```

Проверка стиля: `npm run lint`. Сборка подготовленных файлов: `npm run b`.
Подготовка конфигурации упаковки: `npm run pb`.
Ресурсы бренда должны быть доступны до сборки; подробности — в [руководстве разработчика](docs/wiki/Development.md).
Успешная сборка не заменяет проверку установленного приложения.

## 🤝 Проект и сообщество

Основной код: [anubis](https://github.com/Anubis-Locker/anubis).
Связанные компоненты: [Web](https://github.com/Anubis-Locker/anubis-web), [ресурсы](https://github.com/Anubis-Locker/anubis-resource), [managed access](https://github.com/Anubis-Locker/anubis-managed-access).
Правила участия и маршруты обращений: [Community](docs/wiki/Community.md).

[Discussions](https://github.com/Anubis-Locker/anubis/discussions) открыты: шесть категорий и четыре стартовых материала от сопровождающих. Дополнительные FAQ и сценарии находятся в [редакционном пакете](docs/community/README.md). Это авторские справки команды, не вымышленные диалоги пользователей.

## Лицензии и происхождение

Проект основан на electerm; исходные авторские права и условия MIT сохранены.
См. [LICENSE](LICENSE), [NOTICE](NOTICE) и [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
Имена совместимых пакетов, протоколов и старых каталогов данных не означают принадлежность к стороннему сервису.
