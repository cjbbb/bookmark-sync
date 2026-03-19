# 智能书签同步 (Chrome/Edge 扩展)

一个将浏览器书签与 GitHub/GitLab 同步，并提供 AI 分类辅助的书签管理扩展。

## 核心能力

- 同步平台：支持 GitHub 与 GitLab。
- 全量同步：
  - 全量上传覆盖远端 `bookmarks.json`。
  - 全量下载覆盖本地书签（会删除远端不存在的本地项）。
- 版本控制：可查看远端版本历史，并一键恢复到任一历史版本。
- AI 分类：支持批量建议、逐条勾选、分类级批量操作、批量应用。
- 规则理解：支持自然语言规则调整，支持多动作、同义表达、排除条件，并提供 AI 语义兜底。
- 主题支持：跟随系统明暗主题，也可手动切换。

## 安装

1. 打开浏览器扩展页面：
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
2. 打开开发者模式。
3. 选择加载已解压扩展。
4. 选择本项目目录。

## Options 主页说明

`options` 页现在作为主控制台，包含：

- 同步配置
- 版本控制与覆盖恢复（常驻可见）
- AI 分类配置
- AI 操作中心

其中“同步配置”和“AI 分类配置”支持点击标题折叠/展开，再次点击可恢复展开。

## 同步配置

### GitLab

- GitLab 地址：默认 `https://gitlab.com`
- Token：需要 `api` 权限
- 项目标识：支持项目 ID 或 `owner/repo` 路径

### GitHub

- Token：需要 `repo` 权限
- Owner / Repo：仓库所有者与仓库名

说明：如果测试连接返回 404，请先在对应平台手动创建仓库/项目。

## 版本控制与恢复

在同步区域可直接使用：

- `全量上传覆盖远端`
- `全量下载覆盖本地`
- `查看版本历史`

历史列表中可直接点击“恢复到此版本”，恢复会执行本地覆盖式回滚。

## AI 分类使用流程

1. 配置并测试 AI 连接（DeepSeek 或 MiniMax）。
2. 进入 AI 分析子界面并执行分析。
3. 在建议列表中勾选/取消/删除建议。
4. 使用自然语言规则进一步批量调整。
5. 点击“应用勾选变更”。

## 自然语言规则示例

- 多动作：`把 A 和 B 合并为 C，再把 D 并入 C`
- 同义表达：`把 音乐 和 吉他谱 都为 吉他谱`
- 排除条件：`除工作外都并入学习`

规则解析策略：

1. 先本地解析（快速）。
2. 本地未命中时，调用已配置 AI 做语义解析。

## 项目结构

```text
bookmark/
├── manifest.json
├── background/
│   └── service-worker.js
├── lib/
│   ├── bookmark-manager.js
│   ├── ai/
│   │   ├── ai-engine.js
│   │   ├── deepseek-provider.js
│   │   └── minimax-provider.js
│   └── sync/
│       ├── sync-engine.js
│       ├── github-sync.js
│       └── gitlab-sync.js
├── options/
│   ├── options.html
│   ├── options.css
│   └── options.js
├── popup/
└── icons/
```

## 安全说明

- Token 与 API Key 存储于浏览器本地 `chrome.storage.local`。
- AI 分类仅使用书签文本做上下文处理。

## 许可证

按仓库实际许可证执行。
