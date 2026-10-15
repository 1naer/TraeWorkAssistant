import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Coins } from 'lucide-react';
import { StatCard } from '../../components/ui';
import PageHeader from '../../components/PageHeader';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import { withMinDelay } from '../../lib/delay';
import type { BuddyAiAccountView, UsageDayView, WbCheckinRecord } from '../../types';

/**
 * BuddyAI · 积分看板页（六页子导航对齐国内 Buddy）。
 *
 * 数据源：buddy_ai_accounts_list 池快照三键（credits_balance / credits_expire_at /
 * credits_fetched_at，由每日打卡前置快照与积分同步回写）；「同步积分」触发
 * buddy_ai_credits_fetch 全池 get-user-resource 实时取数。
 * Intl 上游无积分包明细接口，按 TotalDosage 总额展示（对齐 §4.5 积分同步口径）。
 */
export default function BuddyAiCredits() {
  const pushToast = useAppStore((s) => s.pushToast);
  const [accounts, setAccounts] = useState<BuddyAiAccountView[] | null>(null);
  const [records, setRecords] = useState<WbCheckinRecord[]>([]);
  const [usage, setUsage] = useState<UsageDayView[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accs, recs, usg] = await Promise.all([
        api.buddyai.accountsList(),
        api.buddyai.checkinResults(90).catch(() => [] as WbCheckinRecord[]),
        api.apiServer.buddyAiUsageStats(30).catch(() => [] as UsageDayView[]),
      ]);
      setAccounts(accs);
      setRecords(recs);
      setUsage(usg);
    } catch (err) {
      pushToast('error', `账号列表读取失败：${String(err).slice(0, 120)}`);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const syncCredits = async () => {
    setSyncing(true);
    try {
      const n = await withMinDelay(api.buddyai.creditsFetch(), 800);
      setAccounts(n);
      const ok = n.filter((a) => a.credits_balance != null).length;
      pushToast('success', `积分已同步（${ok}/${n.length} 个账号取数成功）`);
    } catch (err) {
      pushToast('error', `积分同步失败：${String(err).slice(0, 160)}`);
    } finally {
      setSyncing(false);
    }
  };

  const list = accounts ?? [];
  const withBalance = list.filter((a) => a.credits_balance != null);
  const total = withBalance.reduce((s, a) => s + (a.credits_balance ?? 0), 0);
  const nowSec = Math.floor(Date.now() / 1000);
  const expiredCount = withBalance.filter(
    (a) => (a.credits_expire_at ?? Infinity) <= nowSec,
  ).length;
  const neverFetched = list.length - withBalance.length;
  const localDateStr = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const today = localDateStr(new Date());
  // 打卡获得（P4 同口径：累计 / 今日）
  const totalEarned = useMemo(() => records.reduce((s, r) => s + (r.reward ?? 0), 0), [records]);
  const todayEarned = useMemo(
    () => records.filter((r) => r.date === today).reduce((s, r) => s + (r.reward ?? 0), 0),
    [records, today],
  );
  // 7 日内积分到期账号数（credits_expire_at 落在未来 7 天窗口）
  const expiringSoon = withBalance.filter((a) => {
    const e = a.credits_expire_at;
    return e != null && e > nowSec && e <= nowSec + 7 * 86400;
  }).length;
  // 模型消耗排行（P5：buddy_ai_days 桶近 30 天按模型聚合，请求次数口径——
  // intl 上游未下发按模型积分明细，诚实声明对齐 TokensTab 网关源口径）
  const modelRank = useMemo(() => {
    const m = new Map<string, { requests: number; credits: number }>();
    for (const d of usage) {
      for (const x of d.models ?? []) {
        const e = m.get(x.name) ?? { requests: 0, credits: 0 };
        e.requests += x.requests;
        e.credits += x.credits ?? 0;
        m.set(x.name, e);
      }
    }
    return [...m.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 8);
  }, [usage]);
  const rankMax = modelRank[0]?.requests ?? 0;

  const fmtExpire = (ts: number | null) =>
    ts == null ? '—' : new Date(ts * 1000).toLocaleString();
  const fmtFetched = (iso: string | null) =>
    iso == null || iso === '' ? '—' : new Date(iso).toLocaleString();

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="BuddyAI · 积分看板"
        desc="国际账号积分余额 / 到期 · 数据经 workbuddy.ai get-user-resource 实时取数"
        actions={
          <button className="btn-primary inline-flex items-center gap-1.5" onClick={() => void syncCredits()} disabled={syncing}>
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> {syncing ? '同步中…' : '同步积分'}
          </button>
        }
      />

      {/* 顶部统计卡（P5 口径对齐国内积分看板七卡的国际可用子集） */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatCard label="账号总数" value={list.length} hint={`${withBalance.length} 个已取数`} tone="brand" />
        <StatCard
          label="可用总积分"
          value={withBalance.length ? total.toFixed(2) : '—'}
          hint={neverFetched > 0 ? `${neverFetched} 个账号未取数` : '全部账号已取数'}
          tone="amber"
        />
        <StatCard
          label="平均可用积分"
          value={withBalance.length ? (total / withBalance.length).toFixed(0) : '—'}
          hint="按已取数账号平均"
          tone="green"
        />
        <StatCard label="打卡累计获得" value={totalEarned > 0 ? totalEarned.toFixed(0) : '—'} hint="近 90 天打卡积分合计" tone="green" />
        <StatCard label="今日获得" value={todayEarned > 0 ? todayEarned.toFixed(0) : '0'} hint="今日各账号打卡积分合计" tone="amber" />
        <StatCard label="7 日内到期" value={expiringSoon} hint="积分包到期账号数" tone={expiringSoon > 0 ? 'amber' : 'slate'} />
        <StatCard label="积分已过期账号" value={expiredCount} hint={expiredCount > 0 ? '积分包到期，续期后恢复' : '暂无过期'} tone={expiredCount > 0 ? 'red' : 'slate'} />
      </div>

      {/* 明细表 */}
      <div className="card mt-4 overflow-x-auto p-4">
        {loading && accounts === null ? (
          <div className="py-10 text-center text-sm text-slate-400">加载中…</div>
        ) : list.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-slate-400">
            暂无国际账号，先到「账号管理」扫码登录或导入凭证。
          </div>
        ) : (
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400 dark:border-zinc-800">
                <th className="py-2 pr-3 font-medium">账号</th>
                <th className="py-2 pr-3 font-medium">积分余额</th>
                <th className="py-2 pr-3 font-medium">积分到期</th>
                <th className="py-2 pr-3 font-medium">最近取数</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const expired = a.credits_expire_at != null && a.credits_expire_at <= nowSec;
                return (
                  <tr key={a.id} className="border-b border-slate-50 last:border-0 dark:border-zinc-800/50">
                    <td className="py-2.5 pr-3">
                      <div className="font-medium">{a.nickname || a.id}</div>
                      <div className="text-[11px] text-slate-400">{a.uid || a.id}</div>
                    </td>
                    <td className="py-2.5 pr-3 tabular-nums">
                      {a.credits_balance != null ? (
                        <span className="inline-flex items-center gap-1">
                          <Coins size={13} className="text-amber-500" />
                          {a.credits_balance.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">未取数</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-xs tabular-nums">
                      <span className={expired ? 'text-rose-500' : 'text-slate-500'}>
                        {fmtExpire(a.credits_expire_at)}
                        {expired ? '（已过期）' : ''}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-slate-500">{fmtFetched(a.credits_fetched_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 模型消耗排行（P5：buddy_ai_days 桶近 30 天按模型聚合，请求次数口径） */}
      <div className="card mt-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">模型消耗排行</span>
          <span className="text-[11px] text-slate-400">近 30 天 · 网关记账 · 按请求数排序</span>
        </div>
        {modelRank.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">
            近 30 天无网关请求记录（启用 buddy-ai 国际档并通过网关调用后，此处展示按模型排行）。
          </p>
        ) : (
          <div className="space-y-2">
            {modelRank.map((m) => (
              <div key={m.name} className="flex items-center gap-3">
                <span className="w-44 shrink-0 truncate text-xs text-slate-600 dark:text-zinc-300" title={m.name}>
                  {m.name}
                </span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-brand-500"
                    style={{ width: `${rankMax > 0 ? Math.max((m.requests / rankMax) * 100, 2) : 0}%` }}
                  />
                </div>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-500">
                  {m.requests.toLocaleString()} 请求
                </span>
              </div>
            ))}
            <p className="text-[11px] leading-4 text-slate-400">
              口径说明：Intl 上游未下发按模型积分明细，排行以网关请求数计（对齐 Token 统计网关源口径）；
              模型级积分待上游公开接口后接入。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
