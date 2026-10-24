# Reverse proxy и TLS

Managed-устройствам нужны HTTPS-поддомены, wildcard DNS/сертификат и корректный маршрут к management gateway. На ПК не требуется открывать входящий порт: совместимый агент устанавливает исходящий защищённый канал.

Шаблоны находятся в app source: `services\nginx-managed-gateway.conf` и `services\nginx-managed-agent-location.conf`. Это deployment-примеры, не готовый универсальный конфиг. Администратор должен подставить свои listen-адреса, сертификаты, upstream и разрешённые имена, не копируя частные значения из чужой среды.

Проверьте сохранение Host, HTTP/1.1, WebSocket Upgrade/Connection, разумные stream timeouts и отключённую буферизацию там, где идут долгие потоки. Один только HTTP 200 главной страницы не подтверждает терминальный WebSocket или MCP/SSE.

Cookie браузерного доступа должна оставаться host-only, HttpOnly и Secure. Не расширяйте её на все поддомены и не передавайте административный токен через query string. Исключите чувствительные реквизиты из access logs.

TLS завершается на доверенном gateway: оператор gateway входит в модель доверия. Это не сквозное шифрование от него. Не отключайте верификацию сертификатов и не превращайте gateway в общий anonymous-прокси.

Отдельно проверьте вход по Open device, отказ другого браузера без билета, Web-login, терминал, истечение/отзыв MCP и Revoke. После перезапуска gateway сессии в памяти требуют нового входа.

CSP/X-Frame-Options целевого сайта не исправляются настройкой proxy для Anubis: [HTTP-вкладки](Web-auth.md).

[Self-hosting](Self-hosting.md) · [Безопасность](Security-and-privacy.md) · [Главная](Home.md)
