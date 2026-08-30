# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product thesis

Bookmark Sync is a bookmark intelligence workspace. Its job is to keep a personal bookmark library useful over time: surface duplicate saves, identify links that no longer work, and turn a messy folder tree into reviewable organization suggestions. Cross-browser sync remains the safety foundation that preserves those decisions across devices; it is no longer the primary reason to open the product.

## Users

- **主目标用户**：知识工作者、开发者、研究者与重度网页浏览用户，他们把浏览器收藏夹当作个人知识入口。
- **核心痛点与诉求**：
  - 收藏越积越多，重复、失效和归错位置的链接逐渐降低查找效率；
  - 想借助 AI 做初步归纳，但不接受模型未经确认就移动、删除或重命名内容；
  - 在不同浏览器和设备之间工作，需要数据可拥有、可预览、可回滚。

## Product Purpose

- 让用户用一次扫描看清收藏夹的健康状况，再用一条可审计的建议队列完成整理。
- **成功的定义**：
  - 用户进入工作台后能在几秒内知道“哪里需要处理、下一步做什么”；
  - AI、规则和去重能力只产出可解释、可忽略、可逐条采纳的建议；
  - 链接有效性检测能区分失效、受限和自动检测受阻，不把不确定结果伪装成事实；
  - 被采纳的变更经过统一预览、安全检查和浏览器写入管道，并能恢复；
  - 同步、历史和安全快照在后台可靠地保存用户已经做出的决定。

## Primary workflow

1. **扫描信号**：打开工作台，运行 AI 归纳或链接体检；查看重复 URL、待审核建议和链接异常。
2. **审阅依据**：每条 AI 建议显示原收藏、目标位置、置信度与理由；链接检测显示状态、HTTP 信息和人工复核入口。
3. **确认应用**：用户逐条采纳、忽略或重新检测。真正的移动、新建文件夹和删除仍需经过标准变更计划与安全防护。
4. **保存决定**：可选的跨端同步把确认后的规范树写入其他浏览器；版本历史和安全快照提供追加式恢复路径。

## Positioning

- **收藏夹健康工作台**：首页展示待处理信号与下一步，而不是把同步状态当成唯一主线。
- **Suggestion-Only AI**：AI 与规则引擎负责发现模式并提出建议，最终决定权始终归用户。
- **可疑链接审计**：可达性检查是只读检查；“受限”或“自动检测失败”必须保留不确定性并支持人工打开。
- **浏览器中立的安全底座**：Canonical ID、纯函数 3-way merge、变更预览、破坏性变更阻断和本地安全快照保证跨端操作可解释、可回滚。
- **隐私自治**：AI 端点可配置，存储可选本地、GitHub、WebDAV 或自建服务；凭据不进入规范仓库或日志。

## Capabilities and constraints

### Primary capabilities

- AI 归纳：基于标题、URL、主机名和文件夹路径生成移动、新建文件夹、合并文件夹和可能重复项建议；
- 规则与去重：精确 URL 和规范化 URL 分组，确定性规则与 AI 输出使用同一审查队列；
- 链接体检：流式检查可达、失效、受限、错误和不支持状态，支持重测、人工访问、忽略误报与安全删除；
- 工作台：集中呈现信号数量、审阅路径和“扫描 → 审阅 → 应用”的操作闭环。

### Foundation capabilities

- Chromium 浏览器适配层（`ChromiumBrowserAdapter`），兼容 Chrome 与 Edge；
- Local-Only、GitHub Contents API、WebDAV 和 Self-hosted REST 存储适配器；
- Publish、Mirror、Two-Way Sync 三种同步策略；
- 基于 Base 快照的纯函数 3-way merge，明确处理 edit/move/delete 冲突；
- 30% 破坏性变更安全阻断、本地安全快照、历史版本与追加式恢复。

### Architectural constraints

- 四层边界保持明确：Browser Adapters、Canonical Model / Sync Core、Storage Adapters、Independent Organizer；
- Core 严禁依赖浏览器特定 API；
- Canonical ID 是跨浏览器身份，持久化仓库中绝不使用 Chrome 或 Edge 原生书签 ID；
- 浏览器写入必须统一经由 `applyRepositoryToBrowser`；
- AI 只可产生经 schema 校验的建议，不能直接执行增删改；
- 凭据只保存在 `chrome.storage.local`，严禁打印、提交或写入跨端仓库。

## Brand commitments

- **产品命名**：Bookmark Sync（书签同步）；名称保留，用于表达跨端安全底座，不限制产品的智能治理范围。
- **界面重心**：专业、清楚、低焦虑；首屏先呈现收藏夹信号和可执行队列，同步、历史、设置归入“数据与安全”。
- **信任原则**：所有智能输出都要显示依据和边界；所有写入都要显示影响、确认点和恢复路径。

## Evidence on hand

- `extension/` 已有 MV3 Background Service Worker、Popup 快捷入口和 Manager 工作台；
- `packages/core/` 已有 canonical model、diff、merge、safety、duplicates、reachability 与 organizer provider；
- `packages/browser-adapters/`、`packages/storage-adapters/` 和 `server/` 提供浏览器、存储与可选服务端实现；
- `npm test`、`npm run typecheck` 和 `npm run build` 是交付前必须通过的检查。

## Product principles

1. **先看清，再自动化（Inspect Before Automate）**：先显示问题和依据，再提供动作。
2. **AI 只提建议，用户做决定（Suggestion-Only AI）**：模型没有静默写入权限。
3. **不确定性要被看见（Honest Health Signals）**：受限与检测失败不能冒充失效。
4. **安全与可逆优先（Safety & Reversibility First）**：预览、快照、冲突暂停和追加式恢复贯穿所有写入。
5. **表现与底座解耦（Strict Architectural Decoupling）**：智能治理可以演进，纯核心与适配器边界不被 UI 牵动。
6. **隐私自治（Privacy & Self-Sovereignty）**：用户选择 AI 端点和存储方式，敏感信息最小化流动。
