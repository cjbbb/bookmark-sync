# Bookmark Sync 架构设计与流程图解

本文档说明 Bookmark Sync（书签同步）如何把 AI 归纳、链接体检和重复项发现放在用户路径中心，同时保持 Canonical Model、同步核心、存储适配器和安全写入管道的独立性。同步仍然是底层可靠性能力：它保存用户已经审核通过的决定，不替用户做整理决定。

## 0. 产品中心与责任边界

```mermaid
flowchart LR
    Scan[扫描信号\nAI / 去重 / 链接体检] --> Review[审阅依据\n置信度 / 状态 / 路径]
    Review --> Decide[用户决定\n采纳 / 忽略 / 重测]
    Decide --> Plan[标准变更计划\n预览 / 安全分析]
    Plan --> Apply[applyRepositoryToBrowser]
    Apply --> Sync[可选跨端同步\n历史 / 快照 / 冲突]
```

### 用户路径的四个硬约束

1. **扫描是只读的**：AI、重复检测和链接体检不能直接写浏览器。
2. **结果要带不确定性**：`restricted`、`error` 和 `unsupported` 不等同于“链接已失效”。
3. **建议先审后做**：AI 输出必须通过 schema 校验，并展示对象、目标、理由和置信度。
4. **所有写入走同一条路**：无论来自 AI、规则还是手工维护，都要进入 diff / safety / apply 管道；同步只负责把结果保存到其他端。

---

## 1. 系统四层分层架构 (Layered Architecture)

系统遵循清晰的四层正交架构，核心领域层（Core）严格保持平台中立，不依赖任何浏览器特定 API。

```mermaid
flowchart TB
    %% Styling
    classDef browserLayer fill:#e0f2fe,stroke:#0284c7,stroke-width:2px,color:#0369a1;
    classDef coreLayer fill:#ede9fe,stroke:#7c3aed,stroke-width:2px,color:#5b21b6;
    classDef storageLayer fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#15803d;
    classDef organizerLayer fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#b45309;

    subgraph L1["Layer 1: 浏览器交互与适配层 (@bookmark-sync/browser-adapters)"]
        direction TB
        UI["扩展界面 (Popup / Manager UI)"]
        SW["MV3 Background Service Worker"]
        CBA["ChromiumBrowserAdapter\n(Chrome & Edge 原生书签树读写)"]
        RootNormalize["Root Slot 角色归一化\n(bookmarks-bar / other-bookmarks / mobile)"]
        UI --> SW
        SW --> CBA
        CBA --> RootNormalize
    end

    subgraph L2["Layer 2: 规范模型与同步核心 (@bookmark-sync/core)"]
        direction TB
        Canonical["规范树转换器 (canonicalizeBrowserTree)"]
        IDMap["跨端 ID 映射表 (BookmarkIdMapping)"]
        Rebase["Canonical ID Rebase 对齐 (rebaseCanonicalIds)"]
        DiffEngine["差异计算引擎 (diffRepositories)"]
        MergeEngine["纯函数 3-Way 合并核 (mergeRepositories)"]
        Safety["30% 破坏性安全阻断与快照 (analyzeDestructiveChange)"]
        Apply["浏览器写入管道 (applyRepositoryToBrowser)"]

        Canonical <--> IDMap
        Canonical --> DiffEngine
        DiffEngine --> MergeEngine
        MergeEngine --> Safety
        Safety --> Apply
    end

    subgraph L3["Layer 3: 持久化存储适配层 (@bookmark-sync/storage-adapters)"]
        direction TB
        StorageInterface["StorageAdapter 抽象接口"]
        GitHub["GitHub Contents API\n(私有仓库 / Commit 历史)"]
        WebDAV["WebDAV 适配器\n(坚果云 / Nextcloud / NAS / AList)"]
        SelfHosted["Fastify + SQLite REST 服务\n(不可变 Revision 历史库)"]
        Local["Local-Only 本地快照适配器"]

        StorageInterface --> GitHub
        StorageInterface --> WebDAV
        StorageInterface --> SelfHosted
        StorageInterface --> Local
    end

    subgraph L4["Layer 4: 独立整理与建议型 AI 引擎 (@bookmark-sync/core)"]
        direction TB
        Duplicates["URL 规范化与去重 (Exact / Normalized)"]
        RuleEngine["确定性规则引擎 (Hostname / Title 匹配)"]
        AIEngine["OpenAI 兼容建议生成 (Suggestion-Only AI)"]
        SuggestionQueue["可交互审查提案 (Reviewable Suggestions)"]

        Duplicates --> SuggestionQueue
        RuleEngine --> SuggestionQueue
        AIEngine --> SuggestionQueue
    end

    %% Cross-layer links
    L1 <-->|"BrowserBookmarkNode[] ⇄ Canonical Repo"| L2
    L2 <-->|"push() / pull() / restoreVersion()"| L3
    L4 -.->|"用户审查批准后回流"| L2

    class UI,SW,CBA,RootNormalize browserLayer;
    class Canonical,IDMap,Rebase,DiffEngine,MergeEngine,Safety,Apply coreLayer;
    class StorageInterface,GitHub,WebDAV,SelfHosted,Local storageLayer;
    class Duplicates,RuleEngine,AIEngine,SuggestionQueue organizerLayer;
```

---

## 2. 3-Way 同步与合并流程 (3-Way Merge & Sync Lifecycle)

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户 / 自动防抖触发
    participant Browser as 浏览器原生书签 (Chrome / Edge)
    participant Adapter as ChromiumBrowserAdapter
    participant Core as 同步核心 (Core Engine)
    participant Storage as 存储适配器 (GitHub / WebDAV / Server)

    User->>Browser: 新增/移动/修改/删除书签
    Browser->>Adapter: readTree() 提取原生书签树
    Adapter->>Core: 传入原生树与上一版 ID Mapping
    Core->>Core: canonicalizeBrowserTree() 生成 Local Canonical 树

    par 获取云端与基准快照
        Core->>Storage: pull() 获取 Remote Canonical 树
        Core->>Core: 读取本地持久化的 Base 快照
    end

    alt 首次同步 / 无 Mapping
        Core->>Core: rebaseCanonicalIds() 基于 URL/Path 多权重对齐
    end

    rect rgb(238, 242, 255)
        note over Core: 纯函数 3-Way Merge 计算
        Core->>Core: mergeRepositories(Base, Local, Remote)
        Core->>Core: 识别冲突 (move_move, edit_edit, delete_edit)
    end

    alt 存在未决冲突
        Core-->>User: 挂起同步并在 Manager 呈现冲突供用户决策 (Choose Local / Remote)
        User->>Core: applyConflictDecisions() 提交仲裁
    end

    rect rgb(254, 242, 242)
        note over Core: 安全防护网检查
        Core->>Core: analyzeDestructiveChange() 检查删除比例
        alt 删除节点 > 30% 且基数 >= 20
            Core-->>User: 触发破坏性安全警告，要求显式确认
            Core->>Core: 生成本地不可变安全快照 (Safety Snapshot)
        end
    end

    par 双端事务应用
        Core->>Storage: push(TargetRepo) 递增 Revision 写入
        Core->>Adapter: applyRepositoryToBrowser(TargetRepo)
    end
    Adapter->>Browser: 最小化增量执行 create/update/move/remove
    Core->>Core: 持久化更新后的 Base 快照与 ID Mapping
    Core-->>User: 同步成功完成
```

---

## 3. 冲突判定与解决决策树 (Conflict Resolution Matrix)

```mermaid
flowchart TD
    Start["检测到相同 Canonical ID 节点在双端存在差异"] --> CheckBase{"节点在 Base 快照中是否存在?"}

    CheckBase -->|不存在 (双端新增)| CheckAdd{"Local 与 Remote 内容是否完全一致?"}
    CheckAdd -->|一致| AutoAdd["自动保留该节点"]
    CheckAdd -->|不一致| ConflictAdd["标记 edit_edit 冲突 (提示选择本地或云端版本)"]

    CheckBase -->|存在| CheckDelete{"是否有单端删除了该节点?"}
    CheckDelete -->|双端均未删除| CheckContentMove{"两端内容或位置是否发生变更?"}
    CheckDelete -->|仅 Local 删除, Remote 修改| ConflictDelEdit1["标记 delete_edit / delete_move 冲突"]
    CheckDelete -->|仅 Remote 删除, Local 修改| ConflictDelEdit2["标记 delete_edit / delete_move 冲突"]
    CheckDelete -->|单端删除, 另一端无变更| AutoDelete["自动删除该节点"]

    CheckContentMove -->|两端无冲突变更| AutoMerge["自动融合属性与位移 (无缝合并)"]
    CheckContentMove -->|两端同时修改相同字段| ConflictEdit["标记 edit_edit 冲突"]
    CheckContentMove -->|两端移动至不同父目录| ConflictMove["标记 move_move 冲突"]

    ConflictAdd --> UserChoice["Manager 界面展示差异 → 用户单选确认 → 生成新 Revision"]
    ConflictDelEdit1 --> UserChoice
    ConflictDelEdit2 --> UserChoice
    ConflictEdit --> UserChoice
    ConflictMove --> UserChoice

    classDef conflictNode fill:#ffe4e6,stroke:#e11d48,stroke-width:2px,color:#9f1239;
    classDef autoNode fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#15803d;
    classDef decisionNode fill:#f1f5f9,stroke:#64748b,stroke-width:2px,color:#334155;

    class ConflictAdd,ConflictDelEdit1,ConflictDelEdit2,ConflictEdit,ConflictMove conflictNode;
    class AutoAdd,AutoDelete,AutoMerge autoNode;
    class CheckBase,CheckAdd,CheckDelete,CheckContentMove decisionNode;
```

---

## 4. 智能治理流水线 (AI, Duplicate & Link Health)

```mermaid
flowchart LR
    subgraph Input["1. 只读数据提取"]
        Repo["Canonical Repository"] --> Filter["提取脱敏信息\n(Title, URL, Hostname, FolderPath)"]
    end

    subgraph Processing["2. 整理与建议生成 (Suggestion-Only)"]
        Filter --> Dedupe["URL 规范化与精确去重\n(detectDuplicates)"]
        Filter --> Rules["确定性规则引擎\n(runRuleEngine)"]
        Filter --> AI["OpenAI 兼容模型\n(generateAiSuggestions)"]
        Filter --> Reachability["链接可达性检查\n(checkBookmarkReachability)"]
    end

    subgraph Validation["3. 结构化校验与审查"]
        Dedupe --> SchemaCheck["Schema 结构合法性校验"]
        Rules --> SchemaCheck
        AI --> SchemaCheck
        SchemaCheck --> UIReview["Manager AI 归纳队列\n(展示置信度与分类依据)"]
        Reachability --> HealthReview["Manager 链接体检\n(状态 / HTTP / 人工复核)"]
    end

    subgraph Execution["4. 用户授权与闭环执行"]
        UIReview -->|用户点击接受建议| SyncCore["标准 Sync Engine\n(经由破坏性安全检查与预览)"]
        HealthReview -->|用户确认删除或忽略| SyncCore
        SyncCore --> ApplyBrowser["applyRepositoryToBrowser"]
    end

    classDef step1 fill:#e0f2fe,stroke:#0284c7,stroke-width:2px;
    classDef step2 fill:#fef3c7,stroke:#d97706,stroke-width:2px;
    classDef step3 fill:#ede9fe,stroke:#7c3aed,stroke-width:2px;
    classDef step4 fill:#dcfce7,stroke:#16a34a,stroke-width:2px;

    class Repo,Filter step1;
    class Dedupe,Rules,AI,Reachability step2;
    class SchemaCheck,UIReview,HealthReview step3;
    class SyncCore,ApplyBrowser step4;
```

---

## 5. 跨端 Canonical ID 对齐原理 (ID Mapping Model)

```mermaid
flowchart TB
    subgraph Chrome["Google Chrome (macOS / Windows)"]
        C1["Native ID: 101\nTitle: GitHub\nURL: https://github.com"]
        C2["Native ID: 102\nTitle: Google\nURL: https://google.com"]
    end

    subgraph Mapping["本地 ID 映射层 (BookmarkIdMapping)"]
        M1["Mapping Entry 1\ncanonicalId: c_9a7f\nbrowserBookmarkId: 101\nnormalizedUrl: https://github.com\npathKey: root:bookmarks-bar/Dev"]
        M2["Mapping Entry 2\ncanonicalId: c_3e1b\nbrowserBookmarkId: 102\nnormalizedUrl: https://google.com\npathKey: root:bookmarks-bar/Search"]
    end

    subgraph Canonical["全局权威规范树 (Canonical Repository)"]
        CN1["Canonical Node: c_9a7f\nType: bookmark\nTitle: GitHub\nURL: https://github.com"]
        CN2["Canonical Node: c_3e1b\nType: bookmark\nTitle: Google\nURL: https://google.com"]
    end

    subgraph Edge["Microsoft Edge (Linux / Windows)"]
        E1["Native ID: 2048\nTitle: GitHub\nURL: https://github.com"]
        E2["Native ID: 2049\nTitle: Google\nURL: https://google.com"]
    end

    C1 <--> M1 <--> CN1
    C2 <--> M2 <--> CN2
    CN1 <--> Edge
    CN2 <--> Edge
```
