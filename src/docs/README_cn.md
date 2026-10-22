# Anubis-Security-Tool

终端 / SSH / SFTP / FTP / Telnet / 串口 / RDP / VNC / Spice 客户端（Windows、macOS、Linux）。

- 命令行：`anubis`；URL 协议：`anubis://`（同时支持 ssh://、telnet://、rdp://、vnc://、serial://、spice://）
- 默认主题：`anubis-dark`
- 数据目录：`anubis`（可用 `DATA_PATH` 覆盖）。首次启动时若新目录为空且存在旧的 `electerm` 目录，会复制（不会删除）旧数据；由 `src/common/brand.config.js` 中的 `data.legacyDataDirs` 控制。

详见 [README.md](../../README.md)。本项目基于 MIT 协议的 electerm 分支。