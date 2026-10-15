# BuddyAI 六页对齐国内 Buddy 开发计划

> 依据：2026-10-15 国内 Buddy 六页实截图逐页核对；国际版（buddy-ai 独立池）上游能力边界实测（§4.4/§4.5）。
> 原则：结构/交互一比一对齐国内；数据源与上游能力差异项明确标注「等效实现」或「国际上游不适用」，不做假数据。

## 能力边界总表（国内功能 → 国际版处置）

| 国内功能 | 国际版处置 | 依据 |
|---|---|---|
| 打开 WorkBuddy / CodeBuddy 客户端 | **等效实现**：国际客户端 WorkBuddyAI @ `%LOCALAPPDATA%\Programs\WorkBuddyAI`、CodeBuddy @ `%LOCALAPPDATA%\Programs\CodeBuddy`（与国内不同 exe，需独立档案） | 用户实测路径 |
| 近 30 天签到结果图 / 活动签到日历 | **等效实现**：buddy-ai 打卡结果按日落库（新表）+ 查询命令 | 国内 wb_checkin_results 同构 |
| 积分榜 Top / 余额统计 | **直接可做**：buddy-ai 池快照 credits_balance 已有 | buddy_ai_accounts_list |
| 积分趋势曲线（快照时序） | **等效实现**：每日定时积分快照落库（新调度任务） | 国内 creditsHistory 同构 |
| 模型消耗排行 | **直接可做**：网关用量记账 UsageBucket::BuddyAi（buddy_ai_days）按模型聚合 | 已有记账 |
| Token 统计 / 会话明细 | **后续项**：网关请求级流水按 buddy-ai 桶切面（P8 可选） | 国内为官网/流水数据源 |
| 成长中心（Buddy 银行 / 邀金翻倍 / 行米总额） | **国际上游不适用**（官网无对应入口），以打卡积分统计卡替代 | §4.5 无 claim 端点 |
| 每日目标 / 签到点 / 签到策略 / UI 模拟点击 | **国际上游不适用**（intl 打卡为 ACP 六步链，无 UI 签到通道） | §4.5 |
| JWT 定时预刷 / 每日自动续证 | **等效实现**：intl 凭证 expires_at_ms 定时续期（refresh_lock 互斥已具备） | M2 修复后机制齐 |
| 分组 / 标签 | **直接可做**：全局分组/标签体系共享，buddy-ai 池行已带 group_id | WorkBuddyAccount 同构 |
| 账号启停 / 备注编辑 / 批量操作 | **需新增后端**：buddy_ai_account_save / account_toggle（池行读改写持锁） | P3 |
| 导出账号 | **降级等效**：导出账号清单（不含凭证明文，vault 红线） | 安全红线 |
| CLI 桥接 / 切号轮换 | **国际上游不适用**（intl 无 CLI 桥接通道） | — |
| 同步官网模型目录 / 定时同步 | **等效已交付**：Intl 静态目录 17 模型（§4.4），官网目录抓取待上游公开接口 | 静态配置原则 |

## 阶段划分（逐步开发，每阶段独立可验收）

### P1 顶栏/环境配置：国际客户端打开修复（本轮）🐛
- env.rs 新增 `workbuddy_ai` / `codebuddy_ai` 客户端档案（exe 候选含 `Programs\WorkBuddyAI\{WorkBuddyAI,WorkBuddy AI,WorkBuddy}.exe`、`Programs\CodeBuddy\CodeBuddy.exe`）
- 新命令 `open_workbuddy_ai_app` / `open_codebuddy_ai_app`（复用 open_buddy_app 分离启动）
- 前端：BuddyAI 顶栏与「环境配置」页改用新命令；徽标探测 `api.env.locate('workbuddy_ai' / 'codebuddy_ai')`

### P2 打卡记录落盘 + 概述页对齐
- 新表 `buddy_ai_checkin_results`（date/time/user_id/name/status/message/reward；90 天裁剪；镜像 wb_checkin_results）
- `run_checkin_round` 逐账号结果落库（幂等：同 uid 同日最终态覆盖）
- 新命令 `buddy_ai_checkin_results(days)`；前端类型 + tauri.ts
- 概述页：补「近 30 天打卡结果」堆叠图 + 「积分榜 Top」图（recharts，对齐国内 Buddy 概述）

### P3 账号管理对齐
- 后端：`buddy_ai_account_save`（备注/分组）、`buddy_ai_account_toggle`（启停，池行 disabled 字段 + selectable 判定）、`buddy_ai_accounts_export`（清单导出，不含凭证）
- 前端：列对齐国内（分组下拉 / +标签 / 使用积分（buddy_ai_days 聚合）/ TOKEN 到期 / 凭证状态 / 启停徽章）+ 批量删除 / 导出 / 分组管理入口
- 「每日目标 / 休假锁单」标注国际不适用

### P4 签到页对齐（签到与成长）
- 一键签到账号状态表（账号 / 状态 / 打卡结果 / 获取积分 / 可用积分，数据源 P2 记录 + 池快照）
- 活动打卡日历（月历热图，镜像国内「活动签到日历」交互，按月翻页）
- 成长中心位以「打卡积分统计」（累计获得 / 今日获得）等效替代；保留定时配置卡

### P5 积分看板对齐
- 统计卡口径对齐国内 7 卡（账号数 / 可用总额 / 平均 / 打卡获得累计 / 今日获得 / 今日消耗 / 7 日内到期按积分包等效为账号到期）
- 新调度任务「buddy-ai 积分定时快照」（每日 HH:MM，落 buddy_ai_credits_history）→ 积分趋势曲线
- 模型消耗排行（buddy_ai_days 按模型 tokens/积分聚合，近 30 天）
- Token 统计 / 会话明细 → P8 可选

### P6 资源调度对齐
- 调度状态横幅（未启用国际档时提示 + 一键开启）
- 统计卡（调度账号 / 今日启用 / 池内账号）
- 账号调度池复选启停（依赖 P3 toggle）
- 国际档参数区（开关 / 会话粘性 / 池粘性 TTL——TTL 需后端 pool_set 扩参，随本阶段补）
- 模型目录表（静态 17 模型：ID / 展示名 / 厂商 / 倍率占位 / 上下文），标注「静态配置」

### P7 环境配置对齐
- 应用环境卡：国际客户端双路径 + 自动检测 + 打开（P1 命令复用）+ 打开数据目录
- 任务配置卡：每日自动打卡（镜像签到页配置）+ 每日积分快照（P5 任务）+ JWT 定时续期（等效任务）
- CLI 轮换 / 切换迁移 / UI 模拟：标注国际不适用

### P8（可选后续）
- Token 统计 / 会话明细（网关请求流水 buddy-ai 切面）
- Intl 官网模型目录动态抓取（替换静态表倍率占位）

## 验收口径
- 每阶段：`cargo test` 全绿 + `tsc --noEmit` 零错误 + 逐页与国内截图对照走查
- 安全红线：凭证不明文出后端（导出清单脱敏）、删除类操作二次确认、写操作有 toast 反馈
