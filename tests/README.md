# tests — 验证

职责：提供方事件适配、命令边界与协议契约的自动化验证。

对应文档：[roadmap M0 验收](../docs/roadmap.md)。

## 范围

- [ ] CLI 命令构造边界（参数数组、shell:false、不拼接用户输入）。
- [ ] Codex / Claude 事件归一化契约测试。
- [ ] 会话恢复与 provider 绑定规则。
- [ ] schema 校验（model.json、任务、结果）拒绝非法输入。

注意：CLI `--help` 检查不等于实际模型调用成功；模型调用验收需使用实际登录的两种 CLI 分别完成。
