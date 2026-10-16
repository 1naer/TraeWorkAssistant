//! Buddy 国际版（buddy-ai）独立池（《Buddy国际版支持落地方案.md》阶段 1 池骨架）。
//!
//! §3.1 不交织六条硬约束的落点：
//! - 账号分池：`buddy_ai_accounts` 表独立于 `wb_accounts`，禁止混居；
//! - 配置分键：`buddy_ai_*` 系列（token store 表 / vault ns / 池锁均独立）；
//! - 失败域隔离：独立 `buddy_ai_pool_lock`，换号/冷却在池边界内闭环；
//! - UI 分区：账号列表命令独立（`buddy_ai_*`），事件前缀 `buddy-ai-oauth-*`。
//!
//! 端点依据（Gate 阻塞层 2026-10-15 已实测收口）：
//! - R-1 OAuth 全链路：`www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy-ai`；
//! - R-2a refresh：`www.workbuddy.ai/v2/plugin/auth/token/refresh`（rt 每次轮换，回写为准）；
//! - R-9：workbuddy.ai ↔ codebuddy.ai 同一账号体系，单一鉴权门面即可。

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::fs_utils;
use crate::state::AppState;

use super::accounts::find_uid_or_id;
use super::common::{account_id_of, as_str, load_pool, save_pool, WorkBuddyAccount, WbPool};
use super::oauth::{oauth_login_async, PoolSink};

// ── 池 / token store 读写包装（buddy-ai 独立表）─────────────────────────────

pub(super) fn load_buddy_pool(state: &AppState) -> WbPool {
    let v = crate::store::docs::buddy_ai_pool_load(&crate::store::db(&state.data_dir));
    // BM-2 审查修复：逐行反序列化跳过坏行——整池 from_value 失败 → 空池 → 后续
    // save 整表替换会把全部账号清空（读失败被写放大为数据丢失）。坏行记日志留证
    match serde_json::from_value::<WbPool>(v.clone()) {
        Ok(p) => p,
        Err(_) => {
            let mut accounts = Vec::new();
            if let Some(arr) = v.get("accounts").and_then(Value::as_array) {
                for (i, row) in arr.iter().enumerate() {
                    match serde_json::from_value::<WorkBuddyAccount>(row.clone()) {
                        Ok(a) => accounts.push(a),
                        Err(e) => fs_utils::app_log(
                            &state.data_dir,
                            &format!("buddy-ai: 池行损坏已跳过（index {i}）: {e}"),
                        ),
                    }
                }
            }
            WbPool { accounts }
        }
    }
}

/// buddy-ai 池账号花名册（跨模块 tasks/buddy_ai_checkin 消费；WbPool 字段
/// pub(super) 不对 tasks 暴露，经此 helper 交出 (id, 展示名, uid) 三元组）
pub(crate) fn buddy_pool_roster(state: &AppState) -> Vec<(String, String, String)> {
    load_buddy_pool(state)
        .accounts
        .iter()
        .filter(|a| !a.disabled) // P3 启停：停用账号不参与打卡花名册
        .map(|a| (a.id.clone(), if a.nickname.is_empty() { a.id.clone() } else { a.nickname.clone() }, a.uid.clone()))
        .collect()
}

/// buddy-ai 池单账号积分快照回写（持 buddy_ai_pool_lock 短临界区；三键口径
/// 对齐 write_back_pool_balances：balance / fetched_at / 最早未来到期）
pub(crate) fn buddy_pool_write_credits(
    state: &AppState,
    acct_id: &str,
    balance: f64,
    expire_secs: Option<i64>,
    packages: Option<Value>,
) -> Result<(), String> {
    let _guard = state.buddy_ai_pool_lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut pool = load_buddy_pool(state);
    let Some(a) = pool.accounts.iter_mut().find(|a| a.id == acct_id) else {
        return Ok(()); // 账号已移除（打卡期间竞态）：静默丢弃
    };
    a.credits_balance = Some(balance);
    a.credits_fetched_at = Some(chrono::Utc::now().to_rfc3339());
    if expire_secs.is_some() {
        a.credits_expire_at = expire_secs; // 秒级时间戳（WorkBuddyAccount 口径）
    }
    if packages.is_some() {
        a.credits_packages = packages; // 分包明细（P9）
    }
    save_buddy_pool(state, &pool)?;
    // P8：打卡/取数回写后刷新当日积分快照（趋势曲线数据源；锁内调用不重复加锁）
    buddy_ai_credits_snapshot_save(state, &pool);
    Ok(())
}

pub(super) fn save_buddy_pool(state: &AppState, pool: &WbPool) -> Result<(), String> {
    let v = serde_json::to_value(pool).map_err(|e| format!("序列化失败: {e}"))?;
    crate::store::docs::buddy_ai_pool_save(&crate::store::db(&state.data_dir), &v)
}

/// P8：当日积分快照落库（同日覆盖 + 365 天裁剪；积分看板趋势曲线数据源）。
/// 不持锁——调用点均在 buddy_ai_pool_lock 临界区内（write_credits /
/// credits_fetch 回写段），池读为最新态；落库失败仅日志，不阻塞主流程。
/// 私有可见性：仅本文件两个回写点消费，避免 pub(crate) 暴露 pub(super) 的 WbPool
fn buddy_ai_credits_snapshot_save(state: &AppState, pool: &WbPool) {
    let db = crate::store::db(&state.data_dir);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let accounts: Vec<Value> = pool
        .accounts
        .iter()
        .map(|a| {
            json!({
                "id": a.id,
                "name": if a.nickname.is_empty() { a.id.clone() } else { a.nickname.clone() },
                "balance": a.credits_balance,
            })
        })
        .collect();
    let total: f64 = pool
        .accounts
        .iter()
        .filter(|a| !a.disabled) // BL-7：停用账号不计入趋势口径（与花名册/网关池一致）
        .filter_map(|a| a.credits_balance)
        .sum();
    let snap = json!({
        "date": today,
        "ts": chrono::Utc::now().timestamp(),
        "total_balance": total,
        "accounts": accounts,
        "earned": Value::Null,
    });
    if let Err(e) = crate::store::docs::buddy_ai_credits_history_upsert(&db, &snap) {
        fs_utils::app_log(&state.data_dir, &format!("buddy-ai: 积分快照落库失败: {e}"));
    }
    let _ = crate::store::docs::buddy_ai_credits_history_prune(&db);
}

/// token store 读取（vault 回填，仅内存不落明文）
fn load_buddy_tokens(state: &AppState) -> Value {
    crate::tasks::wb_common::buddy_ai_token_store_load(&state.data_dir)
}

// ── 国际版默认 domain（区域判定唯一真源仍是 token rec 的 domain 字段）───────

/// 国际账号 token rec 的 domain 缺省值：`www.workbuddy.ai`（含 `.workbuddy.ai` →
/// `is_global_region` 命中 Global，chat/billing/refresh 全链按区切换）
pub const INTL_DOMAIN: &str = "www.workbuddy.ai";

fn intl_domain_or(domain: Option<String>) -> String {
    match domain {
        Some(d) if d.contains(".workbuddy.ai") => d,
        // 缺省/非法一律回落官方域名（buddy-ai 池只收国际账号，不可能出现 CN 域）
        _ => INTL_DOMAIN.to_string(),
    }
}

// ── API 网关 buddy-ai 池取号（T2.1 同构，阶段 2 dispatch 接线）──────────────

/// 汇总 buddy-ai 上游账号：buddy_ai_accounts 池启用账号 + buddy-ai token store 凭证
/// → WbSyncAccount（global_region 恒 true——独立池内不存在 CN 账号）。
/// 与 wb_upstream_accounts 完全隔离：两池各自装配、互不读取对方表。
pub(crate) fn buddy_ai_upstream_accounts(state: &AppState) -> Vec<crate::api_server::pool::WbSyncAccount> {
    let pool = load_buddy_pool(state);
    let tokens = load_buddy_tokens(state)
        .get("tokens")
        .and_then(|t| t.as_object())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for a in &pool.accounts {
        if a.disabled {
            continue; // P3 启停：停用账号不入网关池（不参与取号/调度）
        }
        let rec = tokens.get(&a.id).cloned().unwrap_or_default();
        let token = as_str(fs_utils::dig(&rec, &["access_token"])).unwrap_or_default();
        if token.is_empty() {
            continue;
        }
        let domain = intl_domain_or(as_str(fs_utils::dig(&rec, &["domain"])));
        let eid = as_str(fs_utils::dig(&rec, &["enterprise_id", "enterpriseId"])).unwrap_or_default();
        out.push(crate::api_server::pool::WbSyncAccount {
            uid: a.id.clone(),
            name: if a.nickname.is_empty() { a.id.clone() } else { a.nickname.clone() },
            token,
            domain,
            enterprise_id: eid,
            global_region: true,
            credits: a.credits_balance,
            credits_expire_at: a.credits_expire_at,
            credits_fetched_at: a
                .credits_fetched_at
                .as_deref()
                .and_then(crate::fs_utils::parse_ts_loose),
            needs_relogin: a.needs_relogin,
            group_id: a.group_id.clone(),
        });
    }
    out
}

// ── OAuth 扫码登录（R-1 全链路实测通过，§8-4 并入阶段 1）────────────────────

/// buddy-ai OAuth 扫码登录：`www.workbuddy.ai` + `platform=workbuddy-ai` 全链路，
/// 入池落 buddy-ai 独立池；事件 `buddy-ai-oauth-progress` / `buddy-ai-oauth-done`。
#[tauri::command(async)]
pub fn buddy_ai_oauth_login(app: tauri::AppHandle) -> Result<(), String> {
    oauth_login_async(app, &crate::tasks::wb_common::REGION_GLOBAL, PoolSink::BuddyAi)
}

// ── 手工导入凭证（区域必选校验，§4.1）──────────────────────────────────────

/// 手工导入国际账号凭证：access_token 必填，refresh_token 可选（无则不可自动续期）。
/// 区域校验（双重保险之一）：domain 显式传入时必须含 `.workbuddy.ai`，否则拒绝——
/// buddy-ai 池不接受任何国内形态账号；缺省回落 `www.workbuddy.ai`。
#[tauri::command(async)]
pub fn buddy_ai_account_import_creds(
    state: State<'_, AppState>,
    name: Option<String>,
    access_token: String,
    refresh_token: Option<String>,
    domain: Option<String>,
) -> Result<Value, String> {
    let token = access_token.trim().to_string();
    if token.is_empty() {
        return Err("access_token 不能为空".into());
    }
    if let Some(d) = domain.as_deref() {
        if !d.trim().is_empty() && !d.contains(".workbuddy.ai") {
            return Err(format!(
                "区域校验失败：domain「{d}」非国际版（须含 .workbuddy.ai）；国内账号请走 Buddy 页导入"
            ));
        }
    }
    let domain = intl_domain_or(domain);
    let id = account_id_of(&token);
    let uid = super::oauth::jwt_claims(&token)
        .and_then(|c| c.get("sub").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();
    let exp_s = super::oauth::jwt_claims(&token)
        .and_then(|c| c.get("exp").and_then(|v| v.as_i64()));
    let nickname = name.unwrap_or_default();
    let now_s = chrono::Utc::now().timestamp();

    // 读-改-写互斥（buddy-ai 独立锁）；token upsert 留在锁外缩短临界区
    let target_id = {
        let _guard = state.buddy_ai_pool_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut pool = load_buddy_pool(&state);
        let target_id = if let Some(a) = find_uid_or_id(&mut pool, &uid, &id) {
            if !uid.is_empty() {
                a.uid = uid.clone();
            }
            if !nickname.is_empty() {
                a.nickname = nickname.clone();
            }
            a.access_token_expires_at = exp_s;
            a.auth_saved_at = Some(now_s);
            a.needs_relogin = false;
            a.relogin_reason.clear();
            a.id.clone()
        } else {
            pool.accounts.push(WorkBuddyAccount {
                id: id.clone(),
                uid: uid.clone(),
                nickname: nickname.clone(),
                access_token_expires_at: exp_s,
                auth_saved_at: Some(now_s),
                ..Default::default()
            });
            id.clone()
        };
        save_buddy_pool(&state, &pool)?;
        target_id
    };
    // BL-2 审查修复：同 id 重导合并式写回——upsert 是整行 REPLACE，从零构造会：
    // ① rt 缺省时 DB 占位置空但 vault 旧 rt 仍在（secure 回填复活，与「无则不可
    // 续期」语义矛盾）；② 抹掉 last_daily_chat/uid（当日打卡被重跑）。改为在旧
    // rec 上合并：新值优先、缺省回落旧值、幂等戳恒保留
    let existing = crate::tasks::wb_common::buddy_ai_token_store_load(&state.data_dir)
        .get("tokens")
        .and_then(|t| t.get(&target_id))
        .cloned()
        .unwrap_or_default();
    let new_rt = refresh_token.as_deref().filter(|t| !t.trim().is_empty());
    let old_rt = existing.get("refresh_token").and_then(Value::as_str);
    let mut creds = json!({
        "access_token": token,
        "refresh_token": new_rt.map(Value::from).unwrap_or_else(|| json!(old_rt.unwrap_or(""))),
        "expires_at_ms": exp_s.map(|s| s * 1000),
        "domain": domain,
    });
    if let Some(obj) = creds.as_object_mut() {
        // uid：导入提供优先，否则回落旧值
        obj.insert(
            "uid".into(),
            json!(if uid.is_empty() {
                existing.get("uid").and_then(Value::as_str).unwrap_or("")
            } else {
                uid.as_str()
            }),
        );
        if let Some(ldc) = existing.get("last_daily_chat") {
            obj.insert("last_daily_chat".into(), ldc.clone());
        }
    }
    crate::tasks::wb_common::buddy_ai_token_store_upsert(&state.data_dir, &target_id, &creds)?;
    fs_utils::app_log(&state.data_dir, &format!("buddy-ai: 手工导入国际账号 {target_id}"));
    Ok(json!({ "id": target_id, "domain": domain }))
}

// ── 账号列表 / 移除 / 凭证续期（阶段 1 最小集）──────────────────────────────

/// buddy-ai 账号列表（脱敏：不回传凭证，仅回传凭证存在性）
#[tauri::command(async)]
pub fn buddy_ai_accounts_list(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let pool = load_buddy_pool(&state);
    let tokens = load_buddy_tokens(&state)
        .get("tokens")
        .and_then(|t| t.as_object())
        .cloned()
        .unwrap_or_default();
    // 切换/保存登录态上下文（对齐国内 is_current_* / has_snapshot_* 口径）：
    // WB 当前 = 国际 auth 文件 uid；CB 当前 = CodeBuddy live storage.json genie.uid；
    // 快照槽存在性 = 主槽或 .bak 回退槽
    let ai_auth_uid = crate::switcher::authfile::auth_file_uid(
        &crate::switcher::authfile::wb_ai_auth_file(),
    );
    // CB 当前 = 国际版客户端 live uid（%APPDATA%\CodeBuddy；2026-10-16 修复：
    // 原误读国内 CodeBuddy CN 的 roaming，徽标/切换目标全部错端）
    let cb_live_uid = super::accounts::codebuddy_ai_live_uid();
    let profiles_wb_ai = state.data_dir.join("data").join("profiles_workbuddy_ai");
    let profiles_cb = state.data_dir.join("data").join("profiles_codebuddy_ai");
    let slot_exists = |dir: &std::path::Path, id: &str| {
        dir.join(id).exists() || dir.join(format!("{id}.bak")).exists()
    };
    Ok(pool
        .accounts
        .iter()
        .map(|a| {
            let rec = tokens.get(&a.id);
            json!({
                "id": a.id,
                "uid": a.uid,
                "nickname": a.nickname,
                "note": a.note,
                "group_id": a.group_id,
                "access_token_expires_at": a.access_token_expires_at,
                "refresh_token_expires_at": a.refresh_token_expires_at,
                "auth_saved_at": a.auth_saved_at,
                "needs_relogin": a.needs_relogin,
                "relogin_reason": a.relogin_reason,
                "disabled": a.disabled,
                "credits_packages": a.credits_packages,
                "credits_balance": a.credits_balance,
                "credits_expire_at": a.credits_expire_at,
                "credits_fetched_at": a.credits_fetched_at,
                "has_credential": rec.map(|r| {
                    as_str(fs_utils::dig(r, &["access_token"]))
                        .map(|t| !t.is_empty())
                        .unwrap_or(false)
                }).unwrap_or(false),
                "domain": rec.and_then(|r| as_str(fs_utils::dig(r, &["domain"]))).unwrap_or_else(|| INTL_DOMAIN.into()),
                "is_current_workbuddy": ai_auth_uid.as_deref() == Some(a.uid.as_str()) && !a.uid.is_empty(),
                "is_current_codebuddy": cb_live_uid.as_deref() == Some(a.uid.as_str()) && !a.uid.is_empty(),
                "has_snapshot_workbuddy": slot_exists(&profiles_wb_ai, &a.id),
                "has_snapshot_codebuddy": slot_exists(&profiles_cb, &a.id),
            })
        })
        .collect())
}

/// buddy-ai 池 uid 反查账号 id（switch.rs 切换/保存守卫用；与国内
/// pool_account_id_by_uid 同型，数据源 buddy_ai_accounts 独立池）
pub(crate) fn buddy_ai_pool_account_id_by_uid(state: &AppState, uid: &str) -> Option<String> {
    let uid = uid.trim();
    if uid.is_empty() {
        return None;
    }
    load_buddy_pool(state)
        .accounts
        .into_iter()
        .find(|a| a.uid == uid)
        .map(|a| a.id)
}

/// 移除 buddy-ai 账号（池条目 + token store 行 + buddy-ai vault 条目三清）
#[tauri::command(async)]
pub fn buddy_ai_account_remove(state: State<'_, AppState>, user_id: String) -> Result<(), String> {
    if user_id.is_empty() || user_id.len() > 64 {
        return Err(format!("非法账号标识: {user_id}"));
    }
    let _guard = state.buddy_ai_pool_lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut pool = load_buddy_pool(&state);
    let before = pool.accounts.len();
    pool.accounts.retain(|a| a.id != user_id);
    if pool.accounts.len() == before {
        return Err(format!("账号不在 buddy-ai 池中: {user_id}"));
    }
    save_buddy_pool(&state, &pool)?;
    crate::store::docs::token_store_remove(
        &crate::store::db(&state.data_dir),
        crate::tasks::wb_common::BUDDY_AI_TOKEN_TABLE,
        &user_id,
    )?;
    crate::vault::ns_remove(&state.data_dir, crate::tasks::wb_common::BUDDY_AI_VAULT_NS, &user_id);
    crate::tasks::wb_common::refresh_lock_remove(&user_id);
    fs_utils::app_log(&state.data_dir, &format!("buddy-ai: 移除账号 {user_id}"));
    Ok(())
}

/// buddy-ai 凭证续期（R-2a 实测端点；refreshToken 每次轮换，回写为准）。
/// 失败不标记 needs_relogin（§4.1：Intl 刷新失败按暂态处理，避免误杀真实有效凭证）。
#[tauri::command(async)]
pub fn buddy_ai_refresh_token(state: State<'_, AppState>, user_id: String) -> Result<String, String> {
    buddy_ai_refresh_impl(&state, &user_id)
}

/// 续期实现（命令与调度器兜底续期任务共用；锁序/合并写回口径与原命令一致）
pub(crate) fn buddy_ai_refresh_impl(state: &AppState, user_id: &str) -> Result<String, String> {
    let acct = {
        let pool = load_buddy_pool(state);
        pool.accounts
            .iter()
            .find(|a| a.id == user_id)
            .cloned()
            .ok_or_else(|| format!("账号不在 buddy-ai 池中: {user_id}"))?
    };
    // 审查修复（M2）：续期全程持每账号刷新锁 + 跨进程锁——rt 每次轮换，
    // 并发续期时后落库者会把先落库者的新 rt 覆盖为已被服务端作废的旧值（凭证永久失效）。
    // 与 wb 侧 refresh_access_token 锁序同构；与网关 401 国际档续期互斥共用同一把锁
    let refresh_lock = crate::tasks::wb_common::refresh_lock_for(&acct.id);
    let _refresh_guard = refresh_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(_cross) =
        crate::tasks::qoder_common::CrossProcLock::try_acquire_ns(&state.data_dir, "buddy-ai", &acct.id, 5000).0
    else {
        return Err("他方进程正在刷新该账号，稍后重试".into());
    };
    // 锁内读凭证（他人刚刷新落库的新值直接可见）
    let tokens = load_buddy_tokens(&state);
    let rec = tokens
        .get("tokens")
        .and_then(|t| t.get(&acct.id))
        .cloned()
        .unwrap_or_default();
    let refresh = as_str(fs_utils::dig(&rec, &["refresh_token"]))
        .filter(|t| !t.trim().is_empty())
        .ok_or("该账号无 refreshToken（不可刷新，需重新登录或重新导入凭证）")?;

    let ep = crate::tasks::wb_common::REGION_GLOBAL;
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(30))
        .build();
    // 红线：X-Refresh-Token 仅出现在 refresh 端点（wb_upstream 三铁律同源）
    let resp = agent
        .post(crate::tasks::wb_common::region_refresh_url(INTL_DOMAIN))
        .set("Authorization", "Bearer")
        .set("User-Agent", ep.ua)
        .set("X-Refresh-Token", &refresh)
        .set("X-Auth-Refresh-Source", "workbuddy")
        .set("Content-Type", "application/json")
        .send_string("{}");
    let body: Value = match resp {
        Ok(r) => r.into_json().unwrap_or_default(),
        Err(ureq::Error::Status(code, r)) => {
            let _ = r;
            // §4.1：Intl 刷新失败按暂态处理，不标记 needs_relogin，仅落日志留痕
            fs_utils::app_log(
                &state.data_dir,
                &format!("buddy-ai: 凭证续期失败（HTTP {code}）id={user_id}，按暂态处理不标记重登录"),
            );
            return Err(format!("刷新失败（HTTP {code}）：refresh token 可能已失效，需重新登录或重新导入"));
        }
        Err(e) => {
            fs_utils::app_log(
                &state.data_dir,
                &format!("buddy-ai: 凭证续期网络失败 id={user_id}（{e}），按暂态处理"),
            );
            return Err(format!("刷新请求失败: {e}"));
        }
    };
    let new_access = as_str(fs_utils::dig(&body, &["accessToken"])).ok_or("刷新响应中无 accessToken")?;
    let new_refresh = as_str(fs_utils::dig(&body, &["refreshToken"]));
    let expires_in: Option<i64> = fs_utils::dig(&body, &["expiresIn"]).and_then(|v| v.as_i64());
    let refresh_expires_in: Option<i64> =
        fs_utils::dig(&body, &["refreshExpiresIn"]).and_then(|v| v.as_i64());
    let now_ms = chrono::Utc::now().timestamp_millis();
    let exp_ms = expires_in.map(|s| now_ms + s * 1000);
    let rexp_ms = refresh_expires_in.map(|s| now_ms + s * 1000);

    // rt 轮换回写（R-2a：每次刷新轮换；响应缺失时保留旧值防丢）。
    // 审查修复（M1）：合并式写回（在旧 rec 上更新四键）——upsert 是整行 REPLACE，
    // 从零构造会抹掉打卡幂等戳 last_daily_chat 与 uid 兜底，刷新一次当日打卡即被重跑
    let mut merged = if rec.is_object() { rec.clone() } else { serde_json::json!({}) };
    if let Some(rm) = merged.as_object_mut() {
        rm.insert("access_token".into(), json!(new_access));
        rm.insert(
            "refresh_token".into(),
            json!(if new_refresh.as_deref().unwrap_or("").is_empty() {
                as_str(fs_utils::dig(&rec, &["refresh_token"])).unwrap_or_default()
            } else {
                new_refresh.clone().unwrap_or_default()
            }),
        );
        rm.insert("expires_at_ms".into(), json!(exp_ms));
        rm.insert("refresh_expires_at_ms".into(), json!(rexp_ms));
        rm.insert("domain".into(), json!(intl_domain_or(as_str(fs_utils::dig(&rec, &["domain"])))));
    }
    crate::tasks::wb_common::buddy_ai_token_store_upsert(&state.data_dir, &acct.id, &merged)?;
    // 短临界区回写池过期时间
    {
        let _guard = state.buddy_ai_pool_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut pool = load_buddy_pool(&state);
        if let Some(a) = pool.accounts.iter_mut().find(|a| a.id == acct.id) {
            a.access_token_expires_at = exp_ms.map(|m| m / 1000);
            a.refresh_token_expires_at = rexp_ms.map(|m| m / 1000);
            save_buddy_pool(&state, &pool)?;
        }
    }
    fs_utils::app_log(&state.data_dir, &format!("buddy-ai: 凭证续期成功 {user_id}"));
    Ok("凭证已续期".into())
}

// ── 定时任务（2026-10-16 六页对齐批 3）：凭证兜底续期 + 模型目录同步 ──────────

/// buddy-ai 凭证兜底续期任务（对齐国内 wb-renew lazy 口径）：仅刷新 AT 剩余 ≤48h
/// 的启用账号；全部失败返 Err 交调度器 30 分钟冷却重试，部分失败按暂态容忍
pub fn buddy_ai_renew_task(state: &AppState) -> Result<Value, String> {
    let pool = load_buddy_pool(state);
    let now = chrono::Utc::now().timestamp();
    let due: Vec<String> = pool
        .accounts
        .iter()
        .filter(|a| {
            !a.disabled
                && a.access_token_expires_at
                    .map(|e| e <= now + 48 * 3600)
                    .unwrap_or(false)
        })
        .map(|a| a.id.clone())
        .collect();
    if due.is_empty() {
        return Ok(json!({ "ok": true, "skipped": "无临期账号" }));
    }
    let mut renewed = 0usize;
    let mut failed = 0usize;
    for id in &due {
        match buddy_ai_refresh_impl(state, id) {
            Ok(_) => renewed += 1,
            Err(e) => {
                failed += 1;
                fs_utils::app_log(&state.data_dir, &format!("buddy-ai: 兜底续期失败 id={id}: {e}"));
            }
        }
    }
    if renewed == 0 {
        return Err(format!("buddy-ai 凭证续期全部失败（{failed} 个临期账号）"));
    }
    Ok(json!({ "ok": true, "renewed": renewed, "failed": failed }))
}

/// buddy-ai 模型目录同步实现（/v3/config 直连；手动命令与调度任务共用）。
/// 池内无可用凭证返回 Err（调度侧空池静默跳过不计失败）
pub fn buddy_ai_catalog_sync_impl(state: &AppState) -> Result<usize, String> {
    let pool = load_buddy_pool(state);
    let tokens = crate::tasks::wb_common::buddy_ai_token_store_load(&state.data_dir)
        .get("tokens")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    // 首个有凭证、未停用、未需重登的账号
    for a in &pool.accounts {
        if a.disabled || a.needs_relogin {
            continue;
        }
        let rec = tokens.get(&a.id).cloned().unwrap_or_default();
        let token = as_str(fs_utils::dig(&rec, &["access_token"]))
            .unwrap_or_default()
            .to_string();
        if token.is_empty() {
            continue;
        }
        let uid = if a.uid.is_empty() {
            as_str(fs_utils::dig(&rec, &["uid"])).unwrap_or_default().to_string()
        } else {
            a.uid.clone()
        };
        return crate::api_server::wb_catalog::buddy_ai_fetch_and_replace(&state.data_dir, &uid, &token)
            .inspect(|n| {
                // 首抓核对诊断（2026-10-16）：落盘成功后把前 3 条解析样本（rate/上下文/档位）
                // 落 app.log——倍率字段名候选集是否命中原响应，一眼可判
                let cat = crate::api_server::wb_catalog::buddy_ai_load(&state.data_dir);
                let sample: Vec<String> = cat
                    .iter()
                    .take(3)
                    .map(|m| {
                        format!(
                            "{} rate={} ctx={} efforts={:?}",
                            m.id, m.rate, m.context_length, m.supported_efforts
                        )
                    })
                    .collect();
                fs_utils::app_log(
                    &state.data_dir,
                    &format!("buddy-ai: Intl 目录首抓核对样本（{n} 模型）: {}", sample.join(" | ")),
                );
            });
    }
    Err("无可用 buddy-ai 账号凭证".into())
}

/// 手动同步 Intl 模型目录（资源调度页 / 概述页「同步目录」按钮）
#[tauri::command(async)]
pub fn buddy_ai_catalog_sync(state: State<'_, AppState>) -> Result<usize, String> {
    buddy_ai_catalog_sync_impl(&state)
}

// ── 存量迁移（§4.7）：wb 池混居的 global_region=true 账号一次性迁入 buddy-ai 池 ──

const MIGRATION_MARKER: &str = "buddy_ai_pool_migrated_v1";
const MIGRATION_BACKUP_KEY: &str = "buddy_ai_migration_backup";

// ── 每日活跃打卡（阶段 3b，§4.5 补篇）：NDJSON 进度管线 + 积分同步命令 ──────

/// 打卡整轮轮次互斥（独立于 WB_ROUND_LOCK——不与国内签到互斥，两池零交织）。
/// AtomicBool CAS + RAII guard：guard 不能跨 thread::spawn 移动（!Send），
/// 但 RAII 结构体（无借用）可以——Drop 自动复位，任意路径（含 panic 展开）
/// 都不会把 BUSY 永久挂起（审查修复：原实现调度器/启动补跑路径抢占后不释放，
/// 当天后续所有打卡轮次被 skipped_busy 永久跳过）
static BUDDY_AI_ROUND_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 打卡轮次 RAII 守卫：持有期间 BUSY=true，Drop（含 panic 展开）复位
pub(crate) struct BuddyAiRoundGuard;

impl Drop for BuddyAiRoundGuard {
    fn drop(&mut self) {
        BUDDY_AI_ROUND_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 抢打卡轮次（调度器 run_task / 启动钩子 / UI 命令三路复用；CAS 幂等语义）。
/// 守卫必须移动进执行线程，生命周期覆盖整轮
pub(crate) fn try_acquire_buddy_ai_round() -> Result<BuddyAiRoundGuard, String> {
    use std::sync::atomic::Ordering;
    BUDDY_AI_ROUND_BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map(|_| BuddyAiRoundGuard)
        .map_err(|_| "已有 buddy-ai 打卡任务在执行中".to_string())
}

/// buddy-ai 每日活跃打卡启动（手动触发，UI 进度经 buddy-ai-checkin-progress NDJSON 推送）
#[tauri::command(async)]
pub fn buddy_ai_checkin_start(app: tauri::AppHandle) -> Result<(), String> {
    // 轮次互斥：CAS 抢占（运行中重复点击显式拒绝）；守卫移动进执行线程，
    // 生命周期覆盖整轮（临时守卫若不 move 会在语句末 Drop 白抢一次锁）
    let _round = try_acquire_buddy_ai_round()?;
    std::thread::spawn(move || {
        let _round = _round; // 显式移动进闭包，Drop 自动复位 BUSY（含 panic 展开）
        let st = AppState::new();
        // FH-2 审查修复：Err（AppState 初始化失败）分支此前只发 exit，done 载荷
        // 从未 emit → 前端 running 复位、进度空白、零失败反馈。正常路径的 done 由
        // run_checkin_round 末尾回调发出（不在此重复 emit），此处仅 Err 分支补发
        let err_done = match st {
            Ok(st) => {
                let mut events: Vec<Value> = Vec::new();
                let done = crate::tasks::buddy_ai_checkin::run_checkin_round(&st, &mut |ev| {
                    // NDJSON 契约对齐 wb-checkin：payload 为序列化 JSON 字符串
                    let _ = app.emit("buddy-ai-checkin-progress", serde_json::to_string(ev).unwrap_or_default());
                    events.push(ev.clone());
                });
                // 汇总落日志（含单账号明细，排查打卡失败形态）
                fs_utils::app_log(
                    &st.data_dir,
                    &format!(
                        "buddy-ai: 活跃打卡整轮完成——ok={} already={} failed={} {}",
                        done.get("ok").and_then(Value::as_i64).unwrap_or(0),
                        done.get("already").and_then(Value::as_i64).unwrap_or(0),
                        done.get("failed").and_then(Value::as_i64).unwrap_or(0),
                        events.iter().filter(|e| e.get("status").and_then(Value::as_str) == Some("fail"))
                            .map(|e| format!("{}({})", e.get("id").and_then(Value::as_str).unwrap_or("?"), e.get("message").and_then(Value::as_str).unwrap_or("")))
                            .collect::<Vec<_>>()
                            .join("; "),
                    ),
                );
                None
            }
            Err(e) => Some(json!({ "type": "done", "ok": 0, "already": 0, "failed": 1, "message": e })),
        };
        if let Some(done) = err_done {
            let _ = app.emit("buddy-ai-checkin-progress", serde_json::to_string(&done).unwrap_or_default());
        }
        let _ = app.emit("buddy-ai-checkin-progress", serde_json::to_string(&json!({"type":"exit"})).unwrap_or_default());
    });
    Ok(())
}

/// buddy-ai 积分同步（阶段 3b Intl 化）：全池账号 get-user-resource（R-6 字段链
/// TotalDosage）→ 回写池 credits 三键（buddy_ai_pool_lock 短临界区）→ 返回刷新后视图。
/// 手动触发与调度器看板同步共用解析 fn（fetch_total_dosage）。
#[tauri::command(async)]
pub fn buddy_ai_credits_fetch(app: AppHandle, state: State<AppState>) -> Result<Vec<Value>, String> {
    let rt = app.state::<std::sync::Mutex<Option<crate::commands::api_server::ApiServerRuntime>>>();
    buddy_ai_credits_sync_impl(&state, Some(rt.inner()))
}

/// 调度器/命令共用的积分同步实现（runtime 句柄用于运行池三键拨新——issue #109 同类；
/// CLI 进程传 None 跳过，对齐 wb_credits_snapshot_task 口径）
pub fn buddy_ai_credits_sync_impl(
    state: &AppState,
    runtime: Option<&std::sync::Mutex<Option<crate::commands::api_server::ApiServerRuntime>>>,
) -> Result<Vec<Value>, String> {
    let agent = crate::tasks::http_agent(30);
    let pool = load_buddy_pool(state);
    let tokens = crate::tasks::wb_common::buddy_ai_token_store_load(&state.data_dir)
        .get("tokens")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for a in &pool.accounts {
        let rec = tokens.get(&a.id).cloned().unwrap_or_default();
        let token = as_str(fs_utils::dig(&rec, &["access_token"])).unwrap_or_default().to_string();
        if token.is_empty() {
            continue;
        }
        let uid = if a.uid.is_empty() {
            as_str(fs_utils::dig(&rec, &["uid"])).unwrap_or_default().to_string()
        } else {
            a.uid.clone()
        };
        let base = crate::tasks::wb_common::region_activity_base(&intl_domain_or(as_str(fs_utils::dig(&rec, &["domain"]))));
        let snap = crate::tasks::buddy_ai_checkin::fetch_dosage_info(&agent, base, &token, &uid);
        out.push((a.id.clone(), snap));
    }
    // 短临界区回写快照三键
    {
        let _guard = state.buddy_ai_pool_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut pool = load_buddy_pool(state);
        let now = chrono::Utc::now().to_rfc3339();
        for (id, snap) in &out {
            if let Some(a) = pool.accounts.iter_mut().find(|a| &a.id == id) {
                if let Some(info) = snap {
                    a.credits_balance = Some(info.total);
                    a.credits_fetched_at = Some(now.clone());
                    if info.expire_secs.is_some() {
                        a.credits_expire_at = info.expire_secs; // 秒级时间戳
                    }
                    // P9 分包明细（get-user-resource Accounts[] 深度解析）
                    a.credits_packages = serde_json::to_value(&info.packages).ok();
                }
            }
        }
        save_buddy_pool(state, &pool)?;
        // P8：手动同步回写后刷新当日积分快照（锁内调用）
        buddy_ai_credits_snapshot_save(state, &pool);
    }
    // 运行池三键拨新（issue #109 同类，buddy-ai 国际池）：账号记录已回写，但网关
    // 运行池钉死在装配时刻——expire_first「有过期时间者优先」会恒压池内
    // expire=None 的账号，充值续期后的新到期进不了池。快照缺到期信息时保留池内
    // 旧值（对齐上方账号记录 expire 仅 Some 才覆盖的口径），余额以本次取数为准
    {
        let shared = runtime
            .map(|rt| {
                rt.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                    .map(|g| g.shared.clone())
            })
            .unwrap_or(None);
        if let Some(shared) = shared {
            let current: std::collections::HashMap<String, Option<i64>> = shared
                .buddy_ai_pool
                .status_list()
                .into_iter()
                .map(|s| (s.uid, s.credits_expire_at))
                .collect();
            let m: std::collections::HashMap<String, (f64, Option<i64>)> = out
                .iter()
                .filter_map(|(id, snap)| {
                    let info = snap.as_ref()?;
                    let expire =
                        info.expire_secs.or_else(|| current.get(id).copied().flatten());
                    Some((id.clone(), (info.total, expire)))
                })
                .collect();
            if !m.is_empty() {
                shared.buddy_ai_pool.update_credits_snapshot(&m);
            }
        }
    }
    fs_utils::app_log(
        &state.data_dir,
        &format!(
            "buddy-ai: 积分同步完成——{} 账号，{} 成功取数",
            out.len(),
            out.iter().filter(|(_, s)| s.is_some()).count()
        ),
    );
    // 返回刷新后的账号视图（前端直接替换列表，免二次拉取）
    let pool = load_buddy_pool(state);
    let tokens2 = crate::tasks::wb_common::buddy_ai_token_store_load(&state.data_dir)
        .get("tokens")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    Ok(pool
        .accounts
        .iter()
        .map(|a| {
            let rec = tokens2.get(&a.id).cloned().unwrap_or_default();
            json!({
                "id": a.id, "uid": a.uid, "nickname": a.nickname, "note": a.note,
                "group_id": a.group_id,
                "access_token_expires_at": a.access_token_expires_at,
                "refresh_token_expires_at": a.refresh_token_expires_at,
                "auth_saved_at": a.auth_saved_at,
                "needs_relogin": a.needs_relogin, "relogin_reason": a.relogin_reason,
                "disabled": a.disabled,
                "credits_balance": a.credits_balance, "credits_expire_at": a.credits_expire_at,
                "credits_fetched_at": a.credits_fetched_at,
                "credits_packages": a.credits_packages,
                "has_credential": rec.get("access_token").and_then(Value::as_str).map(|t| !t.is_empty()).unwrap_or(false),
                "domain": rec.get("domain").and_then(Value::as_str).unwrap_or("www.workbuddy.ai"),
            })
        })
        .collect())
}

/// buddy-ai 打卡调度开关（scheduler enabled 分支用）
pub(crate) fn buddy_ai_checkin_enabled(state: &AppState) -> bool {
    state.settings().buddy_ai_checkin_enabled
}

/// buddy-ai 池账号数（调度器 models 类任务空池静默跳过判定用）
pub(crate) fn buddy_ai_pool_size(state: &AppState) -> usize {
    load_buddy_pool(state).accounts.len()
}

/// 启动打卡补跑（对齐 startup_auto_checkin 形态）：60s 延迟 → 抢轮次锁 →
/// 整轮静默执行 → 汇总落日志；失败 push_notify（main.rs 启动钩子调用）
pub fn startup_auto_checkin_buddy_ai(app: &tauri::AppHandle, state: &AppState) {
    if !state.settings().buddy_ai_checkin_enabled {
        return;
    }
    let app2 = app.clone();
    let data_dir = state.data_dir.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(60));
        // 抢不到轮次锁（UI 手动打卡在跑）= 幂等跳过
        let Ok(_guard) = try_acquire_buddy_ai_round() else {
            return;
        };
        let st = AppState::new();
        let Ok(st) = st else { return };
        let mut events: Vec<Value> = Vec::new();
        let done = crate::tasks::buddy_ai_checkin::run_checkin_round(&st, &mut |ev| events.push(ev.clone()));
        let ok = done.get("ok").and_then(Value::as_i64).unwrap_or(0);
        let failed = done.get("failed").and_then(Value::as_i64).unwrap_or(0);
        fs_utils::app_log(
            &data_dir,
            &format!("buddy-ai: 启动补跑活跃打卡——ok={ok} already={} failed={failed}",
                done.get("already").and_then(Value::as_i64).unwrap_or(0)),
        );
        if failed > 0 {
            let names: Vec<String> = events
                .iter()
                .filter(|e| e.get("status").and_then(Value::as_str) == Some("fail"))
                .map(|e| e.get("name").and_then(Value::as_str).unwrap_or("?").to_string())
                .collect();
            crate::commands::workbuddy::push_notify(
                Some(&app2),
                &data_dir,
                "Buddy 国际版打卡",
                &format!("{} 个账号打卡失败：{}", failed, names.join("、")),
                crate::notify::NotifyEvent::TaskFail,
            );
        }
    });
}

/// 启动迁移（幂等，kv 标记置位后不重跑）：
/// 1. 扫 wb 池 + wb token store（secure 回填），token rec `domain` 含 `.workbuddy.ai`
///    即混居国际账号（global_region 判定唯一真源 = domain 字段，§4.1）；
/// 2. 迁移前整份备份落 kv（`buddy_ai_migration_backup`，审计 + 人工回滚依据）；
/// 3. 账号行迁 `buddy_ai_accounts`、凭证迁 `buddy_ai_tokens`（敏感值随读随写进
///    buddy-ai vault 命名空间，DB 一律占位）并从 wb 侧删除对应行；
/// 4. 任一步失败：返回 Err、不置位标记（下次启动重试），已写侧幂等（同 id upsert）；
/// 5. 迁移报告结构化落 app_log，不搞子串匹配推断。
///
/// 锁序：wb_pool_lock → buddy_ai_pool_lock（单向，无环；与池内其他路径不冲突——
/// 两池命令各自只持一锁）。
pub fn migrate_wb_global_accounts(state: &AppState) -> Result<(usize, usize), String> {
    let db = crate::store::db(&state.data_dir);
    if db.kv_get_raw(MIGRATION_MARKER).is_some() {
        return Ok((0, 0));
    }
    // 审查修复（H2）：wb 池读-改-写全程持 wb_pool_lock——迁移窗口内并发的 wb 池
    // 命令（导入/删除/积分回写）同为读-改-写，无锁会互相覆盖丢更新
    let _wb_guard = state.wb_pool_lock.lock().unwrap_or_else(|e| e.into_inner());
    // secure 回填读（仅内存）：迁移要把敏感值从 wb vault 命名空间搬到 buddy-ai 命名空间
    let wb_store = crate::tasks::wb_common::token_store_load_secure(&state.data_dir);
    let wb_tokens = wb_store.get("tokens").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut wb_pool = load_pool(state);

    let mut moved_accounts: Vec<WorkBuddyAccount> = Vec::new();
    let mut moved_tokens: serde_json::Map<String, Value> = serde_json::Map::new();
    let mut stay_ids: Vec<String> = Vec::new();
    let drained: Vec<WorkBuddyAccount> = wb_pool.accounts.drain(..).collect();
    for a in drained {
        let rec = wb_tokens.get(&a.id).cloned().unwrap_or_default();
        let domain = as_str(fs_utils::dig(&rec, &["domain"])).unwrap_or_default();
        if crate::tasks::wb_common::is_global_region(&domain) {
            moved_tokens.insert(a.id.clone(), rec);
            moved_accounts.push(a);
        } else {
            stay_ids.push(a.id.clone());
            wb_pool.accounts.push(a);
        }
    }
    if moved_accounts.is_empty() {
        // 零混居：直接置位标记（幂等闸门），避免每次启动重复扫描
        db.kv_set_raw(MIGRATION_MARKER, &chrono::Utc::now().to_rfc3339())?;
        return Ok((0, stay_ids.len()));
    }

    // 备份先行（审计口径：备份的是 DB 占位形态，不含明文凭证）。
    // 审查修复（C1）：moved_tokens 来自 secure 回填读（内存明文）——备份前必须把
    // 敏感键置空，否则明文 access/refresh token 经 kv_set_raw 落 SQLite，DB 文件
    // 泄漏即凭证泄漏（回滚场景由用户重新登录/导入恢复凭证，不影响账号结构回滚）
    const BACKUP_SENSITIVE_KEYS: [&str; 4] = [
        "access_token",
        "accessToken",
        "refresh_token",
        "refreshToken",
    ];
    let mut backup_tokens = moved_tokens.clone();
    for rec in backup_tokens.values_mut() {
        if let Some(rm) = rec.as_object_mut() {
            for k in BACKUP_SENSITIVE_KEYS {
                if rm.contains_key(k) {
                    rm.insert(k.to_string(), json!(""));
                }
            }
        }
    }
    let backup = json!({
        "migrated_at": chrono::Utc::now().to_rfc3339(),
        "accounts": moved_accounts,
        "tokens": backup_tokens,
    });
    db.kv_set_raw(MIGRATION_BACKUP_KEY, &serde_json::to_string(&backup).map_err(|e| e.to_string())?)?;

    // buddy-ai 侧先写（幂等 upsert；失败即整体失败，wb 侧未动）。
    // 审查修复（H2/H3）：buddy 侧写入持 buddy_ai_pool_lock（锁序 wb→buddy 单向）；
    // 池行按 id upsert——部分失败重试时纯 push 会产生重复账号行（凭证写成功、
    // wb 侧回写失败 → 标记未置位 → 下次启动重扫重迁）
    {
        let _buddy_guard = state.buddy_ai_pool_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut buddy_pool = load_buddy_pool(state);
        for a in &moved_accounts {
            if let Some(existing) = buddy_pool.accounts.iter_mut().find(|x| x.id == a.id) {
                *existing = a.clone();
            } else {
                buddy_pool.accounts.push(a.clone());
            }
        }
        save_buddy_pool(state, &buddy_pool)?;
        for (id, rec) in &moved_tokens {
            crate::tasks::wb_common::buddy_ai_token_store_upsert(&state.data_dir, id, rec)?;
        }
    }
    // wb 侧后写（池整存 + 混居 token 行删除；vault 旧条目留存不删——加密数据无害，
    // 避免迁移中断后 wb 侧凭证丢失不可回滚）。wb_pool_lock 已在函数顶部持有。
    // BM-1 审查修复：标记先于 token 行删除置位——③删行与④置位间中断时，重试会因
    // wb token 行已删（domain 丢失 → 非 global 判定）把已迁账号误归留守 wb 池，
    // 产生「wb 池无凭证幽灵账号 + buddy-ai 池重复」且迁移永久放弃。先置位后删行：
    // 中断残留的 wb token 行无人消费（wb 池行已移除），无害可清
    {
        save_pool(state, &wb_pool)?;
        db.kv_set_raw(MIGRATION_MARKER, &chrono::Utc::now().to_rfc3339())?;
        for id in moved_tokens.keys() {
            crate::store::docs::token_store_remove(&db, "wb_tokens", id)?;
        }
    }
    let names: Vec<String> = moved_accounts.iter().map(|a| a.id.clone()).collect();
    fs_utils::app_log(
        &state.data_dir,
        &format!(
            "buddy-ai: 存量迁移完成——{} 个国际账号由 wb 池迁入 buddy-ai 池 [{}]；wb 池残留 {} 个（零 global 校验通过）",
            moved_accounts.len(),
            names.join(","),
            stay_ids.len()
        ),
    );
    Ok((moved_accounts.len(), stay_ids.len()))
}

/// 编辑 buddy-ai 账号（P3 对齐 workbuddy_account_save：昵称/备注/分组；
/// 池读-改-写互斥 buddy_ai_pool_lock，防并发旧副本整文档覆盖丢改动）
#[tauri::command(async)]
pub fn buddy_ai_account_save(
    state: State<'_, AppState>,
    user_id: String,
    name: Option<String>,
    note: Option<String>,
    group_id: Option<String>,
) -> Result<(), String> {
    let _guard = state.buddy_ai_pool_lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut pool = load_buddy_pool(&state);
    let acct = pool
        .accounts
        .iter_mut()
        .find(|a| a.id == user_id)
        .ok_or_else(|| format!("账号不存在: {user_id}"))?;
    if let Some(n) = name {
        acct.nickname = n;
    }
    if let Some(n) = note {
        acct.note = n;
    }
    if let Some(g) = group_id {
        acct.group_id = g;
    }
    save_buddy_pool(&state, &pool)
}

/// buddy-ai 账号启停（P3/P6「账号调度池」）：停用即退出打卡花名册与网关取号
///（roster/upstream_accounts 双过滤）；池读-改-写互斥同上
#[tauri::command(async)]
pub fn buddy_ai_account_toggle(
    state: State<'_, AppState>,
    user_id: String,
    disabled: bool,
) -> Result<(), String> {
    let _guard = state.buddy_ai_pool_lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut pool = load_buddy_pool(&state);
    let acct = pool
        .accounts
        .iter_mut()
        .find(|a| a.id == user_id)
        .ok_or_else(|| format!("账号不存在: {user_id}"))?;
    acct.disabled = disabled;
    save_buddy_pool(&state, &pool)
}

/// buddy-ai 官网请求流水查询（P9 抓包解锁：/v2/billing/meter/get-user-request-usage
/// 分页接口，credit/model/client/requestTime/input/agentPurpose 请求级明细）。
/// 积分看板「请求明细」表 + 模型级真实积分数据源；鉴权同 get-user-resource（Bearer）。
/// /v2 前缀不可用时回退裸路径（官网网页走裸路径，双兼容）
#[tauri::command(async)]
pub fn buddy_ai_request_usage(
    state: State<'_, AppState>,
    user_id: String,
    days: Option<i64>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<Value, String> {
    let acct = {
        let pool = load_buddy_pool(&state);
        pool.accounts
            .iter()
            .find(|a| a.id == user_id)
            .cloned()
            .ok_or_else(|| format!("账号不在 buddy-ai 池中: {user_id}"))?
    };
    let tokens = load_buddy_tokens(&state);
    let rec = tokens
        .get("tokens")
        .and_then(|t| t.get(&acct.id))
        .cloned()
        .unwrap_or_default();
    let token = as_str(fs_utils::dig(&rec, &["access_token"]))
        .filter(|t| !t.is_empty())
        .ok_or("该账号无 access_token（不可查询官网流水）")?;
    let uid = if acct.uid.is_empty() {
        as_str(fs_utils::dig(&rec, &["uid"])).unwrap_or_default().to_string()
    } else {
        acct.uid.clone()
    };
    let base = crate::tasks::wb_common::region_activity_base(&intl_domain_or(as_str(fs_utils::dig(
        &rec,
        &["domain"],
    ))));
    let days = days.unwrap_or(7).clamp(1, 31);
    let page = page.unwrap_or(1).max(1);
    let page_size = page_size.unwrap_or(20).clamp(1, 100);
    let start = (chrono::Local::now() - chrono::Duration::days(days - 1))
        .format("%Y-%m-%d 00:00:00")
        .to_string();
    let end = chrono::Local::now().format("%Y-%m-%d 23:59:59").to_string();
    let body = json!({
        "startTime": start,
        "endTime": end,
        "pageNum": page,
        "pageSize": page_size,
    });
    let agent = crate::tasks::http_agent(30);
    // BL-1 审查修复：按状态码判定路径回退（原实现对错误字符串 contains("404")
    // 匹配——依赖 ureq Display 格式，网络错误消息偶含 "404" 会误触发重试）
    enum UsageErr {
        Status(u16),
        Msg(String),
    }
    let send = |url: String| -> Result<Value, UsageErr> {
        let resp = agent
            .post(&url)
            .set("Authorization", &format!("Bearer {token}"))
            .set("X-User-Id", &uid)
            .set("X-Client-Platform", "web")
            .set("Content-Type", "application/json")
            .send_string(&body.to_string())
            .map_err(|e| match e {
                ureq::Error::Status(code, _) => UsageErr::Status(code),
                other => UsageErr::Msg(other.to_string()),
            })?;
        resp.into_json()
            .map_err(|e| UsageErr::Msg(format!("请求流水响应解析失败: {e}")))
    };
    let v = match send(format!("{base}/v2/billing/meter/get-user-request-usage")) {
        Ok(v) => v,
        // 404 = /v2 前缀不存在 → 回退裸路径（官网网页走裸路径）
        Err(UsageErr::Status(404)) => send(format!("{base}/billing/meter/get-user-request-usage"))
            .map_err(|e| match e {
                UsageErr::Status(code) => format!("请求流水查询失败（HTTP {code}）"),
                UsageErr::Msg(m) => m,
            })?,
        Err(UsageErr::Status(code)) => return Err(format!("请求流水查询失败（HTTP {code}）")),
        Err(UsageErr::Msg(m)) => return Err(m),
    };
    if v.get("code").and_then(Value::as_i64) != Some(0) {
        return Err(format!(
            "官网返回异常: {}",
            v.get("msg").and_then(Value::as_str).unwrap_or("未知错误")
        ));
    }
    // 信封：{code, data: {total, data: [rows]}}（小写 data，与 get-user-resource 大写嵌套不同）
    let data = v.get("data").cloned().unwrap_or_default();
    let total = data.get("total").and_then(Value::as_i64).unwrap_or(0);
    // 行脱敏：input 全文不外发，仅保留 inputTrunc（明细展示口径）
    let rows: Vec<Value> = data
        .get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|r| {
                    json!({
                        "requestId": r.get("requestId").cloned().unwrap_or_default(),
                        "credit": r.get("credit").cloned().unwrap_or(json!(0)),
                        "model": r.get("model").cloned().unwrap_or_default(),
                        "client": r.get("client").cloned().unwrap_or_default(),
                        "requestTime": r.get("requestTime").cloned().unwrap_or_default(),
                        "inputTrunc": r.get("inputTrunc").cloned().unwrap_or_default(),
                        "agentPurpose": r.get("agentPurpose").cloned().unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "total": total, "page": page, "pageSize": page_size, "rows": rows }))
}

/// buddy-ai 积分历史查询（P8：趋势曲线数据源；近 N 天快照升序，默认 90 天）
#[tauri::command(async)]
pub fn buddy_ai_credits_history(
    state: State<'_, AppState>,
    days: Option<i64>,
) -> Result<Vec<Value>, String> {
    let days = days.unwrap_or(90).clamp(7, 365);
    let cutoff = (chrono::Local::now().date_naive() - chrono::Duration::days(days))
        .format("%Y-%m-%d")
        .to_string();
    let raw = crate::store::docs::buddy_ai_credits_history_load(&crate::store::db(&state.data_dir));
    let mut out = Vec::new();
    if let Some(arr) = raw.get("snapshots").and_then(Value::as_array) {
        for r in arr {
            if r.get("date").and_then(Value::as_str).unwrap_or("") < cutoff.as_str() {
                continue;
            }
            out.push(r.clone());
        }
    }
    Ok(out)
}

/// buddy-ai 账号池导出（P8 对齐 workbuddy_accounts_export；include_credentials=true
/// 附带凭证明文副本——前端强确认 + 本地落盘，导出文件等同密码请妥善保管）
#[tauri::command(async)]
pub fn buddy_ai_accounts_export(
    state: State<'_, AppState>,
    include_credentials: Option<bool>,
) -> Result<Value, String> {
    let pool = load_buddy_pool(&state);
    let mut v = serde_json::to_value(&pool).map_err(|e| format!("序列化失败: {e}"))?;
    v["export_kind"] = json!("buddy-ai-pool");
    v["exported_at"] = json!(chrono::Utc::now().to_rfc3339());
    if include_credentials.unwrap_or(false) {
        // 凭证副本（vault 回填后明文，仅内存）；落盘由前端 save 对话框完成
        v["tokens"] = load_buddy_tokens(&state).get("tokens").cloned().unwrap_or_default();
    } else {
        // 脱敏导出：不含任何凭证字段（安全红线：默认路径零明文）
        v["tokens"] = json!({});
    }
    Ok(v)
}

/// buddy-ai 账号池导入（P8 对齐 workbuddy_accounts_import；accounts_export 的回导）。
/// 合并语义：同 id 账号跳过（不覆盖池内现状），新账号追加；tokens 副本仅对
/// token store 中不存在的账号回灌（避免覆盖池内更新的轮换凭证）。
/// 返回 {added, skipped, invalid, tokens_added}。
#[tauri::command(async)]
pub fn buddy_ai_accounts_import(state: State<'_, AppState>, pool_json: Value) -> Result<Value, String> {
    let arr = pool_json
        .get("accounts")
        .and_then(Value::as_array)
        .ok_or_else(|| "导入文件缺少 accounts 数组（须为「导出账号」生成的 JSON）".to_string())?;
    if arr.len() > 500 {
        return Err(format!("导入账号数超限（{} > 500）", arr.len()));
    }
    let imported_tokens = pool_json.get("tokens").and_then(Value::as_object).cloned();

    let mut added = 0usize;
    let mut skipped = 0usize;
    let mut invalid = 0usize;
    let mut new_accounts: Vec<WorkBuddyAccount> = Vec::new();
    for row in arr {
        match serde_json::from_value::<WorkBuddyAccount>(row.clone()) {
            Ok(a) => new_accounts.push(a),
            Err(_) => invalid += 1,
        }
    }

    let _guard = state.buddy_ai_pool_lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut pool = load_buddy_pool(&state);
    let mut token_targets: Vec<(String, Value)> = Vec::new();
    for a in new_accounts {
        // id 硬校验（与 buddy_ai_account_remove 的 64 字符上限同口径；防超长/带空白脏数据入池）
        if a.id.is_empty() || a.id.len() > 64 || a.id.trim() != a.id {
            invalid += 1;
            continue;
        }
        if pool.accounts.iter().any(|x| x.id == a.id) {
            skipped += 1;
            continue;
        }
        // 凭证副本回灌：仅当 token store 中该 id 不存在（避免覆盖池内轮换后的新凭证）
        if let Some(tmap) = &imported_tokens {
            if let Some(rec) = tmap.get(&a.id) {
                if rec.get("access_token").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false)
                    || rec.get("refresh_token").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false)
                {
                    token_targets.push((a.id.clone(), rec.clone()));
                }
            }
        }
        pool.accounts.push(a);
        added += 1;
    }
    if added > 0 {
        save_buddy_pool(&state, &pool)?;
    }
    let mut tokens_added = 0usize;
    for (id, rec) in token_targets {
        if crate::tasks::wb_common::buddy_ai_token_store_upsert(&state.data_dir, &id, &rec).is_ok() {
            tokens_added += 1;
        }
    }
    fs_utils::app_log(
        &state.data_dir,
        &format!("buddy-ai: 导入账号池 added={added} skipped={skipped} invalid={invalid} tokens={tokens_added}"),
    );
    Ok(json!({ "added": added, "skipped": skipped, "invalid": invalid, "tokens_added": tokens_added }))
}

/// 扫描本机 WorkBuddy AI 客户端登录账号（P8 对齐国内「扫描本机账号」）。
/// 数据源：`~/.workbuddy-ai/storage/skeleton/account-snapshot.json` 的 `primary`
/// （uid / nickname / editionType / isPro / savedAt，客户端本机登录态落盘）。
/// 国际版凭证存于 `security/{uid}` 加密 vault（不可提取明文），故本命令只做
/// 「识别 + 池内匹配」：uid 已在池中 → in_pool=true；不在池中 → 前端引导 OAuth 扫码。
#[tauri::command(async)]
pub fn buddy_ai_local_scan(state: State<'_, AppState>) -> Result<Value, String> {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    if home.is_empty() {
        return Err("无法解析用户主目录（USERPROFILE 为空）".into());
    }
    let snap_path = std::path::PathBuf::from(&home)
        .join(".workbuddy-ai")
        .join("storage")
        .join("skeleton")
        .join("account-snapshot.json");
    if !snap_path.is_file() {
        return Ok(json!({
            "found": false,
            "reason": "未找到本机登录快照（客户端未安装或未登录）：~/.workbuddy-ai/storage/skeleton/account-snapshot.json"
        }));
    }
    let raw = std::fs::read_to_string(&snap_path).map_err(|e| format!("读取登录快照失败: {e}"))?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| format!("解析登录快照失败: {e}"))?;
    let p = v.get("primary").cloned().unwrap_or_default();
    let uid = p.get("uid").and_then(Value::as_str).unwrap_or("").to_string();
    let nickname = p.get("nickname").and_then(Value::as_str).unwrap_or("").to_string();
    let edition = p.get("editionType").and_then(Value::as_str).unwrap_or("").to_string();
    let is_pro = p.get("isPro").and_then(Value::as_bool).unwrap_or(false);
    let saved_at = p.get("savedAt").and_then(Value::as_i64).unwrap_or(0);
    // 池内匹配：uid 或 nickname（uid 为空时按昵称兜底）
    let pool = load_buddy_pool(&state);
    let matched = pool
        .accounts
        .iter()
        .find(|a| (!uid.is_empty() && a.uid == uid) || (!nickname.is_empty() && a.nickname == nickname))
        .map(|a| a.id.clone());
    Ok(json!({
        "found": true,
        "uid": uid,
        "nickname": nickname,
        "edition_type": edition,
        "is_pro": is_pro,
        "saved_at_ms": saved_at,
        "in_pool": matched.is_some(),
        "pool_account_id": matched.unwrap_or_default(),
    }))
}

/// buddy-ai 环境重置（P8 对齐国内「环境重置」；白名单目录清理 + 可选登录态清除）。
/// 白名单（硬编码，拒绝任意路径）：cache/logs/pending-telemetry/traces/shell-snapshots/
/// editor-sdk-sandbox-ws/file-tree-manifests/memory/workspace-sessions（=workspace/sessions）；
/// "login" 为登录态清除（security/{uid} 加密 vault 整目录删除 = 客户端登出，强确认后执行）。
/// 返回逐项 {item, ok, detail}。
#[tauri::command(async)]
pub fn buddy_ai_env_reset(state: State<'_, AppState>, items: Vec<String>) -> Result<Value, String> {
    const ALLOWED: &[&str] = &[
        "cache",
        "logs",
        "pending-telemetry",
        "traces",
        "shell-snapshots",
        "editor-sdk-sandbox-ws",
        "file-tree-manifests",
        "memory",
        "workspace-sessions",
        "login",
    ];
    if items.is_empty() || items.len() > ALLOWED.len() {
        return Err("重置项为空或超限".into());
    }
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    if home.is_empty() {
        return Err("无法解析用户主目录（USERPROFILE 为空）".into());
    }
    let root = std::path::PathBuf::from(&home).join(".workbuddy-ai");
    if !root.is_dir() {
        return Err(format!("目录不存在：{}", root.display()));
    }
    let mut results: Vec<Value> = Vec::new();
    for it in &items {
        if !ALLOWED.contains(&it.as_str()) {
            results.push(json!({ "item": it, "ok": false, "detail": "不在白名单内" }));
            continue;
        }
        let targets: Vec<std::path::PathBuf> = match it.as_str() {
            "workspace-sessions" => vec![root.join("workspace").join("sessions")],
            // 登录态清除：security/ 下含 cipher/ 的 uid 目录（= 客户端加密凭证库）
            "login" => std::fs::read_dir(root.join("security"))
                .map(|rd| {
                    rd.flatten()
                        .filter(|e| e.path().is_dir() && e.path().join("cipher").is_dir())
                        .map(|e| e.path())
                        .collect()
                })
                .unwrap_or_default(),
            other => vec![root.join(other)],
        };
        let mut ok = true;
        let mut detail = String::new();
        for t in &targets {
            if !t.exists() {
                continue;
            }
            match std::fs::remove_dir_all(t) {
                Ok(()) => detail.push_str(&format!("已清除 {}；", t.display())),
                Err(e) => {
                    ok = false;
                    detail.push_str(&format!("清除 {} 失败: {e}；", t.display()));
                }
            }
        }
        if detail.is_empty() {
            detail = "无内容".into();
        }
        results.push(json!({ "item": it, "ok": ok, "detail": detail.trim_end_matches('；') }));
    }
    let fail = results.iter().filter(|r| !r["ok"].as_bool().unwrap_or(false)).count();
    fs_utils::app_log(
        &state.data_dir,
        &format!("buddy-ai: 环境重置 items={:?} 失败项={fail}", items),
    );
    Ok(json!({ "results": results, "failed": fail }))
}

/// 打开 WorkBuddy AI 国际客户端数据目录（P7 环境配置卡对齐国内
/// workbuddy_open_auth_dir；目录为 %USERPROFILE%\.workbuddy-ai，与国内
/// .workbuddy 为不同安装目录）。目录不存在时降级打开其父目录（首次安装前
/// 该目录尚未生成，父目录即用户主目录，仍有定位价值）
#[tauri::command(async)]
pub fn buddy_ai_open_data_dir() -> Result<(), String> {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    if home.is_empty() {
        return Err("无法解析用户主目录（USERPROFILE 为空）".into());
    }
    let dir = std::path::PathBuf::from(&home).join(".workbuddy-ai");
    let target = if dir.is_dir() { dir.clone() } else { dir.parent().map(|p| p.to_path_buf()).ok_or_else(|| format!("目录不存在：{}", dir.display()))? };
    std::process::Command::new("explorer")
        .arg(&target)
        .spawn()
        .map_err(|e| format!("打开数据目录失败: {e}"))?;
    Ok(())
}

/// buddy-ai 每日活跃打卡结果查询（P2 对齐 workbuddy_checkin_results；数据源
/// buddy_ai_checkin_results 表，run_checkin_round 整轮落库，90 天裁剪）。
/// 概述趋势图 / 签到日历 / 结果列表共用此数据源
#[tauri::command(async)]
pub fn buddy_ai_checkin_results(
    state: State<'_, AppState>,
    days: Option<i64>,
) -> Result<Vec<super::checkin::WbCheckinRecord>, String> {
    let days = days.unwrap_or(30).clamp(1, 90);
    let cutoff = (chrono::Local::now().date_naive() - chrono::Duration::days(days))
        .format("%Y-%m-%d")
        .to_string();
    let raw: serde_json::Value =
        crate::store::docs::buddy_ai_checkin_results_load(&crate::store::db(&state.data_dir));
    let mut out = Vec::new();
    if let Some(arr) = raw.get("results").and_then(|v| v.as_array()) {
        for r in arr {
            let date = r.get("date").and_then(|v| v.as_str()).unwrap_or("");
            if date < cutoff.as_str() {
                continue;
            }
            out.push(super::checkin::WbCheckinRecord {
                date: date.into(),
                time: r.get("time").and_then(|v| v.as_str()).unwrap_or("").into(),
                user_id: r.get("user_id").and_then(|v| v.as_str()).unwrap_or("").into(),
                name: r.get("name").and_then(|v| v.as_str()).unwrap_or("").into(),
                status: r.get("status").and_then(|v| v.as_str()).unwrap_or("").into(),
                message: r.get("message").and_then(|v| v.as_str()).unwrap_or("").into(),
                reward: r.get("reward").and_then(|v| v.as_f64()),
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_state(tag: &str) -> AppState {
        let d = std::env::temp_dir().join(format!("twa_buddy_ai_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        AppState {
            data_dir: d,
            jwt_refresh_lock: std::sync::Arc::new(std::sync::Mutex::new(())),
            qoder_pool_lock: std::sync::Arc::new(std::sync::Mutex::new(())),
            wb_pool_lock: std::sync::Arc::new(std::sync::Mutex::new(())),
            buddy_ai_pool_lock: std::sync::Arc::new(std::sync::Mutex::new(())),
            doubao_pool_lock: std::sync::Arc::new(std::sync::Mutex::new(())),
            group_defs_lock: std::sync::Arc::new(std::sync::Mutex::new(())),
        }
    }

    fn acct(id: &str) -> WorkBuddyAccount {
        WorkBuddyAccount {
            id: id.into(),
            ..Default::default()
        }
    }

    /// 迁移：wb 池混居 1 国际 + 1 国内 → 国际迁入 buddy-ai、国内留守、标记置位；
    /// 二次调用幂等跳过
    #[test]
    fn migration_moves_global_accounts_and_is_idempotent() {
        let st = tmp_state("mig");
        // wb 池：1 国际（domain 含 .workbuddy.ai）+ 1 国内
        let global = WorkBuddyAccount { id: "wb-g1".into(), nickname: "intl".into(), ..Default::default() };
        let cn = acct("wb-c1");
        {
            let pool = WbPool { accounts: vec![global, cn] };
            let v = serde_json::to_value(&pool).unwrap();
            crate::store::docs::wb_pool_save(&crate::store::db(&st.data_dir), &v).unwrap();
        }
        let db = crate::store::db(&st.data_dir);
        db.row_upsert("wb_tokens", "wb-g1", &json!({"domain": "www.workbuddy.ai", "access_token": ""})).unwrap();
        db.row_upsert("wb_tokens", "wb-c1", &json!({"domain": "", "access_token": ""})).unwrap();

        let (moved, stay) = migrate_wb_global_accounts(&st).unwrap();
        assert_eq!((moved, stay), (1, 1));

        // buddy-ai 侧到位
        let buddy = load_buddy_pool(&st);
        assert_eq!(buddy.accounts.len(), 1);
        assert_eq!(buddy.accounts[0].id, "wb-g1");
        let buddy_tokens = crate::store::docs::token_store_load(crate::tasks::wb_common::BUDDY_AI_TOKEN_TABLE, &db);
        assert!(buddy_tokens["tokens"]["wb-g1"]["domain"].as_str().unwrap().contains(".workbuddy.ai"));
        // wb 侧零 global 残留 + 对应 token 行已删
        let wb = load_pool(&st);
        assert_eq!(wb.accounts.len(), 1);
        assert_eq!(wb.accounts[0].id, "wb-c1");
        let wb_tokens = crate::store::docs::wb_token_store_load(&db);
        assert!(wb_tokens["tokens"].get("wb-g1").is_none(), "混居 token 行应已删除");
        assert!(wb_tokens["tokens"].get("wb-c1").is_some(), "国内 token 行保留");
        // 备份与标记
        assert!(db.kv_get_raw(MIGRATION_BACKUP_KEY).is_some());
        assert!(db.kv_get_raw(MIGRATION_MARKER).is_some());
        // 幂等：再次调用零动作
        let (m2, _s2) = migrate_wb_global_accounts(&st).unwrap();
        assert_eq!(m2, 0);
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    /// 零混居：直接置位标记不产生备份（防迁移恒真弹窗/重复扫描）
    #[test]
    fn migration_with_zero_global_sets_marker_only() {
        let st = tmp_state("zero");
        let pool = WbPool { accounts: vec![acct("wb-c1")] };
        let v = serde_json::to_value(&pool).unwrap();
        crate::store::docs::wb_pool_save(&crate::store::db(&st.data_dir), &v).unwrap();
        let (moved, stay) = migrate_wb_global_accounts(&st).unwrap();
        assert_eq!((moved, stay), (0, 1));
        let db = crate::store::db(&st.data_dir);
        assert!(db.kv_get_raw(MIGRATION_MARKER).is_some());
        assert!(db.kv_get_raw(MIGRATION_BACKUP_KEY).is_none(), "零迁移不产生备份");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    /// 上游取号：buddy-ai 池 + token store → WbSyncAccount（global_region 恒 true、
    /// domain 缺省回落 www.workbuddy.ai、无凭证账号跳过）
    #[test]
    fn buddy_ai_upstream_accounts_synthesizes_from_pool_and_tokens() {
        let st = tmp_state("up");
        {
            let pool = WbPool { accounts: vec![
                WorkBuddyAccount { id: "wb-a1".into(), nickname: "甲".into(), ..Default::default() },
                acct("wb-a2"),
            ] };
            let v = serde_json::to_value(&pool).unwrap();
            crate::store::docs::buddy_ai_pool_save(&crate::store::db(&st.data_dir), &v).unwrap();
        }
        let db = crate::store::db(&st.data_dir);
        // a1 有凭证（无 domain → 缺省回落），a2 无凭证跳过
        db.row_upsert(crate::tasks::wb_common::BUDDY_AI_TOKEN_TABLE, "wb-a1",
            &json!({"access_token": "", "domain": ""})).unwrap();
        // vault 无值 → secure 读回填为空 → a1 也被跳过（无凭证不入池）
        let out = buddy_ai_upstream_accounts(&st);
        assert!(out.is_empty(), "vault 无明文凭证时不得入池（fail-secure）");
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }

    /// intl_domain_or：缺省/非法回落 www.workbuddy.ai；合法国际域名原样保留
    #[test]
    fn intl_domain_or_fallback() {
        assert_eq!(intl_domain_or(None), INTL_DOMAIN);
        assert_eq!(intl_domain_or(Some(String::new())), INTL_DOMAIN);
        assert_eq!(intl_domain_or(Some("copilot.tencent.com".into())), INTL_DOMAIN);
        assert_eq!(intl_domain_or(Some("www.workbuddy.ai".into())), "www.workbuddy.ai");
    }
}
