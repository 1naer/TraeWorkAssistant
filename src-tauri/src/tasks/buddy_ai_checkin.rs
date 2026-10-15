//! Buddy 国际版每日活跃打卡（buddy-ai 阶段 3b，§4.5 补篇）。
//!
//! 与国内 wb_checkin 的本质差异（不复用/不污染国内骨架）：
//! - 国际版无 daily-checkin 接口，取而代之是「网页会话 + 沙箱 ACP 跑完一轮对话」
//!   复合动作（R-4 全链实测：completed 仅 3 秒）；
//! - **无 claim 端点**：奖励由服务端在会话 completed 后自动入账（30/50 两档服务端
//!   按套餐决定），客户端仅保证「跑完的 agent 会话」成立即得分；
//! - 桌面腿 chat/completions **不计入**活跃，网页腿（console 会话）才是计数通道；
//! - 网页腿身份 = 复用账号 token + `X-User-Id` + Chrome UA + Origin/Referer，
//!   **不带桌面 X-IDE-\* 指纹头**（UID 派生指纹仅桌面腿用，本任务无桌面腿）。
//!
//! 端点链（全走 `www.workbuddy.ai`，§4.5 补篇 R-4 实测收口）：
//! ① POST /console/as/conversations/（建会话 → data.id）
//! ② GET  /console/as/conversations/{id}/session（沙箱 link + 独立 token + sessionId）
//! ③ GET  <link>（Accept: text/event-stream → 响应头 Acp-Connection-Id）
//! ④ POST <link>（JSON-RPC：initialize → session/load → session/set_model → session/prompt；
//!    HTTP 202 即受理）——**set_model 必发**（省钱红线：缺省按 Auto 模型计费扣积分，
//!    免费模型钉 deepseek-v4.1-flash；外部项目踩坑实证）
//! ⑤ GET  /console/as/conversations/{id}（data.status == "completed"，超时 120s）
//! ⑥ POST /v2/billing/meter/get-user-resource（TotalDosage 对比打卡前快照，R-6 同构）

use serde_json::{json, Value};

use crate::state::AppState;

/// 打卡跑轮免费模型（§4.5 补篇省钱红线：set_model 必发钉免费档）
pub const FREE_MODEL: &str = "deepseek-v4.1-flash";
/// 建会话 prompt（外部项目同款最小一轮）
const PROMPT_TEXT: &str = "Hi";
/// ⑤ 完成判定轮询超时（可配口径默认 120s）+ 轮询间隔
const COMPLETE_TIMEOUT_SECS: u64 = 120;
const COMPLETE_POLL_SECS: u64 = 3;
/// 出口级瞬时抖动退避：1s 起翻倍封顶 15s，每步最多 3 次重试
const STEP_RETRIES: u32 = 3;

/// 秒级退避（§4.5 落码要点：1s 起翻倍封顶 15s，避免一次抖动熔断整池）
fn backoff_sleep(attempt: u32) {
    let secs = 1u64.saturating_mul(1 << attempt.min(4)).min(15);
    std::thread::sleep(std::time::Duration::from_secs(secs));
}

/// 本地日期幂等戳（YYYY-MM-DD；与调度器 last_run_date 同口径）
pub fn today_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

// ── 积分快照（R-6 字段链：TotalDosage 即总积分口径）─────────────────────────

/// dig 候选穿透包装（fs_utils::dig 返回 Option<&Value>，本模块统一借用法）
fn digv<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    crate::fs_utils::dig(v, path)
}

/// 拉取单账号积分快照：POST {base}/v2/billing/meter/get-user-resource。
/// 返回 (TotalDosage, 最早未来 ExpiredTime 秒)；解析失败恒 None（调用方容错）。
pub fn fetch_total_dosage(
    agent: &ureq::Agent,
    base: &str,
    token: &str,
    uid: &str,
) -> Option<(f64, Option<i64>)> {
    let url = format!("{base}/v2/billing/meter/get-user-resource");
    let resp = agent
        .post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("X-User-Id", uid)
        .set("X-Client-Platform", "web")
        .set("Content-Type", "application/json")
        .send_string("{}")
        .ok()?;
    let v: Value = resp.into_json().ok()?;
    // R-6 实测嵌套：{data: {Response: {Data: {TotalDosage, Accounts[...]}}}}。
    // ⚠️ dig 的信封穿透表 ENVELOPE_KEYS 全小写，"Response"/"Data" 大写不命中——
    // 固定层级用 fs_utils::path 严格下钻，回退 dig 平铺形态（兼容旧版）
    let data = digv(&v, &["data"]);
    let core = data
        .and_then(|d| crate::fs_utils::path(d, &["Response", "Data"]))
        .or(data);
    let dosage = core
        .and_then(|c| dig_f64(c, "TotalDosage"))
        .or_else(|| dig_f64(&v, "TotalDosage"))?;
    // 最早未来到期（秒级时间戳或毫秒，容错归一到秒）
    let expire = core
        .map(|c| dig_all(c, "ExpiredTime"))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|t| {
            let t = t.as_f64()?;
            // >1e12 视为毫秒
            let secs = if t > 1e12 { t / 1000.0 } else { t };
            let now = chrono::Utc::now().timestamp() as f64;
            (secs > now).then_some(secs as i64)
        })
        .min();
    Some((dosage, expire))
}

/// dig 单键 f64（数值或数字字符串兜底）
fn dig_f64(v: &Value, key: &str) -> Option<f64> {
    let x = digv(v, &[key])?;
    x.as_f64().or_else(|| x.as_str()?.parse().ok())
}

/// 全树收集同名标量（限深 8；Accounts[] 多条 ExpiredTime 用）
fn dig_all(v: &Value, key: &str) -> Vec<Value> {
    let mut out = Vec::new();
    fn walk(v: &Value, key: &str, depth: u32, out: &mut Vec<Value>) {
        if depth > 8 {
            return;
        }
        match v {
            Value::Object(m) => {
                if let Some(x) = m.get(key) {
                    if !x.is_null() && !x.is_object() && !x.is_array() {
                        out.push(x.clone());
                    }
                }
                for x in m.values() {
                    walk(x, key, depth + 1, out);
                }
            }
            Value::Array(a) => {
                for x in a {
                    walk(x, key, depth + 1, out);
                }
            }
            _ => {}
        }
    }
    walk(v, key, 0, &mut out);
    out
}

// ── ACP 六步链 ──────────────────────────────────────────────────────────────

/// 网页腿公共头（§4.5：Bearer 账号 token + X-User-Id + Chrome UA + Origin/Referer，
/// 不带 X-IDE-* 指纹头）
fn web_headers<'a>(
    req: ureq::Request,
    token: &str,
    uid: &str,
) -> ureq::Request {
    const CHROME_UA: &str =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    req.set("Authorization", &format!("Bearer {token}"))
        .set("X-User-Id", uid)
        .set("User-Agent", CHROME_UA)
        .set("Origin", "https://www.workbuddy.ai")
        .set("Referer", "https://www.workbuddy.ai/")
        .set("Accept", "application/json, text/plain, */*")
}

/// 退避重试的错误分类：HTTP 状态码（区分 4xx 语义失败 / 5xx 瞬时抖动）与消息
enum BackoffErr {
    Status(u16),
    Msg(String),
}

impl From<ureq::Error> for BackoffErr {
    fn from(e: ureq::Error) -> Self {
        match e {
            ureq::Error::Status(code, _) => BackoffErr::Status(code),
            other => BackoffErr::Msg(other.to_string()),
        }
    }
}

/// 带秒级退避的请求执行：4xx 语义性失败不重试直返；网络类 Err 与 5xx 重试
/// STEP_RETRIES 次（1s 起翻倍封顶 15s，§4.5：避免一次抖动熔断整池）
fn with_backoff<T>(mut f: impl FnMut() -> Result<T, BackoffErr>) -> Result<T, String> {
    let mut last = String::new();
    for attempt in 0..STEP_RETRIES {
        match f() {
            Ok(v) => return Ok(v),
            Err(BackoffErr::Status(code)) => {
                last = format!("HTTP {code}");
                if code < 500 {
                    return Err(last);
                }
            }
            Err(BackoffErr::Msg(m)) => last = m,
        }
        if attempt + 1 < STEP_RETRIES {
            backoff_sleep(attempt);
        }
    }
    Err(last)
}

/// 单账号打卡结果事件（NDJSON 契约对齐 wb-checkin：index 由整轮填充）
fn result_ev(id: &str, name: &str, status: &str, message: &str) -> Value {
    json!({ "id": id, "name": name, "status": status, "message": message })
}

/// 单账号打卡全链（§4.5 补篇 ①-⑥）。返回事件；幂等戳成功才落盘（不成功不记打卡）。
#[allow(clippy::too_many_lines)]
fn process_account(
    state: &AppState,
    agent: &ureq::Agent,
    acct_id: &str,
    nickname: &str,
    token: &str,
    uid: &str,
) -> Value {
    let base = "https://www.workbuddy.ai";
    let fail = |m: String| result_ev(acct_id, nickname, "fail", &m);

    // 幂等戳：token rec `last_daily_chat`（本地日期；成功才落盘）
    let store = crate::tasks::wb_common::buddy_ai_token_store_load(&state.data_dir);
    let rec = store
        .get("tokens")
        .and_then(|t| t.get(acct_id))
        .cloned()
        .unwrap_or_default();
    let last = rec.get("last_daily_chat").and_then(Value::as_str).unwrap_or("");
    if last == today_stamp() {
        return result_ev(acct_id, nickname, "already", "今日已完成活跃打卡");
    }

    // ⑥ 前置：打卡前积分快照（失败不阻塞打卡——到账校验是加分项不是门槛）
    let before = fetch_total_dosage(agent, base, token, uid);

    // ① 建会话
    let body = json!({
        "prompt": PROMPT_TEXT,
        "model": FREE_MODEL,
        "conversationOrigin": "workbuddy-app",
        "plugins": [{ "name": "weixinpay", "marketplace": "codebuddy-builtin" }],
    });
    let conv_id = with_backoff(|| {
        let resp = web_headers(agent.post(&format!("{base}/console/as/conversations/")), token, uid)
            .set("Content-Type", "application/json")
            .send_string(&body.to_string())?;
        let v: Value = resp.into_json().map_err(|e| BackoffErr::Msg(e.to_string()))?;
        crate::fs_utils::dig(&v, &["data", "id"])
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| BackoffErr::Msg(format!("建会话响应无 data.id：{}", trim_json(&v))))
    });
    let conv_id = match conv_id {
        Ok(v) => v,
        Err(e) => return fail(format!("建会话失败：{e}")),
    };

    // ② 取沙箱（link + 独立 token + sessionId）
    let sess = with_backoff(|| {
        let resp = web_headers(
            agent.get(&format!("{base}/console/as/conversations/{conv_id}/session")),
            token,
            uid,
        )
        .call()?;
        let v: Value = resp.into_json().map_err(|e| BackoffErr::Msg(e.to_string()))?;
        let d = v.get("data").cloned().unwrap_or(v.clone());
        let link = d.get("link").and_then(Value::as_str).map(|s| s.to_string());
        let stoken = d
            .get("token")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        let sid = d
            .get("sessionId")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        match (link, stoken, sid) {
            (Some(l), Some(t), Some(s)) => Ok((l, t, s)),
            _ => Err(BackoffErr::Msg(format!("取沙箱响应缺字段：{}", trim_json(&v)))),
        }
    });
    let (link, sandbox_token, session_id) = match sess {
        Ok(v) => v,
        Err(e) => return fail(format!("取沙箱失败：{e}")),
    };

    // ③ ACP 通道：GET link（SSE）→ 响应头 Acp-Connection-Id
    let conn_id = with_backoff(|| {
        let resp = ureq::get(&link)
            .set("Accept", "text/event-stream")
            .set("Authorization", &format!("Bearer {sandbox_token}"))
            .set("User-Agent", "Mozilla/5.0")
            .call()?;
        resp.header("Acp-Connection-Id")
            .map(|s| s.to_string())
            .ok_or_else(|| BackoffErr::Msg("ACP 响应缺 Acp-Connection-Id".to_string()))
    });
    let conn_id = match conn_id {
        Ok(v) => v,
        Err(e) => return fail(format!("ACP 通道建立失败：{e}")),
    };

    // ④ ACP JSON-RPC 四连（HTTP 202/200 即受理；set_model 必发——省钱红线）。
    // payload 形态按 ACP 规范 + workbuddy2api-hub run_turn 口径构造；R-4 实测全 202。
    let rpc = |id: u32, method: &str, params: Value| {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    };
    let steps: [(u32, &str, Value); 4] = [
        (
            1,
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
            }),
        ),
        (
            2,
            "session/load",
            json!({ "sessionId": session_id, "cwd": "/", "mcpServers": [] }),
        ),
        (
            3,
            "session/set_model",
            json!({ "sessionId": session_id, "modelId": FREE_MODEL }),
        ),
        (
            4,
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": PROMPT_TEXT }] }),
        ),
    ];
    for (rid, method, params) in steps {
        let payload = rpc(rid, method, params);
        let res = with_backoff(|| {
            let resp = ureq::post(&link)
                .set("Acp-Connection-Id", &conn_id)
                .set("Authorization", &format!("Bearer {sandbox_token}"))
                .set("Content-Type", "application/json")
                .set("User-Agent", "Mozilla/5.0")
                .send_string(&payload.to_string())?;
            // 202 = 受理（SSE 异步回 session/update）；200 兼容同步响应形态
            Ok(u32::from(resp.status()))
        });
        if let Err(e) = res {
            return fail(format!("ACP {method} 失败：{e}"));
        }
    }

    // ⑤ 完成判定轮询（data.status == "completed"，120s 超时）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(COMPLETE_TIMEOUT_SECS);
    let mut completed = false;
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_secs(COMPLETE_POLL_SECS));
        let status = with_backoff(|| {
            let resp = web_headers(
                agent.get(&format!("{base}/console/as/conversations/{conv_id}")),
                token,
                uid,
            )
            .call()?;
            let v: Value = resp.into_json().map_err(|e| BackoffErr::Msg(e.to_string()))?;
            Ok(v.get("data")
                .and_then(|d| d.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string())
        });
        match status {
            Ok(s) if s == "completed" => {
                completed = true;
                break;
            }
            Ok(s) if s == "failed" || s == "error" => break,
            _ => continue,
        }
    }
    if !completed {
        return fail(format!("会话未在 {COMPLETE_TIMEOUT_SECS}s 内完成（conv={conv_id}）"));
    }

    // ⑥ 到账校验 + 幂等戳落盘 + 池快照回写（成功才落盘，§4.5：不成功不记打卡）
    let after = fetch_total_dosage(agent, base, token, uid);
    let gain = match (before, after) {
        (Some((b, _)), Some((a, _))) if a > b => Some(a - b),
        _ => None,
    };
    // 幂等戳：token rec 增量更新（敏感字段经 secure upsert 保持占位口径——
    // upsert 会对敏感字段重新 vault 回填/占位，last_daily_chat 明文字段直存）
    let mut new_rec = rec.clone();
    new_rec["last_daily_chat"] = json!(today_stamp());
    if let Err(e) = crate::tasks::wb_common::buddy_ai_token_store_upsert(&state.data_dir, acct_id, &new_rec) {
        return fail(format!("打卡幂等戳落盘失败（记为未完成防假打卡）：{e}"));
    }
    // 池快照回写（after 口径；before/after 不可用时跳过不阻塞成功语义）
    if let Some((total, expire)) = after {
        if let Err(err) = crate::commands::workbuddy::buddy_pool_write_credits(state, acct_id, total, expire) {
            crate::fs_utils::app_log(&state.data_dir, &format!("buddy-ai: 打卡积分回写失败 {acct_id}: {err}"));
        }
    }
    let msg = match gain {
        Some(g) => format!("活跃打卡完成，积分 +{g:.0}（{:.0} → {:.0}）",
            before.map(|(b, _)| b).unwrap_or(0.0), after.map(|(a, _)| a).unwrap_or(0.0)),
        None => "活跃打卡完成（会话 completed，奖励自动入账）".to_string(),
    };
    let mut ev = result_ev(acct_id, nickname, "success", &msg);
    // P2：积分增量随事件落盘（打卡结果表 reward 列，趋势/日历展示用）
    if let Some(g) = gain {
        ev["reward"] = json!(g);
    }
    ev
}

/// 失败诊断用的响应摘要（审查 H5/H6 修复）：
/// ① 先脱敏——响应可能携带沙箱凭证（② 步的 token/link 等），原样序列化会经
///    NDJSON 进度事件广播 + app_log 明文落盘（长期存储泄漏面）；
/// ② 再截断——serde_json 输出 UTF-8 原文，按字节切片遇非 ASCII（中文错误文案）
///    不是字符边界会 panic 且 panic 沿 process_account 展开杀掉整轮打卡线程
fn trim_json(v: &Value) -> String {
    const SENSITIVE_KEYS: [&str; 7] = [
        "token",
        "access_token",
        "accessToken",
        "refresh_token",
        "refreshToken",
        "authorization",
        "link",
    ];
    let mut redacted = v.clone();
    redact_sensitive(redacted.as_object_mut(), &SENSITIVE_KEYS);
    let s = redacted.to_string();
    if s.len() <= 200 {
        return s;
    }
    let mut end = 200;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// 递归脱敏：命中敏感键（大小写不敏感）的值置为 "***"
fn redact_sensitive(obj: Option<&mut serde_json::Map<String, Value>>, keys: &[&str]) {
    let Some(obj) = obj else { return };
    for (k, val) in obj.iter_mut() {
        if keys.iter().any(|s| k.eq_ignore_ascii_case(s)) {
            *val = Value::String("***".into());
        } else {
            match val {
                Value::Object(_) => redact_sensitive(val.as_object_mut(), keys),
                Value::Array(a) => {
                    for x in a.iter_mut() {
                        redact_sensitive(x.as_object_mut(), keys);
                    }
                }
                _ => {}
            }
        }
    }
}

/// 打卡整轮：buddy-ai 池全账号串行（NDJSON 管线复用 wb-checkin 契约）。
/// 返回 done 事件（ok/already/failed 计数），供调度器/启动钩子直接消费。
pub fn run_checkin_round(state: &AppState, emit: &mut dyn FnMut(&Value)) -> Value {
    let agent = crate::tasks::http_agent(30);
    // 花名册经 buddy_ai.rs 公开 helper（WbPool 字段不对 tasks 暴露）；
    // 仅含凭证账号参与（无凭证跳过——手工导入无 rt 也打不了卡）
    let store = crate::tasks::wb_common::buddy_ai_token_store_load(&state.data_dir);
    let tokens = store.get("tokens").and_then(Value::as_object).cloned().unwrap_or_default();
    let roster = crate::commands::workbuddy::buddy_pool_roster(state);
    let accounts: Vec<(String, String, String)> = roster
        .into_iter()
        .filter(|(id, _, _)| {
            tokens
                .get(id)
                .and_then(|r| r.get("access_token"))
                .and_then(Value::as_str)
                .map(|t| !t.is_empty())
                .unwrap_or(false)
        })
        .collect();
    emit(&json!({ "type": "start", "total": accounts.len() }));

    let gap_secs = crate::models::effective_checkin_gap(state.settings().buddy_ai_checkin_gap_secs);
    let mut events: Vec<Value> = Vec::new();
    for (i, (id, name, pool_uid)) in accounts.iter().enumerate() {
        if i > 0 && gap_secs > 0 {
            std::thread::sleep(std::time::Duration::from_secs(gap_secs));
        }
        // 单账号失败不中断整轮；凭证在锁外读（secure 回填），网络链全程无池锁
        let rec = tokens.get(id).cloned().unwrap_or_default();
        let token = rec.get("access_token").and_then(Value::as_str).unwrap_or("").to_string();
        // X-User-Id：池 uid 优先（OAuth/导入时落库），token rec uid 兜底
        let uid = if pool_uid.is_empty() {
            rec.get("uid").and_then(Value::as_str).unwrap_or("").to_string()
        } else {
            pool_uid.clone()
        };
        let mut ev = process_account(state, &agent, id, name, &token, &uid);
        ev["index"] = json!(i + 1);
        emit(&ev);
        events.push(ev);
    }

    let ok = events.iter().filter(|e| e["status"] == "success").count();
    let already = events.iter().filter(|e| e["status"] == "already").count();
    let failed = events.len() - ok - already;

    // P2：打卡结果按日落库（镜像 wb_checkin_results，90 天裁剪；同 uid 同日以
    // 最后一次为准——重试轮自然合并为最终态）。落库失败仅日志，不影响打卡结果
    {
        let now = chrono::Local::now();
        let date = now.format("%Y-%m-%d").to_string();
        let time = now.format("%H:%M:%S").to_string();
        let db = crate::store::db(&state.data_dir);
        let mut root = crate::store::docs::buddy_ai_checkin_results_load(&db);
        let mut merged = root
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // 本轮涉及账号的当日旧行移除（最终态覆盖）
        merged.retain(|r| {
            !(r.get("date").and_then(Value::as_str) == Some(date.as_str())
                && events
                    .iter()
                    .any(|e| e.get("id").and_then(Value::as_str) == r.get("user_id").and_then(Value::as_str)))
        });
        for e in &events {
            merged.push(json!({
                "date": date,
                "time": time,
                "user_id": e.get("id").cloned().unwrap_or_default(),
                "name": e.get("name").cloned().unwrap_or_default(),
                "status": e.get("status").cloned().unwrap_or_default(),
                "message": e.get("message").cloned().unwrap_or_default(),
                "reward": e.get("reward").cloned().unwrap_or(Value::Null),
            }));
        }
        // 90 天裁剪
        let cutoff = (now.date_naive() - chrono::Duration::days(90))
            .format("%Y-%m-%d")
            .to_string();
        merged.retain(|r| {
            r.get("date")
                .and_then(Value::as_str)
                .map_or(true, |d| d >= cutoff.as_str())
        });
        root["results"] = Value::Array(merged);
        if let Err(err) = crate::store::docs::buddy_ai_checkin_results_save(&db, &root) {
            crate::fs_utils::app_log(&state.data_dir, &format!("buddy-ai: 打卡结果落库失败: {err}"));
        }
    }

    let done = json!({ "type": "done", "ok": ok, "already": already, "failed": failed });
    emit(&done);
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 退避序列：1s→2s→4s…封顶 15s（纯计算不 sleep 的口径单测）
    #[test]
    fn backoff_caps_at_15s() {
        let secs = |a: u32| 1u64.saturating_mul(1 << a.min(4)).min(15);
        assert_eq!((secs(0), secs(1), secs(2), secs(3), secs(4), secs(5)), (1, 2, 4, 8, 15, 15));
    }

    /// 幂等戳日期口径：YYYY-MM-DD
    #[test]
    fn today_stamp_format() {
        let s = today_stamp();
        assert_eq!(s.len(), 10);
        assert_eq!(s.as_bytes()[4], b'-');
        assert_eq!(s.as_bytes()[7], b'-');
    }

    /// TotalDosage 解析：R-6 嵌套形态 data.Response.Data + 毫秒 ExpiredTime 归一
    #[test]
    fn parse_total_dosage_shapes() {
        let v = json!({
            "code": 0,
            "data": { "Response": { "Data": {
                "TotalDosage": 350,
                "Accounts": [ { "ExpiredTime": 1800000000000i64 }, { "ExpiredTime": 1790000000000i64 } ],
            } } }
        });
        let data = crate::fs_utils::dig(&v, &["data"]).expect("data 嵌套存在");
        // 与 fetch_total_dosage 实现一致：Response/Data 大写键不走 dig 信封表（全小写），
        // 用 path 严格下钻
        let core = crate::fs_utils::path(data, &["Response", "Data"]).expect("Response.Data 存在");
        let dosage = dig_f64(core, "TotalDosage");
        assert_eq!(dosage, Some(350.0));
        let expire = dig_all(core, "ExpiredTime")
            .into_iter()
            .filter_map(|t| t.as_f64())
            .map(|t| if t > 1e12 { t / 1000.0 } else { t })
            .min_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(expire, Some(1_790_000_000.0));
    }

    /// with_backoff：4xx 不重试直返、Ok 直返
    #[test]
    fn backoff_policy() {
        let mut calls = 0u32;
        let r: Result<u32, String> = with_backoff(|| {
            calls += 1;
            Err::<u32, _>(BackoffErr::Status(400))
        });
        assert!(r.is_err());
        assert_eq!(calls, 1, "4xx 语义性失败不重试");

        let mut calls2 = 0u32;
        let r2: Result<u32, String> = with_backoff(|| {
            calls2 += 1;
            Ok(42)
        });
        assert_eq!((r2.unwrap(), calls2), (42, 1));
    }
}
