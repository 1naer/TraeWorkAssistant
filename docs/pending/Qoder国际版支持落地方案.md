# Qoder 国际版支持落地方案（Qoder Global / qoder.com 体系）

> - **日期**：2026-10-18
> - **状态**：待评审（pending）
> - **关联**：`docs/pending/Buddy国际版支持落地方案.md`（独立池范式先例，2026-10-15 Gate 已全清零）/ `docs/completed/Qoder平台支持设计方案.md` v1.4.2（CN 版全量交付底稿）/ `docs/completed/Qoder外部项目调研归档.md`（国际站实现级情报底稿）/ backlog F-80-余（Global 区 2026-10-02 决策留档：账号-区域关系 + COSY Global 域签名两大未决项）
> - **结论先行**：国际版走**独立池 `qoder-global`**，与国内 `qoder` 池账号、凭证、调度、指纹、记账、UI 六面完全隔离；内核（`qoder_common` / `qoder_checkin` / `qoder_credits` / `qoder_sign` / `qoder_upstream` / `qoder_route`）**区域参数化复用，不复制代码**。两个历史未决项均有现成底稿——① 账号-区域关系 → Gate 探测 R-G1；② COSY Global 域签名 → **调研归档 §2.1/2.2/2.7 即 Global 域 COSY 签名链完整底稿**（QoderGateway 全部面向 `.sh` 国际域），仅差现版客户端复核。
> - **战略动因**：Qoder CN 桌面端官宣 **2027-09-05 停运**（仅剩约 11 个月），国际版是 Qoder 生态长期存续的唯一延续路径；且国际站免费积分稳态 **≈3,000 Credits/月/账号** + **Qwen3.8-Flash 0 系数免费模型**，网关侧多一个国际模型池（与 Trae / wb / buddy-ai / qoder-CN 形成互补）。Buddy 国际版已开「独立池」先例，架构范式已被项目方接受。
> - **开工硬前置**：§5 Gate 探测清单（R-G1~G9）——一次真实国际账号登录收口阻塞层，**缺口未闭合前对应模块只做骨架不接线**（沿用 F-80「不写无端点的假实现」红线）。

---

## 📋 1. 背景与目标

### 🌐 1.1 域名族谱与角色

| 域名 | 产品定位 | 本方案角色 |
|---|---|---|
| `qoder.com` | 国际版门户 / 官网 / 账号中心（Settings > Usage 查余额） | 设备流授权页（`/device/selectAccounts`）、PAT 管理页、余额查看入口 |
| `openapi.qoder.sh` | 国际 OpenAPI | token 刷新（`/api/v1/deviceToken/refresh`、`jrt-`→`/api/v1/jobToken/refresh`）、quota（`/api/v2/quota/usage`）、sash campaigns（待 R-G4 确认 base）、设备流 poll |
| `center.qoder.sh` | 国际 algo 中心 | PAT→jobToken 交换（`/algo/api/v3/user/jobToken?Encode=1`，appcode+signature 头，调研归档 §2.7） |
| `api3.qoder.sh` | 国际对话/推理网关 | **chat 上游执行域**（`QoderRegion::Global` 已预留，见 [qoder_upstream.rs](file:///d:/code/AIWorkAssistant_feature/src-tauri/src/tasks/qoder_upstream.rs#L96)），请求形态待 R-G3 |

对应国内族（现状不动）：

| 国内域 | 角色 |
|---|---|
| `openapi.qoder.com.cn` | OpenAPI：sash campaigns / claim、quota、userinfo、jobToken exchange、设备流 |
| `gateway.qoder.com.cn` | CN 推理网关（`QODER_CHAT_URL`，COSY 签名，`Cosy-Clienttype: "5"`） |
| `qoder.cn` / `qoder.com.cn` | CN 门户 / PAT 管理（`/account/integrations`）/ 设备流授权页 |

### 🎯 1.2 目标

1. **账号接入**：国际账号可登录（OAuth 设备流）/ 导入（PAT / CLI 本地登录态）、可管理、可查积分，入 `qoder-global` 独立池。
2. **自动领取**：每日领取 100 Credits（官方每日活动）自动化，幂等 claim，10:15 单次调度覆盖。
3. **网关接入**：`qoder-global` 档位接入 API 管理统一出口 `/v1/*`，Global 模型目录可路由（解除现有 `entry_is_global_only` fail-closed 404 限制）；Qwen3.8-Flash 0 系数免费模型进目录。
4. **不交织**：国内 `qoder` 池数据、配置、调度、失败域**零改动**；国际池故障不得触发国内池换号/熔断，反之亦然。
5. **复用内核**：qoder 模块族按区域参数化复用，不复制代码（对齐 buddy-ai 内核复用原则）。

### 🚫 1.3 非目标

- ❌ **不做注册/试用类能力**：官方明文「多建试用账户将冻结」（虚拟机登录亦不支持）——比 CN 风控红线更硬，**仅面向存量个人账号**，不做批量注册、验证码绕过。
- ❌ 不做 QoderWake / Cloud Agents / 移动端 / 网页版的独立接入（账号级 Credits 全端共享，无需逐端接入）。
- ❌ 不做 JetBrains 插件独立端（共享账号，自然覆盖）。
- ❌ 不做国际版模型倍率自动抓取（首版静态配置，官网实际值人工修正口径）。
- ❌ 不做 CN Credits 与 Intl Credits 的任何互通/换算（账号体系独立、定价不等价）。

---

## 📊 2. 现状盘点

### ✅ 2.1 已实现（可直接复用的 CN 底座）

| 能力 | 位置 | 国际版适配说明 |
|---|---|---|
| 区域枚举预留 | [qoder_upstream.rs](file:///d:/code/AIWorkAssistant_feature/src-tauri/src/tasks/qoder_upstream.rs#L80-L97) `QoderRegion::{Global, Cn}`，`Global => "https://api3.qoder.sh/"` | 端点 base 已就位，仅请求形态待探（R-G3） |
| Global 专属模型判定 | [qoder_route.rs](file:///d:/code/AIWorkAssistant_feature/src-tauri/src/api_server/qoder_route.rs#L351) `entry_is_global_only()`：双路 resolve 确定性证据 + fail-closed 404 | 接线后此守卫**按池放行**（Global 池内合法路由），CN 池行为不变 |
| COSY 签名链 | [qoder_sign.rs](file:///d:/code/AIWorkAssistant_feature/src-tauri/src/tasks/qoder_sign.rs) `build_cosy_headers`（CN 版参数：clienttype "5"、cosy-version 0.4.3） | 区域参数化（Intl 参数取调研归档 §2.1/2.2：cosyVersion 0.1.43、clientip 硬编码、RSA 公钥加密 temp_key，现版复核 R-G3） |
| 设备流登录 | [oauth.rs](file:///d:/code/AIWorkAssistant_feature/src-tauri/src/commands/qoder/oauth.rs)（CN：`qoder.cn` 授权页 + deviceToken/poll） | 区域参数化（Intl：client_id `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`、`qoder.com/device/selectAccounts`、`openapi.qoder.sh/api/v1/deviceToken/poll`，归档 §2.8 底稿，R-G2 复核） |
| 签到引擎 | `tasks/qoder_checkin.rs`（campaigns → claim 幂等 → 四分类 → 复查恢复） | 端点 base + Cosy-ClientType 区域化（R-G4） |
| 积分引擎 | `tasks/qoder_credits.rs`（三通道 + 600s 缓存 + stale-on-error + 逐包明细 source: plan/addon） | FEFO/Plan/Add-on 扣减口径**官方文档逐字同构**（见附录 A），仅 base 域切换（R-G5） |
| token 生命周期 | `qoder_common.rs::ensure_fresh` + 6h 兜底刷新 | Intl 前缀分派同构：`jrt-`→jobToken/refresh、其余→deviceToken/refresh（归档 §2.5，R-G7） |
| 每账号稳定指纹 | §5.10 模型（CN：machine_id 32hex + 本地覆写三文件） | **Intl 指纹格式不同**：machine_id = uuid4 36 字符、machine_token 68 字符 base64url、machine_type 18 hex（归档 §2.3）→ 生成器按区分派（R-G9 复核） |
| PAT 通道 | `commands/qoder/accounts.rs` PAT 导入 + `exchange_job_token` | Intl PAT 换取路径不同：`center.qoder.sh/algo/api/v3/user/jobToken?Encode=1` + appcode/signature 头（归档 §2.7，R-G6） |
| 调度三件套 | TASKS 注册 + schtasks 双轨 + 启动补签 | 纯注册新任务行（§4.5） |
| 前端五页 | [src/pages/qoder/](file:///d:/code/AIWorkAssistant_feature/src/pages/qoder)：Overview / Accounts / Checkin / Settings / ApiService + HelpModal | 区域 Tab 分区展示（§4.6） |

### ⚠️ 2.2 缺口清单（本方案工作量主体）

| # | 缺口 | 位置 | 现状 |
|---|---|---|---|
| G-1 | 端点常量单源化 | [qoder_common.rs](file:///d:/code/AIWorkAssistant_feature/src-tauri/src/tasks/qoder_common.rs#L30-L50) `OPEN_API_BASE`/`WEB_BASE`/`COSY_CLIENT_TYPE`/`CLIENT_USER_AGENT` 等 6 常量硬编码 CN 值 | 需提升为 `QoderRegionEndpoints` 结构体（CN/Global 两份静态实例，对齐 Buddy 方案 §4.1 同款手法） |
| G-2 | Intl 登录/导入入口 | oauth.rs / accounts.rs | 设备流 client_id、授权页、poll 域均 CN 硬编码；PAT 管理页 URL 与换取端点 CN 专用 |
| G-3 | 签到活动 Intl 化 | qoder_checkin.rs | campaigns/claim 端点 + Cosy-ClientType 取值 Intl 版待探（R-G4）；**Intl 无「每日登录奖励」双活动**（CN 独有），活动面为单一「每日领取 100」 |
| G-4 | chat 上游 Global 分流 | [qoder_route.rs](file:///d:/code/AIWorkAssistant_feature/src-tauri/src/api_server/qoder_route.rs#L630-L647)（v1 恒 CN 区执行 + `entry_is_global_only` 404）| 接线 Global 区：`QODER_CHAT_URL` 区域化 + dispatch 源判定按池分流（代码注释已预埋改造点） |
| G-5 | 模型目录/倍率 Intl | qoder_catalog.rs（`gateway.qoder.com.cn/algo/api/v2/model/list`） | Intl 目录源与倍率待探（R-G8）；Qwen3.8-Flash 0 系数静态标注 |
| G-6 | 池隔离 | qoder_route.rs `pool_constraints("qoder")`、池存储四表 | Intl 账号与 CN 账号**不得混居**：独立池 `qoder-global`（§3.4 隔离清单） |
| G-7 | 记账口径 | usage bucket | 无 `qoder-global` bucket，国际用量与国内混计 |
| G-8 | 指纹生成器分区 | 指纹生成与本地覆写（CN 32hex 格式） | Intl machine_id = uuid4 格式，生成器 + 覆写目标路径按区分派 |
| G-9 | 前端分区 | 五页 + PoolHealthBadges / API 服务档位 | 无区域列/分区 UI；`qoder-global` 档位默认关 |

### 🧬 2.3 产品端差异（CN 全家桶 vs Intl 多端独立）

| 维度 | CN（现状） | Intl（目标态认知） |
|---|---|---|
| 端形态 | 全家桶：IDE = QoderWork = Desktop 同一产品 | **Qoder 桌面端（IDE）与 CLI 等多端独立产品线**，账号级 Credits 全端共享 |
| IDE 数据目录 | `%APPDATA%\QoderCN\`（`com.qodercn.app.stable`） | `com.qoder.app.<channel>`（F-80 方案 §2.3 已留档） |
| CLI 认证目录 | `~/.qoder-cn`（R-3 实测无明文凭证） | `~/.qoder/.auth/`（**id + user 两文件**：user = AES-128-CBC(key=IV=machine_id[:16]) 身份 JSON，归档 §2.4——**Intl CLI 本地登录态可直接解密导入**，优于 CN） |
| PAT 入口 | `qoder.com.cn/account/integrations` | `qoder.com` 账号中心（具体路径 R-G6 探测） |
| 每日活动 | 双活动（0 点签到 + 10 点登录奖励，campaigns 同源） | 单活动「每日领取 100 Credits」（10:00 开窗，campaigns 体系，Intl 自 v0.8.18 统一走 campaigns——归档 §3.2 情报） |

---

## 🏗️ 3. 总体设计：独立池 `qoder-global`

### 🧭 3.1 设计原则：「不交织」六条硬约束（照抄 buddy-ai 范式）

1. **账号分池**：国际账号入 `qoder-global` 池（独立表 + 独立 token store 键空间），禁止与 `qoder` 池混居；导入命令区域必选校验（显式选 Global 时校验凭证域特征，二者不一致直接拒绝）。
2. **配置分键**：调度、签到、积分同步等配置键独立（`qoder_global_*`），`Settings` 不复用国内字段。
3. **失败域隔离**：换号轮换、冷却、熔断在池边界内闭环；`/healthz` 按池独立上报 selectable。
4. **指纹分区**：每账号稳定指纹（非随机轮换）**双区共用原则**，但生成算法与覆写目标按区分派（§4.4）。
5. **记账分区**：`UsageBucket::QoderGlobal => "qoder-global"`，口径不变。
6. **UI 分区**：五页均以区域维度分区展示，不出现同列表混排。

### 🗺️ 3.2 架构与数据流

```text
                     网关统一出口 /v1/*（不变）
                              │
                     dispatch（模型路由）
                              │
            ┌─────────────────┼──────────────────┐
            │                 │                  │
      qoder 池（CN，不动）  qoder-global 池（新增）  trae/wb/buddy-ai/custom 池
            │                 │
            │     QoderRegionEndpoints{ region: Global }
            │                 │
            └────────┬────────┘
                     │  区域参数化内核（qoder_common/qoder_checkin/
                     │  qoder_credits/qoder_sign/qoder_upstream 按区分流）
                     ▼
   CN: openapi.qoder.com.cn + gateway.qoder.com.cn
   Intl: openapi.qoder.sh + center.qoder.sh + api3.qoder.sh
```

**内核复用方式**：qoder 模块族内部引入 `region` 维度（`QoderCreds` 增 `global_region: bool` 或池级上下文注入），`QoderRegionEndpoints` 结构体承载全部端点/常量差异；`qoder_route` 的取号、冷却、粘性按池视图绑定，`entry_is_global_only` 守卫改为「CN 池禁 Global 专属、Global 池全放行」。

### 📌 3.3 端点矩阵（按调研归档情报预填，标注探测状态）

| 用途 | CN（现状） | Intl（目标态） | 状态 |
|---|---|---|---|
| campaigns 列表 | `{openApi}/sash/api/v1/me/campaigns` | `{openApi?}.qoder.sh/sash/api/v1/me/campaigns` | ⏳ R-G4（归档 §3.2：Intl 自 v0.8.18 统一 campaigns，`claimStatus=="CLAIMABLE"` 唯一权威） |
| campaign claim | `.../campaigns/{id}/claim`（幂等 replayed） | 同路径 | ⏳ R-G4 |
| 用量查询 | `{openApi}/api/v2/quota/usage` | `openapi.qoder.sh/api/v2/quota/usage`（Bearer security_oauth_token） | ⏳ R-G5（归档 §2.5 底稿） |
| 设备流 poll | `qoder.com.cn/device/selectAccounts` + `/api/v1/deviceToken/poll` | `qoder.com/device/selectAccounts?nonce=&challenge=&challenge_method=S256&machine_id=&client_id=e883ade2-...` + `openapi.qoder.sh/api/v1/deviceToken/poll`（GET，404=等待，1s 间隔 300s 超时） | ⏳ R-G2（归档 §2.8 底稿，client_id 现版复核） |
| token 刷新 | `/api/v1/deviceToken/refresh` | `jrt-`→`/api/v1/jobToken/refresh`（token_key="token"）；其余→`/api/v1/deviceToken/refresh`（token_key="device_token"）；UA `qoder/1.1.16`；REFRESH_INTERVAL 6h | ⏳ R-G7（归档 §2.5 底稿） |
| PAT 换 jobToken | `POST /api/v1/jobToken/exchange`（pt-→jt-） | `POST center.qoder.sh/algo/api/v3/user/jobToken?Encode=1`（appcode=cosy + signature=md5("cosy&{SECRET}&{RFC1123}") 头，date 用 RFC1123 GMT；响应 `id→aid/uid, name, userType, securityOauthToken, refreshToken`） | ⏳ R-G6（归档 §2.7 底稿；`?Encode=1` 自定义 base64 三段重排 + 65 字符表，归档 §2.7） |
| chat 上游 | `gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?...&Encode=1` | `api3.qoder.sh/...`（路径/版本/Encode 位待探） | ⏳ R-G3（MITM SOP） |
| 模型目录 | `gateway.qoder.com.cn/algo/api/v2/model/list` | Intl 域对应端点 | ⏳ R-G8 |
| COSY 签名参数 | clienttype "5"、cosy-version 0.4.3、machine_os x86_64_win32 | cosyVersion "0.1.43"、clienttype "5"、cosy-clientip 硬编码 `169.254.198.161`、UA `Go-http-client/2.0`、login-version v2、RSA 1024 公钥（归档 §2.1/2.2 全量） | ⏳ R-G3 复核现版 |
| PAT 管理页 | `qoder.com.cn/account/integrations` | `qoder.com` 账号中心 | ⏳ R-G6 |

### 🏷️ 3.4 隔离清单（命名约定）

| 维度 | CN（现状，不动） | Intl（新增，标识定稿 `qoder-global`，评审可改） |
|---|---|---|
| 产品标识 | qoder | **qoder-global**（池 id / app_id / bucket / 前端档位全链统一） |
| 池 id | `qoder` | `qoder-global` |
| 账号/凭证/签到/积分存储 | `qoder_accounts` / `qoder_tokens` / `qoder_checkin_results` / `qoder_credits_history` 四表（schema v3） | `qoder_global_*` 四表（schema v3→v4 迁移；若 store 现状更宜分库则从其约定，评审决策点 D-3） |
| token store 键空间 | `qoder_tokens` | `qoder_global_tokens`（同文件独立命名空间，避免双文件迁移成本） |
| 账号 id 前缀 | `"qd-" + sha256[..12]` | `"qdg-" + sha256[..12]`（防跨池同账号 id 碰撞） |
| 端点常量 | `qoder_common.rs` 顶部常量 | `QoderRegionEndpoints::global()` 静态实例 |
| 用量 bucket | 既有 qoder bucket | `UsageBucket::QoderGlobal => "qoder-global"` |
| 调度策略/粘性开关 | `qoder_sticky_enabled` 等 | `qoder_global_sticky_enabled` 等独立键 |
| 签到/快照任务 | `qoder-checkin` / `qoder-credits-snapshot` / 6h refresh | `qoder-global-checkin` / `qoder-global-credits-snapshot` / `qoder-global-refresh` |
| 池运行锁 | 既有 | `qoder_global_pool_lock` |
| UI 档位 | qoder 档 | **QoderGlobal** 独立档位（API 服务页/健康徽标与 qoder 视觉区分），默认关 |

### 📊 3.5 国内已实现功能 → 国际版（qoder-global）功能对照（菜单级）

> 国内 `qoder` 池功能面为蓝本，逐菜单映射国际版：**内核复用 / 机制复用 + 参数分区 / 新实现** 三类。

| 国内菜单/页面（CN 已交付） | 国际版对应 | 复用方式 |
|---|---|---|
| **Overview**：统计卡 + 近 30 天签到趋势 + 积分榜 + 配置导航 Step | 同构；活动说明卡换「每日领取 100」单活动；新增「CN 停运倒计时 / 国际版延续」提示位 | 页面骨架复用 + 区域分区 |
| **Accounts**：账号池 + 凭证来源徽标（PAT/OAuth/IDE 扫描）+ 指纹列与弹框 + 一键切换/快照 + CLI 状态条 + 导出导入 / env_reset | 同构；导入通道 Intl 化（§4.1）：PAT（qoder.com）/ OAuth 设备流（qoder.com + openapi.qoder.sh）/ **CLI 登录态解密导入**（`~/.qoder/.auth/`，Intl 特有通道）/ 桌面端存储扫描（`com.qoder.app.<channel>`）；导出导入 `kind=aiwork-qoder-global-pool`；env_reset 语义块按 Intl 目录族重排 | 命令域复用 + 参数分区 + 新增 CLI 解密导入函数 |
| **Checkin**：签到控制卡 + 双活动说明卡 + 进度 NDJSON 流 | **每日领取 100 Credits**（单活动）：控制卡 + 活动说明（10:00 开窗 / 桌面端渠道 / 30 天有效 / 错过不补）+ 幂等说明 | 引擎复用（campaigns claim 幂等 + 复查恢复全量继承），活动面裁剪为单活动 |
| **Credits**：KPI（Plan/Add-on/总余额）+ 近 7 日趋势 + 到期日历 + 产品线横幅 | 同构；FEFO / 同到期先 Plan 后 Add-on / 30 天逐包有效——**官方规则与 CN 实现逐字同构**（附录 A）；产品线横幅改为「CN/Intl Credits 不互通」提示 | 引擎复用 + base 域切换 + 解析字段 R-G5 对齐 |
| **Settings**：客户端路径 + 定时 + 自动签到开关 + 合规提示 | 同构；客户端路径 = Intl Qoder 桌面端（`com.qoder.app.<channel>`）；新增「每日领取窗口 10:00 UTC+8」固定说明；风险提示区增加「多建试用账户冻结」红线 | 复用 + 文案分区 |
| **ApiService（API 管理接入）**：调度策略中心 / 预设 / API Key / 用量统计 / 池指标 / 模型目录 / 资源调度菜单 | **`qoder-global` 独立档位**（默认关）：模型目录 Intl 化（含 Qwen3.8-Flash 0 系数标注 + 倍率静态配置）；Global 专属模型解除 404、在 Global 池内合法路由；池健康五池化 | 路由/上游/签名内核区域参数化（§4.2），调度/Key/用量组件复用 |
| HelpModal | 帮助内容分区（Intl 套餐/额度/领取规则，引用附录 A） | 内容扩展 |

---

## 🔧 4. 关键设计点

### 4.1 账号与凭证

- **端点单源化（G-1）**：`qoder_common.rs` 顶部 6 常量提升为 `QoderRegionEndpoints` 结构体（字段：open_api / web_base / chat_host / catalog_url / client_type / client_ua / cosy_version / machine_os / auth_page / poll_url / refresh_url / pat_page / region），CN/Global 两份静态实例；CN 实例值与现状逐字一致（回归保障）。
- **登录（G-2）**：设备流区域参数化——client_id（Intl `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`，R-G2 复核现版有效性）、授权页（`qoder.com/device/selectAccounts`，PKCE S256 + nonce + machine_id，归档 §2.8）、poll（`openapi.qoder.sh`，GET 404=等待/200=就绪，1s 间隔 300s 超时）。探测结论未出前 Intl 登录按钮置灰 + 提示「待上游验证」，仅开放手工导入。
- **导入通道（Intl 特有增强）**：新增 CLI 登录态解密导入——读 `~/.qoder/.auth/id`（machine_id 裸文本）+ `.auth/user`（AES-128-CBC，key=IV=machine_id 前 16 ASCII 字符，身份 JSON 兼容 camel/snake 双命名，归档 §2.4）；这是 Intl 优于 CN 的合规凭证通道（用户本机自己的登录态）。
- **刷新**：`ensure_fresh` 按 `refresh_token` 前缀分派（Intl：`jrt-`→jobToken/refresh、其余→deviceToken/refresh，token_key 字段名两分支不同，归档 §2.5）；6h 兜底刷新任务镜像复制为 `qoder-global-refresh`。
- **刷新失败语义**：R-G2/G7 通过前，Intl 账号刷新失败按「暂态网络」处理**不标记 needs_relogin**（避免误杀真实有效凭证），落 app_log 留痕（对齐 Buddy 方案同款保护）。
- **PAT（G-2）**：Intl PAT 管理页与换取端点待 R-G6；`?Encode=1` 自定义 base64（标准 base64 → 三段重排 → 65 字符表 `_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!`，pad=`$`）纯算法可直接翻译（归档 §6.1 移植要点已列）。

### 4.2 网关转发与调度（API 管理接入）

- **取号**：qoder 池取号函数拆双池视图（CN 读 `qoder_*` 表，Intl 读 `qoder_global_*` 表）；dispatch `priority` 数组支持 `"qoder-global"` 档位（与 `"qoder"` 平级，**默认不启用**，用户在 API 服务页显式开启）。
- **区域执行（G-4）**：[qoder_route.rs](file:///d:/code/AIWorkAssistant_feature/src-tauri/src/api_server/qoder_route.rs#L630-L647) 两处「区域边界（v1）：恒 CN 区执行」改造点——按请求上下文绑定池视图：CN 池 → `QoderRegion::Cn`（现状行为逐字不变），Global 池 → `QoderRegion::Global`（`api3.qoder.sh`，端点形态 R-G3 固化）；`entry_is_global_only` 守卫改为按池判定（CN 池维持 fail-closed 404 + 目录标注，Global 池内 Global 专属模型合法路由）。
- **粘性**：`qoder_sticky_enabled` 独立出 `qoder_global_sticky_enabled`；粘性绑定键独立前缀（`qg:`，落码时对齐现状）。
- **冷却**：模型级冷却表 Global 池独立实例（键仍为裸 model 名，池边界即隔离）；`PoolStatus.cooling` / `hard_credit` 语义不变。
- **签名（G-4 前置）**：`build_cosy_headers` 区域参数化——CN 分支零改动；Global 分支按归档 §2.1/2.2 底稿实现（RSA 公钥 PKCS1v15 加密 temp_key、AES-128-CBC info、五段 md5 签名 `payload\nkey\ndate\nbody\npath`、cosy-clientip 硬编码），全部参数以 R-G3 现版抓包复核为准（客户端版本演进可能已改 cosyVersion/公钥）。
- **护栏全量继承**：请求 jitter、失败退避、`sent_any` 空完成收尾、首字超时故障转移等 qoder 池既有护栏在 Global 池一律继承（同 Buddy 方案 §4.2 原则）。

### 4.3 签到 / 积分（每日领取 100 Credits 自动化）

- **活动认知**：Intl 单活动「每日领取 100 通用 Credits」（官方每日活动，2026-09-18 起，结束另行公告）；**无 CN 的 0 点签到**；领取渠道官方口径「仅限 Qoder 桌面端」，接口层为 sash campaigns 体系（归档 §3.2：Intl 自 v0.8.18 统一 campaigns，旧 daily-check-in 端点已全球禁用）。
- **实现口径**：完全复用 `qoder_checkin.rs` 骨架——GET campaigns（带 `Cosy-ClientType`，缺头静默空列表的坑 Intl 同样适用，R-G4 确认取值）→ 过滤 `claimStatus=="CLAIMABLE"` → 逐个 POST claim（幂等，`replayed==true` 视为 already）→ **claim 失败复查恢复**（cn 归档 §3.2 方案，CN 池已落地，直接继承）→ 结果写 `qoder_global_checkin_results`（90 天滚动）→ NDJSON 进度流。
- **计入科目**：领取后进 **Add-on Credits**（官方文档明示），与购买资源包同科目——积分引擎 `packages[].source` 枚举 Intl 侧为 `plan | addon_daily`（映射现有 addon_checkin 语义，字段名落码时对齐）。
- **调度**：窗口每日 10:00 开（UTC+8，新加坡时间）→ **10:15 单次调度**即可覆盖（与 CN 双活动同结论）；错过不补领 → 自动化直接提高领取率，这是本项核心用户价值；间隔键 `qoder_global_checkin_hhmm`，启动补签镜像。
- **积分引擎**：`qoder_credits.rs` 复用（三通道、600s 缓存 + stale-on-error、快照 365 天）；Intl 无 CLI `/usage` 解析兜底通道（Intl CLI 有独立凭证但无解析需求，R-G5 若 quota 接口可用即双通道足够）；FEFO / 同到期先 Plan 后 Add-on / 失败不扣费——官方规则与现有实现同构，解析字段以 R-G5 实测响应为准。
- **不做**：14 天 Pro 试用 300 Credits 的自动化（一次性、新用户首登触发、多建冻结——触碰红线，明确不做）；「每日领取」若上游对非桌面端渠道风控拦截（R-G4 失败），降级方案 = CDP/UI 自动化评估（低优先，参照 CN 方案 M4 CDP 兜底先例，先评估后立项）。

### 4.4 多账号并发与设备指纹（区域分派）

- **每账号稳定绑定原则不变**（CN §5.10 模型）：账号导入时生成一次、之后恒定复用；`machine_token`/`machine_type` 可现场随机（QoderGateway 实证服务端无强绑定，R-G9 现版复核）。
- **格式按区分派**：CN machine_id = 32 位小写 hex；**Intl machine_id = uuid4 标准 36 字符**（带连字符，归档 §2.3/§2.4 已验证写法）、machine_token = base64url 68 字符、machine_type = 18 位 hex。指纹生成器抽 `QoderDeviceProfile` 区域变体，`data_io` 导入红线沿用：**device_profile 仅本地为空才补入，绝不覆盖**。
- **本地覆写目标（Intl）**：桌面端 `com.qoder.app.<channel>` 数据目录指纹文件（machineid / state.vscdb storage 键，具体清单 R-G9 实测）；CLI 侧 `~/.qoder/.auth/id` 可直写（`user` 文件解密 key=machine_id[:16] 必须与 id 一致）。

### 4.5 模型目录与倍率

- 目录：`qoder_catalog.rs` 拉取区域参数化，Global 目录独立缓存；Intl 模型与 CN 完全不同源（国际模型池），同名模型跨区**不做混合轮询**（对齐 buddy-ai 同名模型跨区不混轮决策）。
- 倍率：首版静态配置（官网实际值人工维护）；**Qwen3.8-Flash 标注 0 系数免费**（2026-10-01 起继续免费，官方活动页为准）——0 成本高频低价路由是 Global 池网关侧的核心卖点。
- 「API 使用帮助取最小倍率」口径扩展到 `qoder-global` 档。

### 4.6 前端

| 页面 | 改动 |
|---|---|
| QoderAccounts / Overview / Checkin / Credits / Settings | 顶部区域 Tab（国内 / 国际）分区；账号卡加区域徽标；Intl 登录按钮状态随 R-G2；Checkin 页 Intl 区展示单活动说明 |
| QoderApiService | `qoder-global` 档位（默认关）；模型目录 Intl 化 + 0 系数标注；资源调度页地区说明卡更新（「Global 区不可路由」旧文案 → Global 池可路由说明） |
| PoolHealthBadges / 池健康 | 扩为含 `qoder-global` |
| 帮助页（倍率） | 加 `qoder-global` 档倍率列 |

### 4.7 存量与兼容

- 现网 `qoder` 池**无 Global 账号**（CN-only 决策自始未混入）→ **无存量迁移负担**（优于 buddy-ai，后者需迁移混居账号）；仅需导入侧双保险：区域必选参数 + 凭证域特征校验，防 Intl 账号误入 CN 池。
- 回滚设计：`qoder-global` 档默认关，dispatch 不启用即零影响；schema v3→v4 迁移带版本号置位 + 备份，回滚 = 还原备份 + 版本号回退；CN 侧唯一改动是端点常量结构体化（行为逐字不变的等价重构），独立 commit 便于单独 revert。

---

## 🧪 5. Gate 探测清单（先侦察后施工）

> 原则：所有 R-G 项未通过前，对应能力**只做骨架不做接线**。**阻塞层（R-G1~G5）用一次真实国际账号登录收口**（设备流登录 → 抓 campaigns → 抓 quota → 抓 chat MITM，同 Buddy 方案「一次登录收口」手法）；决策层（D-x）评审拍板；观察层随放量观察。产物落 `docs/completed/f80-qoder-global-recon/`（HAR + 截图 + 结论 md），回填 §3.3 端点矩阵。

| # | 探测项 | 手段与底稿 | 产出物 → 影响的设计决策 |
|---|---|---|---|
| R-G1 | **账号-区域关系**（未决项①）：同一邮箱可否同时存在 CN 与 Intl 账号；Intl 账号登录 CN 客户端行为 | 真实账号双端实测 + 官方 FAQ | 结论 → 导入校验规则 / UI 双区并存提示 / 是否需要「区域互斥」告警 |
| R-G2 | **设备流全链路**：client_id `e883ade2-...` 现版有效性、授权页参数、poll 时序、token 响应字段（token / refresh_token / user_id / expires_at / refresh_token_expires_at） | 归档 §2.8 底稿 + 真实登录一次 | 端点常量定稿 → §4.1 登录实现 |
| R-G3 | **chat 网关请求形态**（未决项②落地验证）：`api3.qoder.sh` 端点路径/方法/请求体/流式帧/Encode 位；COSY 头家族现版取值（cosyVersion / clienttype / clientip / RSA 公钥 / UA） | MITM SOP（复用 device_proxy）：`proxy_start` → Intl 客户端真实对话（含流式）→ 落盘提取（token 脱敏）；底稿 = 归档 §2.1/2.2 | §4.2 签名与上游实现定稿；**未闭合不写上游转发层** |
| R-G4 | **sash campaigns Intl**：base 域（openapi.qoder.sh?）、Cosy-ClientType 取值、CLAIMABLE 过滤、claim 幂等 replayed、benefit.amount | 归档 §3.1/3.2 底稿 + campaigns 抓包 | §4.3 签到实现定稿 |
| R-G5 | **quota/usage Intl 响应结构**：packages 明细（plan/addon 源、expire_at、FEFO 字段链） | Bearer 直调（幂等安全）+ 归档 §2.5 底稿 | credits 解析器字段对齐 |
| R-G6 | **PAT Intl 通道**：PAT 创建入口（qoder.com 路径）、前缀、center.qoder.sh jobToken 交换 + appcode/signature + `?Encode=1` 现版有效性 | 归档 §2.7 底稿 + 实测 | §4.1 PAT 通道实现 |
| R-G7 | **token 生命周期**：jrt-/其余前缀分派、token_key 字段名、6h 刷新间隔、refresh_token_expires_at | 归档 §2.5 底稿 + 轮询观察 | ensure_fresh 分支实现 |
| R-G8 | **模型目录与倍率**：Intl model/list 端点与响应、倍率表、Qwen3.8-Flash 0 系数在目录中的表达 | MITM 复用 | catalog 区域化 + 帮助页倍率列 |
| R-G9 | **风控与指纹**：设备指纹校验强度现版复核（machinetoken 随机可过?）、本地指纹覆写文件清单、sash 对非桌面渠道 claim 的风控表现 | 归档 §2.3/§6.2 底稿 + 观察 | §4.4 指纹区域实现 + 风险对策更新 |

> **分层**：R-G2~G5 为**阻塞层**（池骨架与运营面动工前置）；R-G1/G6~G9 可随对应阶段顺延；R-G3 是网关转发阶段硬前置（沿 R-13「缺口未闭合不写上游转发层」红线）。

---

## 🚀 6. 分阶段实施计划

| 阶段 | 内容 | 前置 | 验收标准 |
|---|---|---|---|
| **0 侦察** | Gate 阻塞层（R-G2~G5）一次真实国际账号登录收口；R-G1 结论；端点矩阵回填；`QoderRegionEndpoints` 结构体落地（仅常量不接线） | — | 阻塞层全部有结论；探测零脏数据入生产 KV（凭证在 Temp、已清理落盘） |
| **1 池骨架** | `qoder-global` 池注册（四表 schema v4 + token store 命名空间 + 池锁）、Intl 导入通道（PAT / 设备流 / CLI 解密导入，探测未全过的置灰）、账号 id `qdg-` 前缀、健康徽标扩展、healthz 纳入 selectable | 阶段 0（R-G2） | `cargo test` 全绿（含 schema v3→v4 迁移用例）；Intl 导入幂等入池；CN 池回归零变化 |
| **2 网关转发** | `QoderRegionEndpoints` 全量接线（common/checkin/credits/oauth 域切换）、`qoder_sign` Global 分支、`qoder_upstream` Global 分流、`qoder_route` 按池路由（守卫按池放行）、dispatch `qoder-global` 档、`UsageBucket::QoderGlobal`、模型目录 Intl 化 + 倍率静态配置 | 阶段 0（R-G3/R-G8） | Global 池流式对话连通 `api3.qoder.sh`；CN 池行为逐字不变（对比迁移前后 app_log 关键行）；`record_usage` 记账落 `qoder-global` bucket；`tsc` 无错误 |
| **3 运营面** | `qoder-global-checkin` 每日领取自动化（10:15 调度 + 启动补签 + 6h refresh 兜底）、积分同步 Intl 化 + 快照、前端五页区域分区收尾、HelpModal 帮助内容 | 阶段 2（R-G4/R-G5） | 每日领取全链路自动到账（幂等重跑无副作用、错过窗口显式提示）；积分余额/到期与官网 Settings > Usage 一致；国内侧回归：CN 签到/积分/对话全链路行为不变 |

**回滚设计**：池骨架 schema 版本号置位 + 备份；dispatch `qoder-global` 档默认关；CN 侧唯一改动（端点结构体化等价重构）独立 commit 可单独 revert。

---

## ⚠️ 7. 风险与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | **情报时效**：调研归档为 2026-09-27 取证，客户端版本演进可能已改 COSY 参数/端点/公钥 | 高 | Gate 现版复核为硬前置；所有版本敏感参数（UA、cosyVersion、client_id）进 `QoderRegionEndpoints` 单点，更新仅改常量 |
| 2 | **试用冻结风控**：官方明文多建试用账户直接冻结（虚拟机不支持） | 高 | **红线**：不做注册/试用类能力，仅面向存量个人账号；UI 固定风险提示；每账号稳定指纹（非随机轮换） |
| 3 | **领取渠道仅桌面端**：官方口径 claim 入口在桌面端，纯 HTTP claim 可能被渠道风控拦截 | 中 | R-G4 实测；失败降级 = CDP/UI 自动化评估（低优先、先评估后立项）；empty_campaigns 显式区分不静默 |
| 4 | **CN 停运（2027-09-05）与投入平衡** | 中 | 战略对冲定位：Intl 接入即 Qoder 生态长期存续路径；CN 池维持维护期不再扩功能 |
| 5 | **免费收益低于 CN**（3,000 vs 6,000 Credits/月/账号） | 低 | 价值定位 = 模型多样性（国际模型池 + 0 系数 Flash）+ 停运对冲，非纯额度替代；经济账见附录 A |
| 6 | **双池调度复杂度** | 中 | 严格按 §3.4 隔离清单执行；`qoder-global` 档默认关；同名模型跨区不混轮 |
| 7 | **国内侧回归** | 低 | CN 唯一改动为等价重构（端点结构体化），独立 commit + 回归用例；其余全部「新增而非修改」 |

---

## 📎 8. 遗留决策点（评审时定）

1. **池 id 命名**：§3.4 推荐 `qoder-global`（对齐 buddy-ai 命名法）；备选 `qoder-intl`。
2. **前端分区形态**：五页顶部区域 Tab（Buddy 同款）vs 独立 Tab（`QoderGlobal` 与 qoder 平级）——推荐前者（账号/签到/积分九成组件可共用，改动面最小）。
3. **存储方案**：`qoder_global_*` 四独立表（schema v3→v4，对齐 CN 四表先例）vs 现表加 pool 维度列——推荐前者（与 buddy-ai 独立存储取向一致、迁移回滚干净），若 store 现状更宜分库则从其约定。
4. **R-G4 若纯 HTTP claim 被渠道风控拦截**：CDP/UI 自动化兜底是否立项（建议：先评估成本再定，不阻塞阶段 1/2）。
5. **是否同步立项 F-71（Trae SG）**：`QoderRegionEndpoints` + 独立池骨架可被 F-71 复用，若同期立项可共享阶段 0 方法论。

---

## 📚 9. 附录

### 🅰️ 附录 A：免费额度与积分机制（官方文档核实，2026-10-18）

**套餐体系**（docs.qoder.com/account/pricing）：

| Plan | 价格 | 高级模型额度 | 说明 |
|---|---|---|---|
| Free（体验版） | 免费 | 基础模型，消息条数受限 | 支持 BYOK；Credits 用尽自动降级基础模型 |
| Pro | $20/月 | 2,000 Credits/月 | 周期结束归零 |
| Pro+ | $60/月 | 6,000 Credits/月 | |
| Ultra | $200/月 | 20,000 Credits/月 | |
| 资源包 | $20 / 1,500 Credits | 1 个月有效 | 不可退款，可叠加 |

**免费可得额度**：

| 来源 | 额度 | 条件 |
|---|---|---|
| 每日领取 100 Credits（2026-09-18 起，结束另行公告） | **100/天 ≈ 3,000/月** | 桌面端用量面板 → 礼物图标**主动领取**；免费/试用/Pro/Pro+/Ultra 个人用户均可；Teams/企业版不适用；窗口每日 10:00→次日 10:00（UTC+8），**错过不补、不累计**；计入 **Add-on Credits**，每笔 **30 天有效**、跨天保留、逐笔分别到期 |
| 14 天 Pro 试用 | 一次性 300 Credits + Pro 全功能 | 仅新用户首登；**限一账号，多建试用账户直接冻结**（虚拟机不支持） |
| Qwen3.8-Flash 限时免费 | **0× 计费系数** | 2026-10-01 起继续免费，余额为 0 也能用，不扣任何 Credits |

**扣减规则**（官方 Credits 文档，与本项目 CN 实现同构）：FEFO 最先到期优先；同到期先 Plan 后 Add-on；失败请求不扣费；Credits 全端共享（Qoder / IDE / JetBrains / CLI / QoderWake / Cloud Agents / 移动端 / 网页版）；CN 与国际**不互通、定价不等价**。

**消耗参考**：Agent 模式 ≈50 Credits/请求、Editor Ask ≈3-4、Editor Agent ≈7-12（200K 上下文）→ 免费稳态 ≈60 次 Agent 请求/账号/月。

**余额查看**：qoder.com 右上角头像 → Settings > Usage（方案信息 + 分类余额 + 明细）。

### 🅱️ 附录 B：外部项目情报映射（→ `docs/completed/Qoder外部项目调研归档.md`）

| 归档章节 | 内容 | 本方案落点 |
|---|---|---|
| §2.1/2.2 | COSY 会话密钥协商（RSA 公钥 + temp_key）+ 请求签名（五段 md5）+ 请求头全家族 | **未决项②底稿**：`qoder_sign` Global 分支（R-G3 复核） |
| §2.3 | 设备身份三字段生成（machine_id uuid4 / machine_token 68ch / machine_type 18hex）+ 无强绑定实证 | §4.4 指纹 Intl 格式（R-G9 复核） |
| §2.4 | `~/.qoder/.auth/` 本地凭据解密（AES-128-CBC key=IV=machine_id[:16]） | §4.1 CLI 登录态导入通道（Intl 特有） |
| §2.5 | token 生命周期（jrt- 分派、6h 刷新、quota 端点） | §4.1 ensure_fresh Intl 分支（R-G7） |
| §2.7 | jobToken 交换（center.qoder.sh、appcode/signature、`?Encode=1` 自定义 base64） | §4.1 PAT 通道（R-G6）；§6.1 移植要点为 Rust 翻译对照表 |
| §2.8 | Device Flow 注册机（client_id、授权页、poll 时序、token 响应字段） | §4.1 设备流登录（R-G2 复核） |
| §3.1/3.2 | CN 签到直连互证 + campaigns 契约（Intl v0.8.18 统一、CLAIMABLE 唯一权威、claim 失败复查恢复） | §4.3 签到实现（R-G4）；复查恢复逻辑已在 CN 池落地直接继承 |
| §6.1/6.2 | Rust 移植要点表 + 需实测验证点清单 | 阶段 0/2 实现对照表；§6.2 五点并入 Gate 清单 |
| §7/§8 | 风险清单（条款灰色/旧端点陷阱/域差） | §7 风险对策来源 |

### 🅲 附录 C：参考来源

**官方**：docs.qoder.com（pricing / Credits / events/100credits / events/flashoffer / FAQ）；qoder.com 门户。

**内部**：`docs/completed/Qoder平台支持设计方案.md`（CN 全量底稿 + §5.10 指纹 + §5.11 网关池方案）；`docs/completed/Qoder外部项目调研归档.md`；`docs/pending/Buddy国际版支持落地方案.md`（独立池范式与 Gate 方法论）；`docs/backlog.md` F-80-余（Global 区决策留档）。

**代码锚点**：`tasks/qoder_{common,checkin,credits,sign,upstream,catalog,refresh}.rs`；`api_server/qoder_route.rs`；`commands/qoder/{oauth,accounts,credits,checkin,ide_store,data_io,env_reset,cli_status}.rs`；`src/pages/qoder/*.tsx`。
