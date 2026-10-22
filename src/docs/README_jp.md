# Anubis-Security-Tool

ターミナル / SSH / SFTP / FTP / Telnet / シリアル / RDP / VNC / Spice クライアント（Windows、macOS、Linux）。

- コマンド：`anubis`、URL スキーム：`anubis://`（ssh://、telnet://、rdp://、vnc://、serial://、spice:// も対応）
- 既定テーマ：`anubis-dark`
- データフォルダ：`anubis`（`DATA_PATH` で変更可）。初回起動時、新しいフォルダが空で旧 `electerm` フォルダがある場合は内容をコピーします（削除はしません）。`src/common/brand.config.js` の `data.legacyDataDirs` で制御します。

詳細は [README.md](../../README.md) を参照してください。MIT ライセンスの electerm のフォークです。