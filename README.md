# 🔖 智能书签同步 — Chrome/Edge 浏览器插件

> 融合 **GitLab/GitHub 开源同步** 与 **AI 结构化智能自适应分类** 的新一代书签管理工具。

---

## 🌟 核心特性

- 🗂️ **Dashboard 双栏面板** — 选项页全新升级大屏仪表盘视图，左侧流畅配置，右侧全屏操作 AI 建议。
- ⚡ **并发 AI 处理** — 重构 AI 异步队列（4路并发并发批处理），400+ 标签分析提速 **3~5 倍**！
- 🤝 **一键托管建仓** — 配置时若检测到 404，插件支持**一键使用 Token 自动在远端创建并初始化 Private（私有）仓**，跳过繁琐操作。
- 🌓 **智能主题跟随** — 联动操作系统的 `prefers-color-scheme` 媒介侦察，全自动跟随系统明暗进行面板无感切换。
- 🛡️ **安全操作确认** — 所有的 AI 移动建议在全量执行前，必须得到您的勾选确认，安全无忧，绝不误伤任何收藏夹条目。

---

## 🚀 安装方法

### 开发者模式加载（最便捷）

1. 打开 Chrome 或 Chromium 内核系列（如 Edge, Brave）浏览器。
2. 访问扩展程序页面：
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
3. 开启右上角的 **"开发者模式"** 开关。
4. 点击 **"加载已解压的扩展程序"** 按钮。
5. 选择本项目的 `bookmark` 纯目录文件夹完成加载即可。

---

## ⚙️ 核心配置指引

### 1. 远端同步配置 (GitLab / GitHub)

点击弹窗右上角 ⚙️ 齿轮，直达大屏设置仪表盘：

#### 🦊 GitLab 配置（中国大陆免翻墙，推荐）
- **GitLab 实例**: 默认 `https://gitlab.com`，也支持公司自建主域名。
- **Personal Access Token**: 到 [GitLab Token 生成面](https://gitlab.com/-/user_settings/personal_access_tokens) 创建，需要赋予 `api` 级别权限。
- **项目/仓库路径**: 数字 ID，或直接填写 `用户名/项目名`。

#### 🐙 GitHub 配置
- **Personal Access Token**: 到 [GitHub Token 创建页](https://github.com/settings/tokens/new) 生成，勾选 **`repo`** 完全控制链。
- **仓库所有者 (Owner)**: 你的 GitHub 用户名。
- **仓库名称 (Repo)**: 如 `bookmarks-sync`。

> 💡 **小贴士**：当您点击 **“测试连接”** 并提示仓库未创建（404）时，插件会弹出确认框，只需**点击确认，插件会代您瞬间在云端创建好 Private（私有）仓库**，无需任何跳转。

---

### 2. AI 自动分类配置

在控制台开启 AI 提供商关联：

#### 🧠 DeepSeek
- **API Key**: 访问 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 签发。
- **主要模型**: 预设 `deepseek-chat`。

#### 🌋 MiniMax
- **API Key**: 访问 [MiniMax 开发者平台](https://platform.minimaxi.com/user-center/basic-information/interface-key) 获取。
- **模型**: 推荐 `MiniMax-Text-01`。

---

## 📖 使用指南

### 📂 查看与检索
- 呼出弹窗后，可以使用顶部**智能实时搜索框**对所有深度的多级嵌套文件夹进行过滤，在 popup 浮窗中秒开指定路径。

### 🔄 互通上传下载
- **上传**: 覆盖式将本地书签推送到远端 JSON。
- **下载**: 从远端降落数据。放心，下载过程基于 URL 去重字典判定，确保**绝不会损坏**您本地已分类的项目。

### 🤖 并发 AI 智能归类
1. 保证配置可用后，点击 **开始 AI 分类**。
2. 内部结构化多请求并发流起跑（极速通过 token 结构批处）。
3. 生成卡片集合，带有 `理由` 及对比。
4. 您可以**逐一审查并 Accept（接受）** 或者 **Reject（拒绝）**。
5. 点击底层 **“应用已选建议”** 批量将书签瞬间瞬移。

---

## 🏗️ 结构骨架

```text
bookmark/
├── manifest.json              # 核心 Manifest V3 注册文件
├── popup/                     # 弹窗主视图（专注拉取与自适应渲染）
├── options/                   # 选项设置页（高度集成的双栏 Dashboard）
├── background/                # Service Worker 通信调度总台
├── lib/                       # 底层基类支撑
│   ├── bookmark-manager.js    # 书签树级打解包管理
│   ├── sync/                  # GitLab/GitHub RESTful 提供商
│   └── ai/                    # 驱动 DeepSeek/Minimax LLM 判决器
└── icons/                     # 扩展图标集
```

---

## 🔒 隐私安全与高敏信息

- 所有本地 Token、API Key、配置仅使用 `chrome.storage.local` 密闭在浏览器**您的本地客户端容器中**。
- 所有的 AI 书签文本分析仅作为模型上下文，绝不用于任何其他留底。

---

## 📝 迭代日志

### v1.1.0 (最新)
- **大屏重构**: 引入 Dashboard 二栏并列 Grid 面板分配，操作更加沉浸。
- **并发提速**: 支持 4路 并发 AI 处理队列，极速承载 400+ 标签归档。
- **配置救星**: 自动捕获缺失仓库，提供 **一键无需跳转的远端私有仓新建** 能力。
- **原生夜曲**: 完美联动系统级 `Dark / Light` 开关。

### v1.0.0
- 具备 GitLab / GitHub 单线上传下载。
- 基础静态批处分析，暗色模式支持。
