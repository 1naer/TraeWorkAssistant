import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Coins } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { StatCard } from '../../components/ui';
import PageHeader from '../../components/PageHeader';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import { withMinDelay } from '../../lib/delay';
import type { BuddyAiAccountView, UsageDayView, WbCheckinRecord } from '../../types';

/** P8 积分快照行（buddy_ai_credits_history 表） */
interface CreditSnap {
  date: string;
  ts: number;
  total_balance: number;
  accounts: Array<{ id: string; name: string; balance: number | null }>;
  earned: number | null;
}

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
  const [history, setHistory] = useState<CreditSnap[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // 请求明细（P9：官网 get-user-request-usage 分页）
  const [usageAcct, setUsageAcct] = useState('');
  const [usageDays, setUsageDays] = useState(7);
  const [usagePage, setUsagePage] = useState(1);
  const [usageData, setUsageData] = useState<{
    total: number;
    page: number;
    pageSize: number;
    rows: Array<{
      requestId: string;
      credit: number;
      model: string;
      client: string;
      requestTime: string;
      inputTrunc: string;
      agentPurpose: string;
    }>;
  } | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accs, recs, usg, hist] = await Promise.all([
        api.buddyai.accountsList(),
        api.buddyai.checkinResults(90).catch(() => [] as WbCheckinRecord[]),
        api.apiServer.buddyAiUsageStats(30).catch(() => [] as UsageDayView[]),
        api.buddyai.creditsHistory(90).catch(() => [] as CreditSnap[]),
      ]);
      setAccounts(accs);
      setRecords(recs);
      setUsage(usg);
      setHistory(hist);
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
  // 积分包明细聚合（P9：各账号 credits_packages 拍平）
  const pkgList = useMemo(
    () =>
      list.flatMap((a) =>
        (a.credits_packages ?? []).map((p) => ({
          acct: a.nickname || a.id,
          ...p,
        })),
      ),
    [list],
  );
  // 请求明细拉取（P9：官网分页接口）
  const loadUsage = useCallback(
    async (acctId: string, days: number, page: number) => {
      if (!acctId) return;
      setUsageLoading(true);
      try {
        const r = await api.buddyai.requestUsage(acctId, days, page, 20);
        setUsageData(r);
      } catch (err) {
        pushToast('error', `请求流水查询失败：${String(err).slice(0, 160)}`);
        setUsageData(null);
      } finally {
        setUsageLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // Token 统计切面（P8 补齐：buddy_ai_days 桶网关记账；输入/输出分列）
  const todayTokens = useMemo(() => {
    const d = usage.find((u) => u.date === today);
    return d ? d.prompt_tokens + d.completion_tokens : 0;
  }, [usage, today]);
  const sumTokens = useMemo(
    () => usage.reduce((s, u) => s + u.prompt_tokens + u.completion_tokens, 0),
    [usage],
  );
  const sumRequests = useMemo(() => usage.reduce((s, u) => s + u.total_requests, 0), [usage]);
  const sumErrors = useMemo(() => usage.reduce((s, u) => s + u.errors, 0), [usage]);
  const tokenTrend = useMemo(
    () =>
      usage.map((u) => ({
        date: u.date.slice(5),
        输入: u.prompt_tokens,
        输出: u.completion_tokens,
      })),
    [usage],
  );

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

      {/* 积分趋势（P8：buddy_ai_credits_history 每日快照，打卡回写/手动同步双挂点落库） */}
      <div className="card mt-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">积分趋势</span>
          <span className="text-[11px] text-slate-400">近 90 天可用总积分 · 每日快照（同日覆盖）</span>
        </div>
        {history.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">
            暂无快照数据。打卡成功或「同步积分」后会自动落当日快照，连续多日即可看到趋势。
          </p>
        ) : (
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={history.map((h) => ({ date: h.date.slice(5), 可用总积分: Number(h.total_balance.toFixed(2)) }))}
                margin={{ top: 4, right: 8, bottom: 0, left: -12 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#8884" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Line type="monotone" dataKey="可用总积分" stroke="#10b981" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* 积分包明细（P9 抓包解锁：get-user-resource Accounts[] 分包解析） */}
      <div className="card mt-4 overflow-x-auto p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">积分包明细</span>
          <span className="text-[11px] text-slate-400">按包拆分剩余/总额/到期（同步积分后刷新）</span>
        </div>
        {pkgList.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-400">暂无分包数据，先「同步积分」取数。</p>
        ) : (
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400 dark:border-zinc-800">
                <th className="py-2 pr-3 font-medium">账号</th>
                <th className="py-2 pr-3 font-medium">包名</th>
                <th className="py-2 pr-3 font-medium">剩余</th>
                <th className="py-2 pr-3 font-medium">总额</th>
                <th className="py-2 pr-3 font-medium">到期时间</th>
              </tr>
            </thead>
            <tbody>
              {pkgList.map((p, i) => (
                <tr key={`${p.acct}-${p.code}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-zinc-800/50">
                  <td className="py-2 pr-3 text-xs">{p.acct}</td>
                  <td className="py-2 pr-3 text-xs">{p.name || p.code || '—'}</td>
                  <td className="py-2 pr-3 text-xs tabular-nums text-emerald-600 dark:text-emerald-400">{p.remain.toFixed(2)}</td>
                  <td className="py-2 pr-3 text-xs tabular-nums text-slate-500">{p.size.toFixed(0)}</td>
                  <td className="py-2 pr-3 text-xs tabular-nums text-slate-500">
                    {p.expire_secs ? new Date(p.expire_secs * 1000).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Token 统计（P8 补齐：buddy_ai_days 桶网关记账切面） */}
      <div className="card mt-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">Token 统计</span>
          <span className="text-[11px] text-slate-400">近 30 天 · 网关记账（buddy-ai 档）</span>
        </div>
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="今日 Tokens" value={todayTokens.toLocaleString()} hint="输入 + 输出合计" tone="brand" />
          <StatCard label="30 天累计 Tokens" value={sumTokens.toLocaleString()} hint="输入 + 输出合计" tone="green" />
          <StatCard label="请求数" value={sumRequests.toLocaleString()} hint={`${sumErrors} 次失败`} tone="slate" />
          <StatCard
            label="平均每请求"
            value={sumRequests > 0 ? Math.round(sumTokens / sumRequests).toLocaleString() : '—'}
            hint="tokens / 请求"
            tone="amber"
          />
        </div>
        {tokenTrend.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-400">近 30 天无网关请求记录。</p>
        ) : (
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={tokenTrend} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#8884" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Line type="monotone" dataKey="输入" stroke="#0ea5e9" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="输出" stroke="#10b981" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
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
              请求级真实积分见下方「请求明细」（官网流水）。
            </p>
          </div>
        )}
      </div>

      {/* 请求明细（P9 抓包解锁：官网 get-user-request-usage 请求级流水） */}
      <div className="card mt-4 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">请求明细</span>
          <select
            className="rounded-md border border-slate-200 bg-transparent px-2 py-1 text-xs focus:border-brand-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            value={usageAcct}
            onChange={(e) => {
              setUsageAcct(e.target.value);
              setUsagePage(1);
              setUsageData(null);
            }}
          >
            <option value="">选择账号…</option>
            {list.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nickname || a.id}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border border-slate-200 bg-transparent px-2 py-1 text-xs focus:border-brand-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            value={usageDays}
            onChange={(e) => {
              setUsageDays(Number(e.target.value));
              setUsagePage(1);
            }}
          >
            <option value={7}>近 7 天</option>
            <option value={14}>近 14 天</option>
            <option value={31}>近 31 天</option>
          </select>
          <button
            className="btn-outline text-xs"
            disabled={!usageAcct || usageLoading}
            onClick={() => void loadUsage(usageAcct, usageDays, usagePage)}
          >
            {usageLoading ? '查询中…' : '查询'}
          </button>
          <span className="text-[11px] text-slate-400">
            {usageData ? `共 ${usageData.total} 条 · 第 ${usagePage} 页` : '官网请求级流水（含打卡请求，可作官网侧旁证）'}
          </span>
        </div>
        {!usageData ? (
          <p className="py-4 text-center text-xs text-slate-400">选择账号与时间范围后点「查询」。</p>
        ) : usageData.rows.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-400">该窗口内无请求记录。</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs text-slate-400 dark:border-zinc-800">
                    <th className="py-2 pr-3 font-medium">时间</th>
                    <th className="py-2 pr-3 font-medium">模型</th>
                    <th className="py-2 pr-3 font-medium">客户端</th>
                    <th className="py-2 pr-3 font-medium">消耗积分</th>
                    <th className="py-2 pr-3 font-medium">用途</th>
                    <th className="py-2 pr-3 font-medium">输入内容</th>
                  </tr>
                </thead>
                <tbody>
                  {usageData.rows.map((r) => (
                    <tr key={r.requestId} className="border-b border-slate-50 last:border-0 dark:border-zinc-800/50">
                      <td className="py-2 pr-3 text-xs tabular-nums text-slate-500">{r.requestTime}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{r.model}</td>
                      <td className="py-2 pr-3 text-xs text-slate-500">{r.client}</td>
                      <td className="py-2 pr-3 text-xs tabular-nums">
                        {r.credit > 0 ? (
                          <span className="text-amber-600 dark:text-amber-400">{r.credit.toFixed(2)}</span>
                        ) : (
                          <span className="text-slate-400">0</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs text-slate-500">{r.agentPurpose}</td>
                      <td className="py-2 pr-3 max-w-[220px] truncate text-xs text-slate-500" title={r.inputTrunc}>
                        {r.inputTrunc || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-end gap-2 text-xs">
              <button
                className="btn-outline px-2 py-1"
                disabled={usagePage <= 1 || usageLoading}
                onClick={() => {
                  const p = usagePage - 1;
                  setUsagePage(p);
                  void loadUsage(usageAcct, usageDays, p);
                }}
              >
                上一页
              </button>
              <span className="tabular-nums text-slate-500">
                {usagePage} / {Math.max(Math.ceil(usageData.total / usageData.pageSize), 1)}
              </span>
              <button
                className="btn-outline px-2 py-1"
                disabled={usagePage >= Math.ceil(usageData.total / usageData.pageSize) || usageLoading}
                onClick={() => {
                  const p = usagePage + 1;
                  setUsagePage(p);
                  void loadUsage(usageAcct, usageDays, p);
                }}
              >
                下一页
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
