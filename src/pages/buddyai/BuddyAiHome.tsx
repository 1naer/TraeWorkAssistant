import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RefreshCw,
  Globe,
  LogIn,
  KeyRound,
  Trash2,
  Loader2,
  Coins,
  Info,
  RotateCcw,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { Badge, EmptyState, Modal, Spinner } from '../../components/ui';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import { withMinDelay } from '../../lib/delay';
import type { BuddyAiAccountView, WbModelInfo, WbOauthDone, WbOauthProgress } from '../../types';

/**
 * BuddyAI（buddy-ai 国际版）账号管理页（阶段 3 分区 UI 收尾）。
 *
 * 《Buddy国际版支持落地方案.md》§3.4 隔离清单：本页所有命令走 buddy_ai_* 独立池
 * （buddy_ai_accounts / buddy_ai_tokens 表 + buddy-ai vault 命名空间），
 * 与国内 Buddy 账号页零数据共享；OAuth 事件前缀 buddy-ai-oauth-*（不与 wb-oauth 混流）。
 *
 * 页面能力（阶段 3a）：账号列表 / OAuth 扫码登录 / 手工导入凭证（区域必选校验）/
 * 凭证续期 / 移除（确认弹框）/ 静态模型目录（§4.4 首版配置）。
 * 每日活跃打卡（ACP 六步链，阶段 3b）与积分同步 Intl 化随后续阶段接入。
 */

type ConfirmTarget = { kind: 'remove-account'; account: BuddyAiAccountView } | null;

export default function BuddyAiHome() {
  const pushToast = useAppStore((s) => s.pushToast);
  const [accounts, setAccounts] = useState<BuddyAiAccountView[] | null>(null);
  const [catalog, setCatalog] = useState<WbModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowOp, setRowOp] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [oauthStage, setOauthStage] = useState('');
  const [oauthMessage, setOauthMessage] = useState('');
  const [oauthAuthUrl, setOauthAuthUrl] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  // 手工导入弹框（access_token 必填 / refresh_token 可选 / 备注名可选）
  const [importOpen, setImportOpen] = useState(false);
  const [importName, setImportName] = useState('');
  const [importAccess, setImportAccess] = useState('');
  const [importRefresh, setImportRefresh] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const importAccessRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [accs, cat] = await Promise.all([
        api.buddyai.accountsList(),
        api.apiServer.buddyAiCatalogList().catch(() => [] as WbModelInfo[]),
      ]);
      setAccounts(accs);
      setCatalog(cat);
    } catch (err) {
      pushToast('error', `账号列表读取失败：${String(err).slice(0, 120)}`);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // OAuth 弹框事件契约：与 BuddyAccounts wb-oauth 模式同构，事件前缀 buddy-ai-oauth-*
  // （后端 oauth_login_async 按 PoolSink 分流；310s 看门狗兜底事件丢失）
  useEffect(() => {
    if (!oauthOpen && !oauthBusy) return;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const unProgress = listen<WbOauthProgress>('buddy-ai-oauth-progress', (e) => {
      setOauthStage(e.payload.stage ?? '');
      setOauthMessage(e.payload.message ?? '');
      if (e.payload.auth_url) setOauthAuthUrl(e.payload.auth_url);
    });
    const unDone = listen<WbOauthDone>('buddy-ai-oauth-done', (e) => {
      setOauthBusy(false);
      if (e.payload.ok) {
        pushToast('success', e.payload.message || '国际账号已扫码登录并自动入池');
        void refresh();
        setTimeout(() => setOauthOpen(false), 1200);
      } else {
        setOauthMessage(e.payload.message || '登录失败');
        pushToast('error', e.payload.message || '登录失败');
      }
    });
    watchdog = setTimeout(() => {
      setOauthBusy(false);
      setOauthMessage('登录超时（超过 310 秒无响应），请重试');
    }, 310_000);
    return () => {
      void unProgress.then((f) => f());
      void unDone.then((f) => f());
      if (watchdog) clearTimeout(watchdog);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthOpen, oauthBusy]);

  const startOauth = async () => {
    if (oauthBusy) return;
    setOauthOpen(true);
    setOauthStage('init');
    setOauthMessage('正在请求登录 state…');
    setOauthAuthUrl(null);
    setOauthBusy(true);
    try {
      await api.buddyai.oauthLogin();
    } catch (err) {
      setOauthBusy(false);
      setOauthMessage(String(err));
      pushToast('error', `发起登录失败：${String(err).slice(0, 120)}`);
    }
  };

  const openImport = () => {
    setImportName('');
    setImportAccess('');
    setImportRefresh('');
    setImportOpen(true);
    setTimeout(() => importAccessRef.current?.focus(), 50);
  };

  const confirmImport = async () => {
    const token = importAccess.trim();
    if (!token) {
      pushToast('error', 'access_token 不能为空');
      return;
    }
    setImportBusy(true);
    try {
      const r = await withMinDelay(
        api.buddyai.accountImportCreds(importName.trim() || undefined, token, importRefresh.trim() || undefined),
        600,
      );
      pushToast('success', `凭证已导入并入池（${r.id}，域 ${r.domain}）`);
      setImportOpen(false);
      await refresh();
    } catch (err) {
      // 区域校验失败等业务错误原样透出（§4.1 双重保险）
      pushToast('error', `导入失败：${String(err).slice(0, 160)}`);
    } finally {
      setImportBusy(false);
    }
  };

  const doRenew = async (a: BuddyAiAccountView) => {
    setRowOp(`renew:${a.id}`);
    try {
      const msg = await withMinDelay(api.buddyai.refreshToken(a.id), 800);
      pushToast('success', `${a.nickname || a.id}：${msg}`);
      await refresh();
    } catch (err) {
      // Intl 刷新失败按暂态处理（后端不标 needs_relogin），提示重新导入通道
      pushToast('error', `续期失败：${String(err).slice(0, 160)}`);
    } finally {
      setRowOp(null);
    }
  };

  const doRemove = async () => {
    if (!confirmTarget) return;
    setConfirmBusy(true);
    try {
      await withMinDelay(api.buddyai.accountRemove(confirmTarget.account.id), 800);
      pushToast('info', `已移除 ${confirmTarget.account.nickname || confirmTarget.account.id}`);
      setConfirmTarget(null);
      await refresh();
    } catch (err) {
      pushToast('error', `移除失败：${String(err).slice(0, 120)}`);
    } finally {
      setConfirmBusy(false);
    }
  };

  const expText = (ts: number | null) =>
    ts ? new Date(ts * 1000).toLocaleString() : '-';

  return (
    <div className="mx-auto max-w-5xl pt-6">
      <BuddyAiCheckinCard onChanged={refresh} />

      {/* 页头：标题 + 操作（登录 / 导入 / 刷新） */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow">
            <Globe size={20} />
          </div>
          <div>
            <h1 className="text-lg font-semibold">BuddyAI（国际版）账号</h1>
            <p className="text-xs text-slate-400">buddy-ai 独立池 · workbuddy.ai · 与国内 Buddy 池完全隔离</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary inline-flex items-center gap-1.5" onClick={startOauth} disabled={oauthBusy}>
            <LogIn size={14} /> 扫码登录
          </button>
          <button className="btn-secondary inline-flex items-center gap-1.5" onClick={openImport}>
            <KeyRound size={14} /> 导入凭证
          </button>
          <button className="btn-secondary inline-flex items-center gap-1.5" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Spinner /> : <RefreshCw size={14} />} 刷新
          </button>
        </div>
      </div>

      {/* 账号列表 */}
      <div className="card overflow-x-auto p-4">
        {loading && accounts === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin" /> 加载中…
          </div>
        ) : !accounts || accounts.length === 0 ? (
          <EmptyState
            icon={<Globe size={28} />}
            title="还没有国际版账号"
            hint="点击「扫码登录」走 workbuddy.ai OAuth，或「导入凭证」手工导入国际账号 token（须为 .workbuddy.ai 域）"
          />
        ) : (
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400 dark:border-zinc-800">
                <th className="py-2 pr-3 font-medium">账号</th>
                <th className="py-2 pr-3 font-medium">域名</th>
                <th className="py-2 pr-3 font-medium">token 到期</th>
                <th className="py-2 pr-3 font-medium">状态</th>
                <th className="py-2 pr-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b border-slate-50 last:border-0 dark:border-zinc-800/50">
                  <td className="py-2.5 pr-3">
                    <div className="font-medium">{a.nickname || a.id}</div>
                    <div className="text-[11px] text-slate-400">{a.uid || a.id}</div>
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-slate-500">{a.domain}</td>
                  <td className="py-2.5 pr-3 text-xs tabular-nums text-slate-500">{expText(a.access_token_expires_at)}</td>
                  <td className="py-2.5 pr-3">
                    {!a.has_credential ? (
                      <Badge tone="red">无凭证</Badge>
                    ) : a.needs_relogin ? (
                      <Badge tone="amber">需重新登录</Badge>
                    ) : (
                      <Badge tone="green">可用</Badge>
                    )}
                    {a.needs_relogin && a.relogin_reason ? (
                      <div className="mt-0.5 text-[11px] text-slate-400">{a.relogin_reason}</div>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        className="btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs"
                        title="凭证续期（refreshToken 轮换回写）"
                        disabled={rowOp !== null || !a.has_credential}
                        onClick={() => void doRenew(a)}
                      >
                        {rowOp === `renew:${a.id}` ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                        续期
                      </button>
                      <button
                        className="btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs text-red-500 hover:text-red-600"
                        title="移除账号（池条目 + 凭证 + vault 条目三清）"
                        disabled={rowOp !== null}
                        onClick={() => setConfirmTarget({ kind: 'remove-account', account: a })}
                      >
                        <Trash2 size={13} /> 移除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 模型目录（§4.4 首版静态配置） */}
      <div className="card mt-4 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Coins size={15} className="text-brand-500" />
          <span className="text-sm font-medium">国际档模型目录</span>
          <span className="text-xs text-slate-400">静态配置（§4.4）· 倍率占位 1.0 待官网核对回填</span>
        </div>
        {catalog.length === 0 ? (
          <p className="py-2 text-xs text-slate-400">目录未加载</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {catalog.map((m) => (
              <span
                key={m.id}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] dark:border-zinc-700"
                title={`倍率 ${m.rate.toFixed(2)}x（占位）`}
              >
                {m.id}
                <span className="text-slate-400">{m.rate.toFixed(2)}x</span>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card mt-4 p-4 text-xs text-slate-500 dark:text-zinc-400">
        <div className="mb-1 flex items-center gap-1.5">
          <Info size={13} /> 阶段说明
        </div>
        每日活跃打卡（官方 30/50 积分，ACP 六步链）与积分同步 Intl 化将在后续阶段接入本页；
        本应用入口默认隐藏，可在 <b>系统设置 → 应用显示</b> 中勾选「BuddyAI」开启。
      </div>

      {/* OAuth 进度弹框 */}
      <Modal
        open={oauthOpen}
        onClose={() => {
          if (!oauthBusy) setOauthOpen(false);
        }}
        title="Buddy 国际版扫码登录"
        widthClass="max-w-md"
      >
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            {oauthBusy ? <Loader2 size={15} className="animate-spin text-brand-500" /> : <Globe size={15} className="text-brand-500" />}
            <span className="font-medium">{oauthStage === 'done' ? '完成' : '进行中'}</span>
          </div>
          <p className="text-slate-500 dark:text-zinc-400">{oauthMessage}</p>
          {oauthAuthUrl ? (
            <a href={oauthAuthUrl} target="_blank" rel="noreferrer" className="btn-primary inline-flex w-full items-center justify-center gap-2">
              打开登录页（workbuddy.ai）
            </a>
          ) : null}
          <p className="text-[11px] leading-4 text-slate-400">
            登录流程：浏览器完成 workbuddy.ai 授权后，网关自动轮询拿票并国际账号入池（最长 300 秒）。
          </p>
          <div className="flex justify-end">
            <button
              className="btn-secondary"
              disabled={oauthBusy}
              onClick={() => setOauthOpen(false)}
            >
              {oauthBusy ? '运行中…' : '关闭'}
            </button>
          </div>
        </div>
      </Modal>

      {/* 手工导入弹框 */}
      <Modal open={importOpen} onClose={() => !importBusy && setImportOpen(false)} title="导入国际账号凭证" widthClass="max-w-md">
        <div className="space-y-3 text-sm">
          <div className="rounded-md bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            区域校验：本池仅接受国际账号（domain 须含 .workbuddy.ai）；国内账号请走 Buddy 页导入。
          </div>
          <div>
            <label className="label">access_token（必填）</label>
            <input
              ref={importAccessRef}
              className="input"
              value={importAccess}
              onChange={(e) => setImportAccess(e.target.value)}
              placeholder="粘贴国际账号 access_token"
            />
          </div>
          <div>
            <label className="label">refresh_token（可选，缺失则不可自动续期）</label>
            <input
              className="input"
              value={importRefresh}
              onChange={(e) => setImportRefresh(e.target.value)}
              placeholder="粘贴国际账号 refresh_token"
            />
          </div>
          <div>
            <label className="label">备注名（可选）</label>
            <input className="input" value={importName} onChange={(e) => setImportName(e.target.value)} placeholder="如：Intl-主力" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-secondary" disabled={importBusy} onClick={() => setImportOpen(false)}>
              取消
            </button>
            <button className="btn-primary inline-flex items-center gap-1.5" disabled={importBusy || !importAccess.trim()} onClick={() => void confirmImport()}>
              {importBusy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} 导入并入池
            </button>
          </div>
        </div>
      </Modal>

      {/* 移除确认弹框（删除类操作二次确认） */}
      <Modal open={confirmTarget !== null} onClose={() => !confirmBusy && setConfirmTarget(null)} title="确认移除账号" widthClass="max-w-sm">
        {confirmTarget ? (
          <div className="space-y-3 text-sm">
            <p>
              确定移除国际账号 <b>{confirmTarget.account.nickname || confirmTarget.account.id}</b>？
              将同时清除其凭证记录与 buddy-ai vault 条目，不可恢复。
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" disabled={confirmBusy} onClick={() => setConfirmTarget(null)}>
                取消
              </button>
              <button
                className="btn-primary inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-700"
                disabled={confirmBusy}
                onClick={() => void doRemove()}
              >
                {confirmBusy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} 确认移除
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

/**
 * 每日活跃打卡卡（阶段 3b）：开关/时刻/间隔配置 + 手动触发 + NDJSON 进度 + 积分同步。
 * 打卡机制见 tasks/buddy_ai_checkin.rs 模块注释（网页会话 + 沙箱 ACP，无 claim 端点）。
 */
function BuddyAiCheckinCard({ onChanged }: { onChanged: () => Promise<void> | void }) {
  const pushToast = useAppStore((s) => s.pushToast);
  const settings = useAppStore((s) => s.settings);
  const [enabled, setEnabled] = useState(false);
  const [hhmm, setHhmm] = useState('09:20');
  const [gap, setGap] = useState(3);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);

  // 设置回填（settings store 加载后一次性同步本地表单）
  useEffect(() => {
    if (settings) {
      setEnabled(settings.buddy_ai_checkin_enabled === true);
      setHhmm(settings.buddy_ai_checkin_hhmm?.trim() || '09:20');
      setGap(typeof settings.buddy_ai_checkin_gap_secs === 'number' ? settings.buddy_ai_checkin_gap_secs : 3);
    }
  }, [settings]);

  const saveConfig = async (patch: { enabled?: boolean } = {}) => {
    setSaving(true);
    try {
      await withMinDelay(
        api.misc.settingsSet({
          buddy_ai_checkin_enabled: patch.enabled ?? enabled,
          buddy_ai_checkin_hhmm: hhmm.trim() || '09:20',
          buddy_ai_checkin_gap_secs: gap,
        }),
        400,
      );
      pushToast('success', patch.enabled !== undefined
        ? (patch.enabled ? '已开启每日活跃打卡（按调度时刻自动执行）' : '已关闭每日活跃打卡')
        : '打卡配置已保存');
    } catch (err) {
      pushToast('error', `保存失败：${String(err).slice(0, 120)}`);
    } finally {
      setSaving(false);
    }
  };

  // 打卡进度事件（NDJSON 契约对齐 BuddyCheckin：payload 为序列化 JSON 字符串）
  useEffect(() => {
    if (!running) return;
    const un = listen<string>('buddy-ai-checkin-progress', (ev) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(ev.payload);
      } catch {
        return;
      }
      if (parsed.type === 'start') {
        setLines([`开始打卡（共 ${parsed.total} 个账号）…`]);
      } else if (parsed.type === 'done') {
        setLines((prev) => [
          ...prev,
          `整轮完成：成功 ${parsed.ok} / 已完成 ${parsed.already} / 失败 ${parsed.failed}`,
        ]);
      } else if (parsed.index) {
        setLines((prev) => [...prev, `#${parsed.index} ${parsed.name ?? ''}：${parsed.status ?? ''} — ${parsed.message ?? ''}`]);
      } else if (parsed.type === 'exit') {
        setRunning(false);
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [running]);

  const startCheckin = async () => {
    if (running) return;
    setRunning(true);
    setLines([]);
    try {
      await api.buddyai.checkinStart();
    } catch (err) {
      setRunning(false);
      pushToast('error', `发起打卡失败：${String(err).slice(0, 120)}`);
    }
  };

  const syncCredits = async () => {
    setSyncing(true);
    try {
      const n = await withMinDelay(api.buddyai.creditsFetch(), 800);
      pushToast('success', `积分已同步（${n.filter((a) => a.credits_balance != null).length} 个账号取数成功）`);
      await onChanged();
    } catch (err) {
      pushToast('error', `积分同步失败：${String(err).slice(0, 120)}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="card mt-4 p-4">
      <div className="mb-2 flex items-center gap-2">
        <Coins size={15} className="text-brand-500" />
        <span className="text-sm font-medium">每日活跃打卡</span>
        {enabled ? <Badge tone="green">已开启</Badge> : <Badge tone="amber">未开启</Badge>}
        <span className="text-xs text-slate-400">网页会话 + 沙箱跑一轮对话，服务端自动入账 30/50 积分</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              void saveConfig({ enabled: e.target.checked });
            }}
          />
          每日自动打卡
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          时刻
          <input
            className="w-20 rounded-md border border-slate-200 bg-transparent px-2 py-1 text-right text-xs tabular-nums focus:border-brand-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            value={hhmm}
            onChange={(e) => setHhmm(e.target.value)}
            onBlur={() => void saveConfig()}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          账号间隔
          <input
            type="number"
            min={0}
            max={600}
            className="w-16 rounded-md border border-slate-200 bg-transparent px-2 py-1 text-right text-xs tabular-nums focus:border-brand-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            value={gap}
            onChange={(e) => setGap(Number(e.target.value))}
            onBlur={() => void saveConfig()}
          />
          秒
        </label>
        <button
          className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
          disabled={running}
          onClick={() => void startCheckin()}
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />}
          {running ? '打卡中…' : '立即打卡'}
        </button>
        <button
          className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
          disabled={syncing}
          onClick={() => void syncCredits()}
        >
          {syncing ? <Loader2 size={13} className="animate-spin" /> : <Coins size={13} />} 同步积分
        </button>
      </div>
      {lines.length > 0 ? (
        <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-slate-50 px-3 py-2 font-mono text-[11px] leading-4 text-slate-500 dark:bg-zinc-800/50 dark:text-zinc-400">
          {lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
