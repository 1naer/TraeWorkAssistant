import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Coins } from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import ActivityHeatmap from '../../components/charts/ActivityHeatmap';
import { StatCard, Badge } from '../../components/ui';
import PageHeader from '../../components/PageHeader';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import { withMinDelay } from '../../lib/delay';
import type { BuddyAiAccountView, GroupView, UsageDayView, WbCheckinRecord } from '../../types';

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
 * credits_fetched_at，由每日打卡前置快照与积分同步回写）；「刷新数据」触发
 * buddy_ai_credits_fetch 全池 get-user-resource 实时取数。
 * Intl 上游无积分包明细接口，按 TotalDosage 总额展示（对齐 §4.5 积分同步口径）。
 */

/** 多选下拉（移植国内 Dashboard 同款：chips 触发 + 面板勾选 + 搜索 + 清空） */
function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  width = 'w-56',
}: {
  label: string;
  options: { id: string; name: string; color?: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const kw = search.trim().toLowerCase();
  const visible = kw
    ? options.filter((o) => o.name.toLowerCase().includes(kw) || o.id.toLowerCase().includes(kw))
    : options;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={`btn-outline !py-1.5 !text-xs ${selected.length ? '!border-sky-400 text-sky-600 dark:text-sky-400' : ''}`}
        onClick={() => {
          setOpen((v) => !v);
          setSearch('');
        }}
      >
        {label}
        {selected.length > 0 && (
          <span className="ml-1 rounded-full bg-sky-500 px-1.5 text-[10px] font-medium text-white">
            {selected.length}
          </span>
        )}
      </button>
      {open && (
        <div
          className={`absolute right-0 z-30 mt-1 max-h-72 ${width} overflow-auto rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900`}
        >
          {options.length > 5 && (
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`搜索${label}…`}
              className="input mb-1 !py-1 !text-xs"
            />
          )}
          {visible.length === 0 && (
            <div className="px-2 py-1 text-xs text-slate-400">
              {options.length === 0 ? '暂无可选项' : '无匹配项'}
            </div>
          )}
          {visible.map((o) => (
            <label
              key={o.id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50 dark:hover:bg-zinc-800"
            >
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={() => toggle(o.id)}
                className="h-3.5 w-3.5"
              />
              {o.color && (
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: o.color }} />
              )}
              <span className="truncate">{o.name}</span>
            </label>
          ))}
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-slate-400 hover:bg-slate-50 dark:hover:bg-zinc-800"
            >
              清空筛选（全部）
            </button>
          )}
        </div>
      )}
    </div>
  );
}

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
  // 全局筛选（对齐国内看板顶部分组/账号筛选：多选下拉，联动 KPI 卡 / 包明细 / 明细表）
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [groupFilter, setGroupFilter] = useState<string[]>([]);
  const [acctFilter, setAcctFilter] = useState<string[]>([]);
  // Tab 布局（对齐国内 Dashboard：积分 / Token / 到期 / 请求明细）
  const [tab, setTab] = useState<'credits' | 'tokens' | 'expiry' | 'sessions'>('credits');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accs, recs, usg, hist, gs] = await Promise.all([
        api.buddyai.accountsList(),
        api.buddyai.checkinResults(90).catch(() => [] as WbCheckinRecord[]),
        api.apiServer.buddyAiUsageStats(90).catch(() => [] as UsageDayView[]),
        api.buddyai.creditsHistory(90).catch(() => [] as CreditSnap[]),
        api.groups.sharedList().catch(() => [] as GroupView[]),
      ]);
      setAccounts(accs);
      setRecords(recs);
      setGroups(gs);
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
  // 全局筛选（国内看板同款多选语义：分组 → 账号级联，联动下方 KPI / 包明细 / 明细表；
  // 生效集 = 组筛选 ∩ 账号筛选，均空 = 不限）
  const groupFiltered = useMemo(() => {
    if (groupFilter.length === 0) return list;
    return list.filter(
      (a) =>
        (groupFilter.includes('__ungrouped__') && !a.group_id) ||
        (a.group_id != null && groupFilter.includes(a.group_id)),
    );
  }, [list, groupFilter]);
  const listF = useMemo(
    () => (acctFilter.length === 0 ? groupFiltered : groupFiltered.filter((a) => acctFilter.includes(a.id))),
    [groupFiltered, acctFilter],
  );
  const withBalance = listF.filter((a) => a.credits_balance != null);
  const total = withBalance.reduce((s, a) => s + (a.credits_balance ?? 0), 0);
  const nowSec = Math.floor(Date.now() / 1000);
  const neverFetched = listF.length - withBalance.length;
  const localDateStr = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const today = localDateStr(new Date());
  // 打卡获得（P4 同口径：今日）
  const todayEarned = useMemo(
    () => records.filter((r) => r.date === today).reduce((s, r) => s + (r.reward ?? 0), 0),
    [records, today],
  );
  // 7 日内积分到期账号数（credits_expire_at 落在未来 7 天窗口）
  const expiringSoon = withBalance.filter((a) => {
    const e = a.credits_expire_at;
    return e != null && e > nowSec && e <= nowSec + 7 * 86400;
  }).length;
  // 模型消耗排行（积分口径，对齐国内；Top8 + 其余合计由渲染层切分）
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
      .sort((a, b) => b.credits - a.credits);
  }, [usage]);
  const rankMax = modelRank[0]?.credits ?? 0;
  // 积分包明细聚合（P9：各账号 credits_packages 拍平；按到期升序——对齐国内「积分到期」Tab 逐包到期口径，7 日内到期徽标）
  const pkgList = useMemo(
    () =>
      listF
        .flatMap((a) =>
          (a.credits_packages ?? []).map((p) => ({
            acct: a.nickname || a.id,
            ...p,
          })),
        )
        .sort((x, y) => (x.expire_secs ?? Infinity) - (y.expire_secs ?? Infinity)),
    [listF],
  );
  const pkgSoon = (expire: number | null | undefined) =>
    expire != null && expire > nowSec && expire <= nowSec + 7 * 86400;
  // 今日消耗积分（网关记账口径：usage 今日 credits 合计——对齐国内「今日消耗积分」）
  const todayCreditsSpent = useMemo(() => {
    const d = usage.find((u) => u.date === today);
    return d ? (d.models ?? []).reduce((s, x) => s + (x.credits ?? 0), 0) : 0;
  }, [usage, today]);

  // ── 积分统计区间（对齐国内 CreditsTab：今日/近7天/近30天/本月/近一年）──
  // 数据窗口：打卡记录与网关用量后端均 clamp 90 天。近一年档的起点钳到 90 天
  // 窗口（审查 P2：不钳会生成 365 个数据点、前 275 天恒 0，视觉误导为「半年
  // 没消耗」；钳后区间统计/趋势均只覆盖可得数据，卡片下方有窗口声明）
  const [range, setRange] = useState<'today' | '7d' | '30d' | 'month' | 'year'>('30d');
  const rangeStart = useMemo(() => {
    if (range === 'today') return today;
    const d = new Date();
    if (range === '7d') d.setDate(d.getDate() - 6);
    else if (range === '30d') d.setDate(d.getDate() - 29);
    else if (range === 'month') d.setDate(1);
    else d.setDate(d.getDate() - 89);
    return localDateStr(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, today]);

  // 按日序列：获得 = 打卡入账（success 计奖）；消耗 = 网关记账 credits
  const dailyEarned = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of records) {
      if (r.status === 'success' && r.reward) m.set(r.date, (m.get(r.date) ?? 0) + r.reward);
    }
    return m;
  }, [records]);
  const dailySpent = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of usage) {
      const c = (d.models ?? []).reduce((s, x) => s + (x.credits ?? 0), 0);
      if (c > 0) m.set(d.date, (m.get(d.date) ?? 0) + c);
    }
    return m;
  }, [usage]);

  // 区间三统计卡（获得 − 消耗 = 净获得）
  const rangeEarned = useMemo(() => {
    let s = 0;
    for (const [k, v] of dailyEarned) if (k >= rangeStart) s += v;
    return s;
  }, [dailyEarned, rangeStart]);
  const rangeSpent = useMemo(() => {
    let s = 0;
    for (const [k, v] of dailySpent) if (k >= rangeStart) s += v;
    return s;
  }, [dailySpent, rangeStart]);
  const rangeNet = rangeEarned - rangeSpent;

  // 趋势序列（区间内逐日双线；无数据日补 0 保持连续横轴）
  const trendData = useMemo(() => {
    const out: Array<{ date: string; 获得积分: number; 消耗积分: number }> = [];
    const end = new Date();
    const start = new Date(`${rangeStart}T00:00:00`);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const k = localDateStr(d);
      out.push({
        date: k.slice(5),
        获得积分: Number((dailyEarned.get(k) ?? 0).toFixed(2)),
        消耗积分: Number((dailySpent.get(k) ?? 0).toFixed(2)),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeStart, dailyEarned, dailySpent]);

  // 年度活动热力图（消耗口径，对齐国内；窗口 90 天诚实标注）
  const heatValues = useMemo(() => {
    const m = new Map<string, number>();
    for (const [k, v] of dailySpent) if (v > 0) m.set(k, v);
    return m;
  }, [dailySpent]);

  // 请求明细拉取（P9：官网分页接口）。
  // FH-3 审查修复：递增序号守卫——慢响应后到会覆盖新筛选条件的结果（张冠李戴）
  const usageSeq = useRef(0);
  const loadUsage = useCallback(
    async (acctId: string, days: number, page: number) => {
      if (!acctId) return;
      const seq = ++usageSeq.current;
      setUsageLoading(true);
      try {
        const r = await api.buddyai.requestUsage(acctId, days, page, 20);
        if (seq !== usageSeq.current) return; // 过期响应丢弃
        setUsageData(r);
        // FM-2：以服务端夹取后的页码为准回同步（筛选/翻页错位自愈）
        setUsagePage(r.page);
      } catch (err) {
        if (seq !== usageSeq.current) return;
        pushToast('error', `请求流水查询失败：${String(err).slice(0, 160)}`);
        setUsageData(null);
      } finally {
        if (seq === usageSeq.current) setUsageLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // ── Token 统计切面（对齐国内 TokensTab：独立区间 + 四卡 + 柱线组合图）──
  const [tokenRange, setTokenRange] = useState<'today' | '7d' | '30d' | 'month' | 'year'>('30d');
  const tokenRangeStart = useMemo(() => {
    if (tokenRange === 'today') return today;
    const d = new Date();
    if (tokenRange === '7d') d.setDate(d.getDate() - 6);
    else if (tokenRange === '30d') d.setDate(d.getDate() - 29);
    else if (tokenRange === 'month') d.setDate(1);
    else d.setDate(d.getDate() - 89);
    return localDateStr(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenRange, today]);
  const usageInRange = useMemo(
    () => usage.filter((u) => u.date >= tokenRangeStart),
    [usage, tokenRangeStart],
  );
  const sumTokens = useMemo(
    () => usageInRange.reduce((s, u) => s + u.prompt_tokens + u.completion_tokens, 0),
    [usageInRange],
  );
  const sumPrompt = useMemo(() => usageInRange.reduce((s, u) => s + u.prompt_tokens, 0), [usageInRange]);
  const sumCompletion = useMemo(
    () => usageInRange.reduce((s, u) => s + u.completion_tokens, 0),
    [usageInRange],
  );
  const sumRequests = useMemo(() => usageInRange.reduce((s, u) => s + u.total_requests, 0), [usageInRange]);
  const sumErrors = useMemo(() => usageInRange.reduce((s, u) => s + u.errors, 0), [usageInRange]);
  // 柱线组合趋势（输入/输出堆叠柱 + 调用次数虚线，对齐国内网关源口径）
  const tokenTrend = useMemo(
    () =>
      usageInRange.map((u) => ({
        date: u.date.slice(5),
        输入: u.prompt_tokens,
        输出: u.completion_tokens,
        调用: u.total_requests,
      })),
    [usageInRange],
  );
  // Token 热力图（全量 90 天窗口 tokens，不受区间筛选影响——对齐国内热力图口径）
  const tokenHeat = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of usage) {
      const v = u.prompt_tokens + u.completion_tokens;
      if (v > 0) m.set(u.date, v);
    }
    return m;
  }, [usage]);
  // Token 模型排行（网关源无按模型 token 明细 → 按请求数口径，对齐国内网关源诚实声明）
  const tokenModelRank = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of usageInRange) {
      for (const x of d.models ?? []) m.set(x.name, (m.get(x.name) ?? 0) + x.requests);
    }
    return [...m.entries()].map(([name, requests]) => ({ name, requests })).sort((a, b) => b.requests - a.requests);
  }, [usageInRange]);
  const tokenRankMax = tokenModelRank[0]?.requests ?? 0;

  const fmtExpire = (ts: number | null) =>
    ts == null ? '—' : new Date(ts * 1000).toLocaleString();
  const fmtFetched = (iso: string | null) =>
    iso == null || iso === '' ? '—' : new Date(iso).toLocaleString();

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="BuddyAI · 积分看板"
        desc="积分余额 · 积分明细 · Token 统计 · 到期日历 · 会话明细"
      />

      {/* 顶部统计卡（P5 口径对齐国内积分看板七卡；随筛选联动） */}
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatCard label="账号总数" value={listF.length} hint={`${withBalance.length} 个已取数`} tone="brand" />
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
        <StatCard label="积分包总数" value={pkgList.length} hint={`${new Set(pkgList.map((p) => p.acct)).size} 个账号持有积分包`} tone="brand" />
        <StatCard label="今日新增积分" value={todayEarned > 0 ? todayEarned.toFixed(0) : '0'} hint="今日打卡入账合计（服务端按套餐 30/50 定档）" tone="green" />
        <StatCard label="今日消耗积分" value={todayCreditsSpent > 0 ? todayCreditsSpent.toFixed(2) : '0'} hint="今日网关用量记账积分合计" tone="amber" />
        <StatCard label="7 日内到期" value={expiringSoon} hint="积分包到期账号数" tone={expiringSoon > 0 ? 'amber' : 'slate'} />
      </div>

      {/* 第一层分类：Tab 切换（左，胶囊分组样式对齐国内 Dashboard）+ 筛选/刷新（右） */}
      <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-2">
        <div className="flex rounded-lg bg-slate-100 p-1 dark:bg-zinc-900">
          {(
            [
              ['credits', '积分统计'],
              ['tokens', 'Token 统计'],
              ['expiry', '积分到期'],
              ['sessions', '会话明细'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={`rounded-md px-3.5 py-1.5 text-xs font-medium ${
                tab === k
                  ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                  : 'text-slate-500 dark:text-zinc-400'
              }`}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 分组/账号多选下拉（对齐国内 Dashboard MultiSelectDropdown：chips 触发 + 面板勾选；
              账号候选随分组筛选联动） */}
          <MultiSelectDropdown
            label="分组筛选"
            options={[
              { id: '__ungrouped__', name: '未分组' },
              ...groups.map((g) => ({ id: g.id, name: g.name, color: g.color })),
            ]}
            selected={groupFilter}
            onChange={setGroupFilter}
          />
          <MultiSelectDropdown
            label="账号筛选"
            options={groupFiltered.map((a) => ({ id: a.id, name: a.nickname || a.id }))}
            selected={acctFilter}
            onChange={setAcctFilter}
          />
          {acctFilter.length > 0 || groupFilter.length > 0 ? (
            <button
              className="btn-ghost text-xs text-slate-400"
              onClick={() => {
                setGroupFilter([]);
                setAcctFilter([]);
              }}
            >
              清除筛选
            </button>
          ) : null}
          <span className="text-[11px] text-slate-400">
            {listF.length}/{list.length} 个账号
          </span>
          <button className="btn-outline inline-flex items-center gap-1.5 text-xs" onClick={() => void syncCredits()} disabled={syncing}>
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} /> {syncing ? '刷新中…' : '刷新数据'}
          </button>
        </div>
      </div>

      {/* 积分统计（对齐国内 CreditsTab：数据源平铺 + 三统计卡 + 双线趋势 + 时间筛选平铺） */}
      {tab === 'credits' && (
      <div className="card mt-4 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">积分统计</span>
            {/* 数据源平铺徽标（对齐国内：本地 / API网关 / 官网，有数据点亮） */}
            <span className="text-[11px] text-slate-400">数据源</span>
            {([
              ['本地', history.length > 0, '积分快照（buddy_ai_credits_history，每日同步落库）'],
              ['API网关', usage.length > 0, '网关用量记账（buddy_ai_days，模型倍率 × 用量）'],
              ['官网', records.length > 0, '官网打卡记录（workbuddy.ai 侧入账流水）'],
            ] as [string, boolean, string][]).map(([label, on, tip]) => (
              <span
                key={label}
                title={tip}
                className={`rounded px-1.5 py-0.5 text-[11px] ${
                  on
                    ? 'bg-emerald-500/10 font-medium text-emerald-600 dark:text-emerald-400'
                    : 'bg-slate-100 text-slate-400 dark:bg-zinc-800 dark:text-zinc-500'
                }`}
              >
                {label}
              </span>
            ))}
          </div>
          {/* 时间筛选平铺（对齐国内：胶囊单选，不使用下拉） */}
          <div className="flex overflow-hidden rounded-lg border border-slate-200 text-xs dark:border-zinc-700">
            {(
              [
                ['today', '今日'],
                ['7d', '近7天'],
                ['30d', '近30天'],
                ['month', '本月'],
                ['year', '近一年'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                className={`px-2.5 py-1 transition ${
                  range === k
                    ? 'bg-brand-500/10 font-medium text-brand-600 dark:text-brand-400'
                    : 'text-slate-500 hover:bg-slate-50 dark:text-zinc-400 dark:hover:bg-zinc-800/60'
                }`}
                onClick={() => setRange(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 区间三统计卡（获得 / 消耗 / 净获得，对齐国内配色） */}
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border-t-2 border-emerald-500 bg-slate-50/60 p-3 dark:bg-zinc-900/60">
            <div className="text-xs text-slate-500">区间总获得</div>
            <div className="text-xl font-bold tabular-nums text-emerald-500">{rangeEarned.toFixed(2)}</div>
            <div className="text-[11px] text-slate-400">打卡入账按日合计</div>
          </div>
          <div className="rounded-lg border-t-2 border-amber-500 bg-slate-50/60 p-3 dark:bg-zinc-900/60">
            <div className="text-xs text-slate-500">区间总消耗</div>
            <div className="text-xl font-bold tabular-nums text-amber-500">{rangeSpent.toFixed(2)}</div>
            <div className="text-[11px] text-slate-400">网关用量记账（模型倍率 × 用量）</div>
          </div>
          <div className="rounded-lg border-t-2 border-rose-500 bg-slate-50/60 p-3 dark:bg-zinc-900/60">
            <div className="text-xs text-slate-500">净获得</div>
            <div className={`text-xl font-bold tabular-nums ${rangeNet >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
              {rangeNet >= 0 ? '+' : ''}{rangeNet.toFixed(2)}
            </div>
            <div className="text-[11px] text-slate-400">获得 − 消耗</div>
          </div>
        </div>

        {range === 'year' && (
          <p className="mb-3 text-[11px] text-slate-400">
            注：打卡记录与网关用量仅保留近 90 天窗口，「近一年」区间按可得数据统计（起点自动钳到窗口内）。
          </p>
        )}

        {trendData.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">
            暂无数据。打卡成功或通过网关调用后按日落库，即可看到趋势。
          </p>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#8884" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="获得积分" stroke="#10b981" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="消耗积分" stroke="#f59e0b" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      )}

      {/* 积分包到期（P9 抓包解锁：get-user-resource Accounts[] 分包解析；对齐国内「到期」Tab） */}
      {tab === 'expiry' && (
      <div className="card mt-4 overflow-x-auto p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">积分包到期</span>
          <span className="text-[11px] text-slate-400">按包拆分剩余/总额/到期，升序排列（同步积分后刷新）</span>
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
                  <td className="py-2 pr-3 text-xs">
                    {p.name || p.code || '—'}
                    {pkgSoon(p.expire_secs) && p.remain > 0 ? <Badge tone="amber">7 日内到期</Badge> : null}
                  </td>
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
      )}

      {/* Token 统计（P8 补齐：buddy_ai_days 桶网关记账切面） */}
      {/* Token 统计（对齐国内 TokensTab：独立区间胶囊 + 四统计卡 + 柱线组合图 + 模型排行 + 热力图） */}
      {tab === 'tokens' && (
      <div className="card mt-4 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Token 统计</span>
            <span className="text-[11px] text-slate-400">
              网关记账（buddy-ai 档）· 仅保留 90 天窗口 · ~/.workbuddy-ai 独立记账
            </span>
          </div>
          {/* 区间胶囊（独立于积分统计区间，对齐国内 TokensTab 顶栏） */}
          <div className="flex overflow-hidden rounded-lg border border-slate-200 text-xs dark:border-zinc-700">
            {(
              [
                ['today', '今日'],
                ['7d', '近7天'],
                ['30d', '近30天'],
                ['month', '本月'],
                ['year', '近一年'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                className={`px-2.5 py-1 transition ${
                  tokenRange === k
                    ? 'bg-brand-500/10 font-medium text-brand-600 dark:text-brand-400'
                    : 'text-slate-500 hover:bg-slate-50 dark:text-zinc-400 dark:hover:bg-zinc-800/60'
                }`}
                onClick={() => setTokenRange(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {/* 四统计卡（对齐国内配色：总紫 / 输入蓝 / 输出绿 / 请求橙） */}
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border-t-2 border-violet-500 bg-slate-50/60 p-3 dark:bg-zinc-900/60">
            <div className="text-xs text-slate-500">总 Tokens</div>
            <div className="text-xl font-bold tabular-nums text-violet-500">{sumTokens.toLocaleString()}</div>
            <div className="text-[11px] text-slate-400">输入 + 输出合计</div>
          </div>
          <div className="rounded-lg border-t-2 border-sky-500 bg-slate-50/60 p-3 dark:bg-zinc-900/60">
            <div className="text-xs text-slate-500">输入 Tokens</div>
            <div className="text-xl font-bold tabular-nums text-sky-500">{sumPrompt.toLocaleString()}</div>
            <div className="text-[11px] text-slate-400">prompt（含缓存读取）</div>
          </div>
          <div className="rounded-lg border-t-2 border-emerald-500 bg-slate-50/60 p-3 dark:bg-zinc-900/60">
            <div className="text-xs text-slate-500">输出 Tokens</div>
            <div className="text-xl font-bold tabular-nums text-emerald-500">{sumCompletion.toLocaleString()}</div>
            <div className="text-[11px] text-slate-400">completion 合计</div>
          </div>
          <div className="rounded-lg border-t-2 border-amber-500 bg-slate-50/60 p-3 dark:bg-zinc-900/60">
            <div className="text-xs text-slate-500">请求数</div>
            <div className="text-xl font-bold tabular-nums text-amber-500">{sumRequests.toLocaleString()}</div>
            <div className="text-[11px] text-slate-400">
              {sumErrors > 0 ? `失败 ${sumErrors} 次` : '网关测量口径'}
            </div>
          </div>
        </div>
        {tokenTrend.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-400">该区间无网关请求记录。</p>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={tokenTrend} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#8884" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" tickLine={false} axisLine={false} />
                <YAxis
                  yAxisId="tokens"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
                />
                <YAxis yAxisId="calls" orientation="right" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="tokens" dataKey="输入" stackId="t" fill="#0ea5e9" />
                <Bar yAxisId="tokens" dataKey="输出" stackId="t" fill="#10b981" radius={[3, 3, 0, 0]} />
                <Line
                  yAxisId="calls"
                  type="monotone"
                  dataKey="调用"
                  stroke="#f43f5e"
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      )}

      {/* Token 模型排行（请求数口径；网关源无按模型 token 明细，对齐国内诚实声明） */}
      {tab === 'tokens' && (
      <div className="card mt-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">模型消耗排行</span>
          <span className="text-[11px] text-slate-400">
            {tokenRange === 'today'
              ? '今日'
              : tokenRange === '7d'
                ? '近 7 天'
                : tokenRange === 'month'
                  ? '本月'
                  : '近 90 天'}{' '}
            · 网关记账 · 按请求数排序 Top8 + 其余合计
          </span>
        </div>
        {tokenModelRank.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">该区间无网关请求记录。</p>
        ) : (
          <div className="space-y-2">
            {tokenModelRank.slice(0, 8).map((m) => (
              <div key={m.name} className="flex items-center gap-3">
                <span className="w-44 shrink-0 truncate text-xs text-slate-600 dark:text-zinc-300" title={m.name}>
                  {m.name}
                </span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-sky-500"
                    style={{ width: `${tokenRankMax > 0 ? Math.max((m.requests / tokenRankMax) * 100, 2) : 0}%` }}
                  />
                </div>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-500">
                  {m.requests.toLocaleString()} 请求
                </span>
              </div>
            ))}
            {tokenModelRank.length > 8 && (
              <div className="flex items-center gap-3 border-t border-slate-100 pt-2 dark:border-zinc-800">
                <span className="w-44 shrink-0 truncate text-xs text-slate-400">
                  其余 {tokenModelRank.length - 8} 个模型
                </span>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-400">
                  {tokenModelRank.slice(8).reduce((s, m) => s + m.requests, 0).toLocaleString()} 请求
                </span>
              </div>
            )}
            <p className="text-[11px] leading-4 text-slate-400">
              口径说明：网关源无按模型 token 明细，排行按请求数计（对齐国内网关源口径）；
              模型粒度真实积分见「积分统计」Tab 排行。
            </p>
          </div>
        )}
      </div>
      )}

      {/* Token 年度活动热力图（全量 90 天窗口 tokens，不受区间筛选影响） */}
      {tab === 'tokens' && (
      <div className="card mt-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">年度活动热力图</span>
          <span className="text-[11px] text-slate-400">每日 Tokens（输入 + 输出）· 网关记账（仅保留 90 天窗口）</span>
        </div>
        <ActivityHeatmap
          values={tokenHeat}
          unit="tokens"
          emptyHint="暂无网关用量：启用 buddy-ai 国际档并通过网关调用后展示。"
        />
      </div>
      )}

      {/* 明细表 */}
      {tab === 'credits' && (
      <div className="card mt-4 overflow-x-auto p-4">
        {loading && accounts === null ? (
          <div className="py-10 text-center text-sm text-slate-400">加载中…</div>
        ) : listF.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-slate-400">
            {list.length === 0 ? '暂无国际账号，先到「账号管理」扫码登录或导入凭证。' : '当前筛选条件下无账号。'}
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
              {listF.map((a) => {
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
      )}

      {/* 模型消耗排行（积分口径对齐国内：Top8 + 其余合计） */}
      {tab === 'credits' && (
      <div className="card mt-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">模型消耗排行</span>
          <span className="text-[11px] text-slate-400">近 90 天 · 网关记账 · 按积分排序 Top8 + 其余合计</span>
        </div>
        {modelRank.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">
            暂无消耗记录（启用 buddy-ai 国际档并通过网关调用后，此处展示按模型排行）。
          </p>
        ) : (
          <div className="space-y-2">
            {modelRank.slice(0, 8).map((m) => (
              <div key={m.name} className="flex items-center gap-3">
                <span className="w-44 shrink-0 truncate text-xs text-slate-600 dark:text-zinc-300" title={m.name}>
                  {m.name}
                </span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-amber-500"
                    style={{ width: `${rankMax > 0 ? Math.max((m.credits / rankMax) * 100, 2) : 0}%` }}
                  />
                </div>
                <span className="w-28 shrink-0 text-right text-xs tabular-nums text-slate-500">
                  {m.credits.toFixed(2)} 积分
                </span>
              </div>
            ))}
            {modelRank.length > 8 && (
              <div className="flex items-center gap-3 border-t border-slate-100 pt-2 dark:border-zinc-800">
                <span className="w-44 shrink-0 truncate text-xs text-slate-400">
                  其余 {modelRank.length - 8} 个模型
                </span>
                <span className="w-28 shrink-0 text-right text-xs tabular-nums text-slate-400">
                  {modelRank.slice(8).reduce((s, m) => s + m.credits, 0).toFixed(2)} 积分
                </span>
              </div>
            )}
            <p className="text-[11px] leading-4 text-slate-400">
              口径说明：按模型积分取自网关记账（模型倍率 × 用量）按日聚合；请求级真实积分见「会话明细」（官网流水）。
            </p>
          </div>
        )}
      </div>
      )}

      {/* 年度活动热力图（消耗口径，对齐国内；窗口 90 天诚实标注） */}
      {tab === 'credits' && (
      <div className="card mt-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">年度活动热力图</span>
          <span className="text-[11px] text-slate-400">每日消耗积分 · 网关记账（仅保留 90 天窗口）</span>
        </div>
        <ActivityHeatmap values={heatValues} unit="积分" emptyHint="暂无消耗记录：启用 buddy-ai 国际档并通过网关调用后展示。" />
      </div>
      )}

      {/* 会话明细（P9 抓包解锁：官网 get-user-request-usage 请求级流水；Tab 名对齐国内） */}
      {tab === 'sessions' && (
      <div className="card mt-4 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">会话明细</span>
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
              // FM-2：筛选条件变更清空旧窗口数据（旧 total/旧行不得滞留展示）
              setUsageData(null);
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
                  {usageData.rows.map((r, i) => (
                    <tr key={`${r.requestId}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-zinc-800/50">
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
      )}
    </div>
  );
}
