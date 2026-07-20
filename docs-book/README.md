# Codex Chat Mobile 项目全景手册

这是 `codex-chat-mobile` 项目的静态书籍站点，按认知曲线组织内容：**认识 → 演进 → 方法论 → 实现 → 数据 → 运维 → 规范**。

## 使用方式

### 本地打开

直接双击 `index.html` 即可在浏览器中打开，无需服务器。

### 阅读路线

1. **30 分钟速览**：只读「项目总览」+「系统架构总览」+「快速开始」
2. **完整通读**：按顺序读完全部 7 个部分
3. **按角色切入**：
   - 前端开发者：项目总览 → 流式事件处理 → Socket.IO 接口层 → 接口参考速查
   - 后端/协议开发者：系统架构总览 → 会话生命周期 → Codex 协议集成 → 协议参考速查
   - 运维/安全工程师：快速开始 → 远程访问方案 → 安全模型 → 测试体系

## 书籍结构

```
docs-book/
├── index.html              ← 首页（封面与导读）
├── pages/                  ← 各页面
├── assets/                 ← 样式和脚本
├── content/                ← 内容源（HTML 片段）
├── book.config.cjs         ← 全书结构配置
├── build.cjs               ← 构建脚本
├── verify.cjs              ← 校验脚本
└── README.md               ← 本文件
```

## 内容来源

本书内容来自项目官方文档：

- `README.md` / `README.zh-CN.md`：项目概览
- `CLAUDE.md`：项目规则
- `docs/ARCHITECTURE.md`：架构和安全模型
- `docs/API.md`：接口参考
- `docs/PROTOCOL.md`：协议参考
- `docs/TESTING.md`：测试体系
- `docs/GUIDE.md`：使用走查
- `docs/REMOTE_ACCESS.md`：远程访问方案
- `ROADMAP.md`：路线图
- `SECURITY.md`：威胁模型

## 重建站点

如果修改了内容，重新构建：

```bash
cd docs-book
node build.cjs
```

## 校验站点

运行校验脚本检查链接和结构：

```bash
cd docs-book
node verify.cjs
```

## 注意事项

1. **Mermaid 图**：需要 `assets/mermaid.min.js` 才能渲染。获取方式：
   - 从项目 `node_modules/mermaid/dist/mermaid.min.js` 拷贝
   - 或从 CDN 下载

2. **离线使用**：所有资源都已本地化，可完全离线使用。

3. **内容更新**：修改 `content/*.html` 后需重新运行 `node build.cjs`。

## 许可证

本手册内容遵循项目许可证：AGPL-3.0-only。
