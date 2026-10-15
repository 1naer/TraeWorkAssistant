import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, CheckCircle2, Circle, ChevronRight, Coins } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Badge, Spinner, StatCard } from '../../components/ui';
import PageHeader from '../../components/PageHeader';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import type { BuddyAiAccountView, ViewKey, WbCheckinRecord, WbModelInfo } from '../../types';

/**
 * BuddyAI · 概述页（六页子导航对齐国内 Buddy「概述」形态）。
 *
 * 顶部统计卡（账号 / 积分 / 打卡调度 / 凭证告警）+ 配置导航（导入账号 → 开启打卡 →
 * 同步积分 → 开启国际档调度）+ 国际档模型目录（§4.4 静态配置）+ 隔离说明。
 * 数据全部复用 buddy_ai_* 独立池命令，与国内 Buddy 概述零数据共享。
 */

/** 配置导航步骤（对齐 Buddy 概述 SetupGuide 形态） */
interface Step {
  key: string;
  title: string;
  desc: string;
  done: boolean;
  actionLabel: string;
  view: ViewKey;
}

export default function BuddyAiOverview() {
  const pushToast = useAppStore((s) => s.pushToast);
  const setView = useAppStore((s) => s.setView);
  const settings = useAppStore((s) => s.settings);
  const [accounts, setAccounts] = useState<BuddyAiAccountView[]>([]);
  const [records, setRecords] = useState<WbCheckinRecord[]>([]);
  const [catalog, setCatalog] = useState<WbModelInfo[]>([]);
  const [intlEnabled, setIntlEnabled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const [accs, recs, cat, pf] = await Promise.all([
        api.buddyai.accountsList().catch(() => [] as BuddyAiAccountView[]),
        api.buddyai.checkinResults(30).catch(() => [] as WbCheckinRecord[]),
        api.apiServer.buddyAiCatalogList().catch(() => [] as WbModelInfo[]),
        api.apiServer.poolList().catch(() => null),
      ]);
      setAccounts(accs);
      setRecords(recs);
      setCatalog(cat);
      setIntlEnabled(pf?.buddy_ai_enabled ?? false);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = accounts.length;
  const usable = accounts.filter((a) => a.has_credential && !a.needs_relogin).length;
  const withBalance = accounts.filter((a) => a.credits_balance != null);
  const totalBalance = withBalance.reduce((s, a) => s + (a.credits_balance ?? 0), 0);
  // 凭证告警：需重新登录 / 无凭证 / token 24h 内将过期（含已过期）
  const nowSec = Math.floor(Date.now() / 1000);
  const tokenSoon = accounts.filter(
    (a) => a.has_credential && a.access_token_expires_at != null && a.access_token_expires_at <= nowSec + 86400,
  ).length;
  const alertCount = accounts.filter((a) => !a.has_credential || a.needs_relogin).length + tokenSoon;
  const checkinEnabled = settings?.buddy_ai_checkin_enabled === true;
  const creditsFetched = withBalance.length > 0;

  // 配置导航（步骤完成态实时判定）
  const steps: Step[] = [
    {
      key: 'account',
      title: '导入国际账号',
      desc: '「账号管理」扫码登录 workbuddy.ai OAuth，或手工导入国际账号 token（须为 .workbuddy.ai 域）。',
      done: total > 0,
      actionLabel: '去导入',
      view: 'buddyai-accounts',
    },
    {
      key: 'checkin',
      title: '开启每日活跃打卡',
      desc: '网页会话 + 沙箱跑一轮对话，服务端自动入账 30/50 积分；支持每日定时与手动触发。',
      done: checkinEnabled,
      actionLabel: '去配置',
      view: 'buddyai-checkin',
    },
    {
      key: 'credits',
      title: '同步积分余额',
      desc: '全池 get-user-resource 实时取数，看板展示余额与到期情况。',
      done: creditsFetched,
      actionLabel: '去同步',
      view: 'buddyai-credits',
    },
    {
      key: 'dispatch',
      title: '开启 buddy-ai 国际档调度',
      desc: '独立池参与统一网关路由（显式开启制），与国内 Buddy 档平级、互不影响。',
      done: intlEnabled,
      actionLabel: '去开启',
      view: 'buddyai-api-service',
    },
  ];
  const completed = steps.filter((s) => s.done).length;
  const allDone = completed === steps.length;

  // 近 30 天打卡趋势（P2 数据源：buddy_ai_checkin_results 表；缺日补零，镜像国内堆叠口径）
  const localDateStr = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const trend = useMemo(() => {
    const days: string[] = [];
    for (let i = 29; i >= 0; i--) days.push(localDateStr(new Date(Date.now() - i * 86400000)));
    const byDate = new Map<string, { s: number; a: number; f: number }>();
    for (const r of records) {
      const d = byDate.get(r.date) ?? { s: 0, a: 0, f: 0 };
      if (r.status === 'success') d.s += 1;
      else if (r.status === 'already') d.a += 1;
      else if (r.status === 'fail') d.f += 1;
      byDate.set(r.date, d);
    }
    return days.map((d) => {
      const v = byDate.get(d) ?? { s: 0, a: 0, f: 0 };
      return { date: d.slice(5), 成功: v.s, 已完成: v.a, 失败: v.f };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records]);

  // 积分榜 Top（可用积分降序 Top 5，镜像国内积分榜口径）
  const topCredits = useMemo(
    () =>
      accounts
        .filter((a) => a.credits_balance != null)
        .sort((x, y) => (y.credits_balance ?? 0) - (x.credits_balance ?? 0))
        .slice(0, 5)
        .map((a) => ({
          name: (a.nickname || a.id).slice(0, 14),
          可用积分: Number((a.credits_balance ?? 0).toFixed(2)),
        })),
    [accounts],
  );

  // 今日打卡状态提示（调度开启 + 时刻；历史结果见下方近 30 天趋势图）
  const checkinHint = useMemo(
    () => (checkinEnabled ? `每日 ${settings?.buddy_ai_checkin_hhmm?.trim() || '09:20'} 自动执行` : '未开启定时'),
    [checkinEnabled, settings?.buddy_ai_checkin_hhmm],
  );

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="BuddyAI · 概述"
        desc="Buddy 国际版（workbuddy.ai）运行总览 · 独立池/独立记账 · 打卡调度与积分"
        actions={
          <button onClick={() => void refresh()} className="btn-outline" disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> 刷新
          </button>
        }
      />

      {/* 顶部统计卡 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="账号总数" value={total} hint={`可用 ${usable} · ${checkinHint}`} tone="brand" />
        <StatCard
          label="可用总积分"
          value={withBalance.length ? totalBalance.toFixed(2) : '—'}
          hint={withBalance.length ? `${withBalance.length}/${total} 个已取数` : '到「积分看板」同步后展示'}
          tone="amber"
        />
        <StatCard
          label="打卡调度"
          value={checkinEnabled ? '已开启' : '未开启'}
          hint="官方 30/50 积分 · 幂等每日一次"
          tone={checkinEnabled ? 'green' : 'slate'}
        />
        <StatCard
          label="国际档调度"
          value={intlEnabled ? '已开启' : '未开启'}
          hint="buddy-ai 独立池参与网关路由"
          tone={intlEnabled ? 'green' : 'slate'}
        />
        <StatCard
          label="凭证告警"
          value={alertCount}
          hint={`需重登/无凭证 ${accounts.filter((a) => !a.has_credential || a.needs_relogin).length} · token 24h 内过期 ${tokenSoon}`}
          tone={alertCount > 0 ? 'red' : 'slate'}
        />
      </div>

      {/* 近 30 天打卡结果（镜像国内 Buddy 概述堆叠图；数据源 buddy_ai_checkin_results） */}
      <div className="card mt-5 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">近 30 天打卡结果</span>
          <span className="flex items-center gap-3 text-[11px] text-slate-400">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" />成功</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-500" />已完成</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-rose-500" />失败</span>
          </span>
        </div>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#8884" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={2} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip cursor={{ fill: '#8881' }} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Bar dataKey="成功" stackId="r" fill="#10b981" />
              <Bar dataKey="已完成" stackId="r" fill="#0ea5e9" />
              <Bar dataKey="失败" stackId="r" fill="#f43f5e" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 积分榜 Top（可用积分降序，镜像国内积分榜） */}
      <div className="card mt-5 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">积分榜 Top</span>
          <span className="text-[11px] text-slate-400">按可用积分排序</span>
        </div>
        {topCredits.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">暂无积分数据，先到「积分看板」同步。</p>
        ) : (
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topCredits} layout="vertical" margin={{ top: 0, right: 24, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#8884" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: '#8881' }} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="可用积分" fill="#10b981" radius={[0, 3, 3, 0]} barSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* 配置导航 */}
      <div className="card mt-5 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-zinc-800">
          <div>
            <h3 className="font-medium">配置导航</h3>
            <p className="text-xs text-slate-500">按步骤完成初始化，已完成的步骤无需重复处理。</p>
          </div>
          <Badge tone={allDone ? 'green' : 'amber'}>
            {completed}/{steps.length} 已完成
          </Badge>
        </div>
        <ol className="divide-y divide-slate-100 dark:divide-slate-800">
          {steps.map((step, i) => (
            <li key={step.key} className="flex items-center gap-3 px-4 py-3">
              <div className={step.done ? 'text-emerald-500' : 'text-slate-300 dark:text-zinc-600'}>
                {step.done ? <CheckCircle2 size={20} /> : <Circle size={20} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-800 dark:text-zinc-100">
                  {i + 1}. {step.title}
                </div>
                <div className="text-xs text-slate-500">{step.desc}</div>
              </div>
              {step.done ? (
                <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                  已完成
                </span>
              ) : (
                <button onClick={() => setView(step.view)} className="btn-outline shrink-0">
                  {step.actionLabel}
                  <ChevronRight size={14} />
                </button>
              )}
            </li>
          ))}
        </ol>
        {allDone && (
          <div className="border-t border-slate-100 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-700 dark:border-zinc-800 dark:bg-emerald-500/10 dark:text-emerald-300">
            全部配置已完成，每日打卡与国际档调度交给自动化即可！
          </div>
        )}
      </div>

      {/* 国际档模型目录（§4.4 首版静态配置） */}
      <div className="card mt-5 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Coins size={15} className="text-brand-500" />
          <span className="text-sm font-medium">国际档模型目录</span>
          <span className="text-xs text-slate-400">静态配置（§4.4）· 倍率占位待官网核对回填</span>
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

      {/* 隔离说明 */}
      <div className="card mt-5 p-4 text-xs leading-5 text-slate-500 dark:text-zinc-400">
        <div className="mb-1 text-sm font-medium text-slate-700 dark:text-zinc-200">隔离说明</div>
        BuddyAI 为 Buddy 国际版独立应用（workbuddy.ai 域）：账号池 / 凭证存储（buddy-ai vault
        命名空间）/ 模型冷却 / 用量记账 / 清洗模板全部独立，与国内 Buddy 档零数据共享。
        应用入口默认隐藏，可在「环境配置」中开启显示。
        {refreshing ? <span className="ml-1 inline-flex items-center gap-1 text-slate-400"><Spinner /> 刷新中…</span> : null}
      </div>
    </div>
  );
}
