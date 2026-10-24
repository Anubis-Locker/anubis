# Разработка и сборка

Используйте полный checkout [anubis](https://github.com/Anubis-Locker/anubis), Node.js 24.x и зависимости из lockfile. Этот раздел описывает команды, не запускает их и не публикует release.

```powershell
npm install --legacy-peer-deps
npm start
```

Vite dev-server использует порт 5570. В отдельном терминале:

```powershell
npm run app
```

## Проверки и подготовка

```powershell
npm run lint
npm run test-unit-ci
npm run b
npm run pb
```

`b` выполняет clean/compile/prepare-file; сохраните нужные build-артефакты до запуска. `pb` подготавливает root-конфигурацию electron-builder. Это ещё не готовый установщик.

Брендовые ресурсы ищутся через `BRAND_RES_DIR`, затем соседний `resource`, затем `@ai-security-tool/resource`. Источник ресурсов должен соответствовать сборке. `src\common\brand.config.js` попадает в renderer — секреты там запрещены.

Для Windows x64 machine-пакета after-pack собирает native helper; контракт требует Go не ниже 1.26, а release-процесс выбирает закреплённый compiler. Нативные runtime-файлы должны соответствовать архитектуре. [Windows installer](../WINDOWS-INSTALLER.md) содержит точные условия и ограничения.

`npm run test-packaged-windows` — отдельная проверка Windows-пакета с её собственными prerequisites. Успешные unit-тесты не подтверждают UAC, SCM, установленный GUI или production rollout. Не запускайте интеграционные сценарии против чужих устройств.

[Процесс релиза](../RELEASE.md) · [Версии](Versions.md) · [Главная](Home.md)
