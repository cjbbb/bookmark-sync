# 🔖 智能书签同步 — Chrome/Edge 浏览器插件

> 支持 GitLab/GitHub 同步 + AI 智能分类的书签管理工具

## ✨ 功能特点

- **GitLab 同步**（推荐）— 中国大陆可直接访问，无需翻墙
- **GitHub 同步**（可选）— 需要能访问 github.com
- **AI 智能分类** — 集成 DeepSeek / MiniMax API，自动分析书签并建议分类
- **用户确认机制** — AI 建议需用户逐条确认后才执行，安全可控
- **暗色主题** — 精美的 Glassmorphism 设计风格

## 🚀 安装方法

### 方式一：开发者模式加载（推荐）

1. 打开 Chrome 或 Edge 浏览器
2. 访问扩展程序页面：
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
3. 打开右上角的 **"开发者模式"**
4. 点击 **"加载已解压的扩展程序"**
5. 选择本项目的 `bookmark` 文件夹

### 方式二：打包安装

1. 在扩展程序页面点击 **"打包扩展程序"**
2. 选择项目目录，生成 `.crx` 文件
3. 将 `.crx` 文件拖到扩展程序页面安装

## ⚙️ 配置

### 同步配置（GitLab / GitHub）

1. 点击插件弹窗右上角的 ⚙️ 按钮进入设置页面
2. 选择同步平台：

#### GitLab 配置（推荐，中国大陆免翻墙）
- **GitLab 地址**: 默认 `https://gitlab.com`，也支持自建实例
- **Personal Access Token**: 到 [GitLab Token 页面](https://gitlab.com/-/user_settings/personal_access_tokens) 创建，需要 `api` 权限
- **项目 ID**: 在 GitLab 项目主页可以找到数字 ID，或使用 `用户名/项目名` 格式

> 💡 **使用前准备**: 在 GitLab 上创建一个**私有仓库**（如 `bookmarks`），用于存储书签数据。

#### GitHub 配置
- **Personal Access Token**: 到 [GitHub Token 页面](https://github.com/settings/tokens/new) 创建，需要 `repo` 权限
- **仓库所有者**: 你的 GitHub 用户名
- **仓库名**: 如 `bookmarks`

3. 点击 **"测试连接"** 确认配置正确
4. 点击 **"保存配置"**

### AI 分类配置

1. 在设置页面选择 AI 提供商：

#### DeepSeek（推荐）
- **API Key**: 到 [DeepSeek 平台](https://platform.deepseek.com/api_keys) 获取
- **模型**: 推荐 `deepseek-chat`

#### MiniMax
- **API Key**: 到 [MiniMax 平台](https://platform.minimaxi.com/user-center/basic-information/interface-key) 获取
- **模型**: 推荐 `MiniMax-Text-01`

2. 点击 **"测试连接"** 确认 API 可用
3. 点击 **"保存配置"**

## 📖 使用指南

### 查看书签
- 点击浏览器工具栏的插件图标，打开弹窗
- 在 **"书签"** 标签页查看按文件夹分组的书签树
- 使用顶部搜索栏快速搜索

### 同步书签
- 切换到 **"同步"** 标签页
- **上传**: 将本地书签同步到远程 Git 仓库
- **下载**: 从远程仓库拉取书签并合并到本地（不会重复添加已有书签）

### AI 智能分类
1. 切换到 **"AI 分类"** 标签页
2. 点击 **"开始 AI 分类"** 按钮
3. 等待 AI 分析完成（可能需要几秒到十几秒）
4. 查看 AI 的分类建议，每条建议包含：
   - 书签标题
   - 当前分类 → 建议新分类
   - AI 的分类理由
5. 逐条点击 **✓ 接受** 或 **✕ 拒绝**（也可点击"全部接受"/"全部拒绝"）
6. 确认后点击 **"应用已选建议"** 执行操作

## 🏗️ 项目结构

```
bookmark/
├── manifest.json              # Manifest V3 配置
├── popup/                     # 弹出窗口
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── options/                   # 设置页面
│   ├── options.html
│   ├── options.css
│   └── options.js
├── background/                # Service Worker
│   └── service-worker.js
├── lib/                       # 核心库
│   ├── bookmark-manager.js    # 书签管理
│   ├── sync/
│   │   ├── gitlab-sync.js     # GitLab 同步
│   │   ├── github-sync.js     # GitHub 同步
│   │   └── sync-engine.js     # 同步引擎
│   └── ai/
│       ├── ai-engine.js       # AI 引擎
│       ├── deepseek-provider.js
│       └── minimax-provider.js
└── icons/                     # 插件图标
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 🔒 隐私说明

- 所有配置（Token、API Key）仅存储在浏览器本地 (`chrome.storage.local`)，不会上传到第三方
- 书签数据仅同步到你自己配置的 Git 仓库
- AI 分类时，书签标题和 URL 会发送到你选择的 AI API 进行分析

## 📝 更新日志

### v1.0.0
- 初始版本
- 支持 GitLab / GitHub 书签同步
- 集成 DeepSeek / MiniMax AI 智能分类
- 暗色 Glassmorphism 主题界面
