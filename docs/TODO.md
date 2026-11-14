# TODO

- [ ] 真机验证：AI 端到端（真 Key）、跨设备同步（两个 Chrome 配置文件，含 Key 的成对搬运与删除传播）、工具栏角标
- [ ] 上架前把商店条目的公钥填进 `src/manifest.json` 的 `key`（步骤见 `identity.md`）。越早越好：这一步会改开发版 ID，已有数据要先「导出备份 → 新版导入」
- [ ] 干净开源，上架 Chrome 拓展商店（为了跨设备同步）
- [ ] 卸载我装的其他划词类扩展，只留本拓展一个工具栏
- [ ] 同步配额用完时的台阶：① 压缩 + 按 8 KB 分片，仍是 `storage.sync`；② 换用户自带后端（WebDAV / Git Gist，参考 floccus）。两者都只改 `shared/sync.ts`
