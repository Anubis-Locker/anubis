# Статическая Wiki: сборка без публикации

Генератор берёт **28 статей и `_Sidebar` из публичного коммита `ac1d0faaab2ae1fa1ed085d9ff462d2b6dea0b11`**. Текст сверяется с Git-объектами; изменённые или отсутствующие входные файлы останавливают сборку. Существующие Markdown-файлы и runtime не меняются.

Публичный `docs/community/PUBLICATION.md` задаёт соответствие legacy-slugs, включая `exmaples`. Генератор проверяет все 30 значений `brand.docs.pages` из того же публичного коммита и дополнительный `Default-Profile`. Каждый alias содержит нужную статью, постоянную навигацию и HTML canonical URL `/wiki/<Page>/`; общего fallback на Home нет.

## Требования и команды

Нужны Node.js 24, Git и уже имеющиеся зависимости полного app checkout: `react`, `react-dom`, `react-markdown`, `remark-gfm`; локальная проверка также использует существующий `playwright` и уже установленный Chromium. Root manifests/lockfile не изменяются. Здесь нет команд установки пакетов, браузера, lifecycle hooks или загрузки ресурсов.

Из корня checkout, где зависимости уже доступны:

```powershell
node docs\site\build.mjs --output C:\staging\anubis-wiki-candidate
node docs\site\verify.mjs --output C:\staging\anubis-wiki-candidate --receipt C:\staging\anubis-wiki-validation.json
```

Пути — примеры, не адреса production. Родительский staging-каталог должен существовать; сам output должен быть **новым и несуществующим**, вне исходного checkout. Генератор не перезаписывает существующие файлы. Receipt также создаётся исключительно новым файлом.

В sparse worktree можно использовать зависимости другого уже существующего checkout только для разрешения модулей:

```powershell
node docs\site\build.mjs --output C:\staging\anubis-wiki-candidate --dependency-root C:\existing-app-checkout
node docs\site\verify.mjs --output C:\staging\anubis-wiki-candidate --dependency-root C:\existing-app-checkout --receipt C:\staging\anubis-wiki-validation.json
```

Этот override не меняет junction, зависимости, исходники или настройки другого checkout. Абсолютные локальные пути не записываются в сайт и manifest.

## Выход

`index.html` и `wiki/index.html` — входы руководства. Канонические статьи и aliases записываются как `<route>\index.html`; `assets\wiki.css` — единственный stylesheet. Есть `404.html` с полезной навигацией. HTML, CSS и JSON кодируются UTF-8. Нет JS, analytics, внешних шрифтов, CDN или runtime hotlinks.

Относительные ссылки между статьями превращаются в канонические `/wiki/<Page>/`. Ссылки за пределы Wiki — на **публичный GitHub source указанного коммита**, включая технические документы, community и исходники. Старые исторические документы не копируются в сайт. Внешние обычные hyperlinks сохраняются; проверка не обращается к ним.

Заголовки получают устойчивые Unicode IDs, одинаковые на canonical и alias-страницах. GFM-таблицы, code blocks, списки и выделение рендерятся существующими Markdown-зависимостями; raw HTML не исполняется.

`site-manifest.json` хранит public source ref, SHA-256 входных Git-байтов и фактических входных файлов, версии renderer-зависимостей, карту routes и SHA-256 каждого выходного файла кроме самого manifest. Нет времени сборки и session paths; при одинаковых входных байтах и зависимостях результат воспроизводим.

## Локальная приёмка

`verify.mjs` проверяет хеши/инвентарь, поднимает временный сервер **только на loopback**, обращается к маршрутам через настоящий HTTP fetch и headless Chromium, проверяет slashless/slash URL, MIME, UTF-8, canonical, headings/anchors, sidebar, локальные ссылки/ресурсы и полезный HTTP 404. Проверяются desktop-страницы и мобильный layout установки; браузеру запрещены non-loopback запросы. Браузер и сервер закрываются в `finally`; не остаётся фоновой службы. Receipt содержит результаты и хеш manifest, а не credentials.

## Граница deployment

Ничего не развёртывается и DNS/Nginx не меняются. Родительская сессия отдельно проверяет docroot: новый root `index.html` должен обслуживать docs-host, а каталоги `/wiki/<slug>/` — существующий directory/`try_files` маршрут. Одного копирования в чужой download-docroot недостаточно. Для выдачи `404.html` при неизвестном URL серверу требуется соответствующий `error_page`; генератор не выдаёт это за уже настроенный production.

Проверка статического сайта не подтверждает установку, живую приёмку или выпуск нового runtime. Исходные лицензии/copyright не меняются; дополнительные логотипы и сторонние assets не копируются.
