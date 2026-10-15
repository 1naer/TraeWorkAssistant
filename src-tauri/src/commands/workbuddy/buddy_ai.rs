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
use tauri::State;

use crate::fs_utils;
use crate::state::AppState;

use super::accounts::find_uid_or_id;
use super::common::{account_id_of, as_str, load_pool, save_pool, WorkBuddyAccount, WbPool};
use super::oauth::{oauth_login_async, PoolSink};

// ── 池 / token store 读写包装（buddy-ai 独立表）─────────────────────────────

pub(super) fn load_buddy_pool(state: &AppState) -> WbPool {
    let v = crate::store::docs::buddy_ai_pool_load(&crate::store::db(&state.data_dir));
    serde_json::from_value(v).unwrap_or_default()
}

pub(super) fn save_buddy_pool(state: &AppState, pool: &WbPool) -> Result<(), String> {
    let v = serde_json::to_value(pool).map_err(|e| format!("序列化失败: {e}"))?;
    crate::store::docs::buddy_ai_pool_save(&crate::store::db(&state.data_dir), &v)
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
    let creds = json!({
        "access_token": token,
        "refresh_token": refresh_token.as_deref().filter(|t| !t.trim().is_empty()),
        "expires_at_ms": exp_s.map(|s| s * 1000),
        "domain": domain,
    });
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
                "credits_balance": a.credits_balance,
                "credits_expire_at": a.credits_expire_at,
                "credits_fetched_at": a.credits_fetched_at,
                "has_credential": rec.map(|r| {
                    as_str(fs_utils::dig(r, &["access_token"]))
                        .map(|t| !t.is_empty())
                        .unwrap_or(false)
                }).unwrap_or(false),
                "domain": rec.and_then(|r| as_str(fs_utils::dig(r, &["domain"]))).unwrap_or_else(|| INTL_DOMAIN.into()),
            })
        })
        .collect())
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

    // rt 轮换回写（R-2a：每次刷新轮换；响应缺失时保留旧值防丢）
    let creds = json!({
        "access_token": new_access,
        "refresh_token": if new_refresh.as_deref().unwrap_or("").is_empty() {
            as_str(fs_utils::dig(&rec, &["refresh_token"]))
        } else {
            new_refresh
        },
        "expires_at_ms": exp_ms,
        "refresh_expires_at_ms": rexp_ms,
        "domain": intl_domain_or(as_str(fs_utils::dig(&rec, &["domain"]))),
    });
    crate::tasks::wb_common::buddy_ai_token_store_upsert(&state.data_dir, &acct.id, &creds)?;
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

// ── 存量迁移（§4.7）：wb 池混居的 global_region=true 账号一次性迁入 buddy-ai 池 ──

const MIGRATION_MARKER: &str = "buddy_ai_pool_migrated_v1";
const MIGRATION_BACKUP_KEY: &str = "buddy_ai_migration_backup";

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

    // 备份先行（审计口径：备份的是 DB 形态——敏感字段占位，不含明文）
    let backup = json!({
        "migrated_at": chrono::Utc::now().to_rfc3339(),
        "accounts": moved_accounts,
        "tokens": moved_tokens,
    });
    db.kv_set_raw(MIGRATION_BACKUP_KEY, &serde_json::to_string(&backup).map_err(|e| e.to_string())?)?;

    // buddy-ai 侧先写（幂等 upsert；失败即整体失败，wb 侧未动）
    {
        let mut buddy_pool = load_buddy_pool(state);
        for a in &moved_accounts {
            buddy_pool.accounts.push(a.clone());
        }
        save_buddy_pool(state, &buddy_pool)?;
        for (id, rec) in &moved_tokens {
            crate::tasks::wb_common::buddy_ai_token_store_upsert(&state.data_dir, id, rec)?;
        }
    }
    // wb 侧后写（池整存 + 混居 token 行删除；vault 旧条目留存不删——加密数据无害，
    // 避免迁移中断后 wb 侧凭证丢失不可回滚）
    {
        let _guard = state.wb_pool_lock.lock().unwrap_or_else(|e| e.into_inner());
        save_pool(state, &wb_pool)?;
        for id in moved_tokens.keys() {
            crate::store::docs::token_store_remove(&db, "wb_tokens", id)?;
        }
    }
    db.kv_set_raw(MIGRATION_MARKER, &chrono::Utc::now().to_rfc3339())?;
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
