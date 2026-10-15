import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, LogIn, RefreshCw } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { Badge, StatCard } from '../../components/ui';
import PageHeader from '../../components/PageHeader';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import { withMinDelay } from '../../lib/delay';
import type { BuddyAiAccountView, WbCheckinRecord } from '../../types';

/**
 * BuddyAI · 活跃打卡页（P4 对齐国内 Buddy「签到与成长」，以每日活跃打卡替代签到逻辑）。
 *
 * 国际版机制（阶段 3b）：网页会话 + 沙箱 ACP 六步链跑一轮对话，官方服务端自动入账
 * 30/50 积分（无 claim 端点）——国内「成长中心（银行/翻倍）/ 签到点/签到策略 / UI
 * 模拟点击」为国内官网专属通道，国际版以「打卡积分统计 + 打卡日历」等效呈现。
 *
 * 数据源：buddy_ai_checkin_results（P2 落盘）+ buddy_ai_accounts_list 池快照。
 */
export default function BuddyAiCheckin() {
  const pushToast = useAppStore((s) => s.pushToast);
  const settings = useAppStore((s) => s.settings);
  const refreshSettings = useAppStore((s) => s.refreshSettings);
  const [enabled, setEnabled] = useState(false);
  const [hhmm, setHhmm] = useState('09:20');
  const [gap, setGap] = useState(3);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<BuddyAiAccountView[]>([]);
  const [records, setRecords] = useState<WbCheckinRecord[]>([]);
  // 日历当前月份（默认本月）
  const [calMonth, setCalMonth] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });

  const load = async () => {
    try {
      const [accs, recs] = await Promise.all([
        api.buddyai.accountsList().catch(() => [] as BuddyAiAccountView[]),
        api.buddyai.checkinResults(90).catch(() => [] as WbCheckinRecord[]),
      ]);
      setAccounts(accs);
      setRecords(recs);
    } catch (err) {
      pushToast('error', `数据加载失败：${String(err).slice(0, 120)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      await refreshSettings();
      pushToast('success', patch.enabled !== undefined
        ? (patch.enabled ? '已开启每日活跃打卡（按调度时刻自动执行）' : '已关闭每日活跃打卡')
        : '打卡配置已保存');
    } catch (err) {
      pushToast('error', `保存失败：${String(err).slice(0, 120)}`);
    } finally {
      setSaving(false);
    }
  };

  // 打卡进度事件（NDJSON 契约对齐国内：payload 为序列化 JSON 字符串）。
  // 挂载期注册一次（审查 L3：异步注册晚于 invoke 会丢 start/首个账号事件）；
  // running=false 期间到达的事件（调度器/启动补跑触发）直接丢弃
  const runningRef = useRef(false);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    const un = listen<string>('buddy-ai-checkin-progress', (ev) => {
      if (!runningRef.current) return;
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
        void load();
      } else if (parsed.index) {
        setLines((prev) => [...prev, `#${parsed.index} ${parsed.name ?? ''}：${parsed.status ?? ''} — ${parsed.message ?? ''}`]);
      } else if (parsed.type === 'exit') {
        setRunning(false);
      }
    });
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // ── 统计口径 ──
  const localDateStr = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const today = localDateStr(new Date());
  const totalEarned = useMemo(() => records.reduce((s, r) => s + (r.reward ?? 0), 0), [records]);
  const todayEarned = useMemo(
    () => records.filter((r) => r.date === today).reduce((s, r) => s + (r.reward ?? 0), 0),
    [records, today],
  );
  // 连续打卡天数（从今日/昨日向前，存在任一成功或已完成记录则连续）
  const streak = useMemo(() => {
    const okDays = new Set(records.filter((r) => r.status === 'success' || r.status === 'already').map((r) => r.date));
    let n = 0;
    const cur = new Date();
    if (!okDays.has(localDateStr(cur))) cur.setDate(cur.getDate() - 1); // 今日未打从昨日计
    while (okDays.has(localDateStr(cur))) {
      n += 1;
      cur.setDate(cur.getDate() - 1);
    }
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records]);

  // 今日每账号状态（records 终态优先，未打卡/停用兜底）
  const todayByUid = useMemo(() => {
    const m = new Map<string, WbCheckinRecord>();
    for (const r of records) if (r.date === today) m.set(r.user_id, r);
    return m;
  }, [records, today]);

  // 打卡日历（月历热图）：全成功=绿 / 部分成功=琥珀 / 有失败=玫瑰 / 无记录=灰
  const calCells = useMemo(() => {
    const first = new Date(calMonth.y, calMonth.m, 1);
    const daysInMonth = new Date(calMonth.y, calMonth.m + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // 周一为首列
    const cells: ({ day: number; date: string } | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ day: d, date: `${calMonth.y}-${String(calMonth.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}` });
    }
    return cells;
  }, [calMonth]);
  const dayStat = useMemo(() => {
    const m = new Map<string, { s: number; f: number; o: number }>();
    for (const r of records) {
      const v = m.get(r.date) ?? { s: 0, f: 0, o: 0 };
      if (r.status === 'success') v.s += 1;
      else if (r.status === 'fail') v.f += 1;
      else v.o += 1;
      m.set(r.date, v);
    }
    return m;
  }, [records]);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="BuddyAI · 活跃打卡"
        desc="每日活跃打卡（官方 30/50 积分）· 网页会话 + 沙箱跑一轮对话，服务端自动入账"
        actions={
          <>
            <button
              className="btn-primary inline-flex items-center gap-1.5"
              disabled={running}
              onClick={() => void startCheckin()}
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
              {running ? '打卡中…' : '立即打卡'}
            </button>
            <button className="btn-outline inline-flex items-center gap-1.5" onClick={() => void load()}>
              <RefreshCw size={14} /> 刷新
            </button>
          </>
        }
      />

      {/* 打卡积分统计（国内「成长中心」等效位） */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="累计打卡获得" value={totalEarned > 0 ? totalEarned.toFixed(0) : '—'} hint="近 90 天打卡积分合计" tone="green" />
        <StatCard label="今日获得" value={todayEarned > 0 ? todayEarned.toFixed(0) : '0'} hint="今日各账号打卡积分合计" tone="amber" />
        <StatCard label="连续打卡" value={`${streak} 天`} hint="存在成功/已完成记录的连续天数" tone="brand" />
        <StatCard
          label="参与账号"
          value={`${accounts.filter((a) => !a.disabled && a.has_credential).length}/${accounts.length}`}
          hint="可用 / 池内总数（停用不参与）"
          tone="slate"
        />
      </div>

      {/* 今日打卡状态表（对齐国内一键签到账号表） */}
      <div className="card mt-4 overflow-x-auto p-4">
        <div className="mb-2 text-sm font-medium">今日打卡状态</div>
        {accounts.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-400">暂无国际账号，先到「账号管理」扫码登录或导入凭证。</p>
        ) : (
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400 dark:border-zinc-800">
                <th className="py-2 pr-3 font-medium">账号</th>
                <th className="py-2 pr-3 font-medium">打卡状态</th>
                <th className="py-2 pr-3 font-medium">完成时间</th>
                <th className="py-2 pr-3 font-medium">获得积分</th>
                <th className="py-2 pr-3 font-medium">可用积分</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const rec = todayByUid.get(a.id);
                return (
                  <tr key={a.id} className="border-b border-slate-50 last:border-0 dark:border-zinc-800/50">
                    <td className="py-2.5 pr-3">
                      <div className="font-medium">{a.nickname || a.id}</div>
                      <div className="text-[11px] text-slate-400">{a.uid || a.id}</div>
                    </td>
                    <td className="py-2.5 pr-3">
                      {a.disabled ? (
                        <Badge tone="slate">已停用</Badge>
                      ) : rec?.status === 'success' ? (
                        <Badge tone="green">打卡成功</Badge>
                      ) : rec?.status === 'already' ? (
                        <Badge tone="blue">今日已完成</Badge>
                      ) : rec?.status === 'fail' ? (
                        <Badge tone="red">打卡失败</Badge>
                      ) : !a.has_credential ? (
                        <Badge tone="red">无凭证</Badge>
                      ) : a.needs_relogin ? (
                        <Badge tone="amber">需重新登录</Badge>
                      ) : (
                        <Badge tone="slate">待打卡</Badge>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-xs tabular-nums text-slate-500">{rec?.time || '—'}</td>
                    <td className="py-2.5 pr-3 tabular-nums">
                      {rec?.reward != null ? <span className="text-emerald-500">+{rec.reward.toFixed(0)}</span> : '—'}
                    </td>
                    <td className="py-2.5 pr-3 tabular-nums">
                      {a.credits_balance != null ? a.credits_balance.toFixed(2) : <span className="text-xs text-slate-400">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 活动打卡日历（对齐国内「活动签到日历」交互：月历热图 + 月份切换） */}
        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium">活动打卡日历</span>
            <div className="flex items-center gap-1">
              <button
                className="btn-ghost p-1"
                onClick={() =>
                  setCalMonth((prev) => (prev.m === 0 ? { y: prev.y - 1, m: 11 } : { y: prev.y, m: prev.m - 1 }))
                }
              >
                <ChevronLeft size={15} />
              </button>
              <span className="text-xs tabular-nums text-slate-500">
                {calMonth.y} 年 {calMonth.m + 1} 月
              </span>
              <button
                className="btn-ghost p-1"
                onClick={() =>
                  setCalMonth((prev) => (prev.m === 11 ? { y: prev.y + 1, m: 0 } : { y: prev.y, m: prev.m + 1 }))
                }
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-slate-400">
            {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
              <div key={d}>{d}</div>
            ))}
            {calCells.map((c, i) => {
              if (!c) return <div key={`e${i}`} />;
              const st = dayStat.get(c.date);
              const cls = st
                ? st.f > 0 && st.s === 0
                  ? 'bg-rose-500/15 text-rose-500'
                  : st.s > 0
                    ? 'bg-emerald-500/15 text-emerald-500'
                    : 'bg-amber-500/15 text-amber-500'
                : 'text-slate-400';
              return (
                <div key={c.date} className={`rounded-md px-1 py-1.5 ${cls}`} title={st ? `成功 ${st.s} · 失败 ${st.f}` : '无打卡记录'}>
                  <div className="tabular-nums">{c.day}</div>
                  {st ? (
                    <div className="mt-0.5 flex justify-center gap-0.5">
                      {st.s > 0 && <span className="h-1 w-1 rounded-full bg-emerald-500" />}
                      {st.o > 0 && <span className="h-1 w-1 rounded-full bg-amber-500" />}
                      {st.f > 0 && <span className="h-1 w-1 rounded-full bg-rose-500" />}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] leading-4 text-slate-400">
            <span className="text-emerald-500">●</span> 当日有打卡成功　
            <span className="text-amber-500">●</span> 仅跳过/已完成　
            <span className="text-rose-500">●</span> 有失败
          </p>
        </div>

        {/* 定时配置 + 执行进度 */}
        <div className="space-y-4">
          <div className="card p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-medium">每日自动打卡</span>
              {enabled ? <Badge tone="green">已开启</Badge> : <Badge tone="amber">未开启</Badge>}
              {saving && <span className="text-xs text-slate-400">保存中…</span>}
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
                按调度时刻自动执行
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
            </div>
            <p className="mt-2 text-[11px] leading-4 text-slate-400">
              幂等：每账号当日成功打卡一次（凭证记录 last_daily_chat 落盘），重复触发自动跳过已完成账号；
              停用账号不参与打卡；模型钉死官方免费档（deepseek-v4.1-flash），不消耗付费额度。
            </p>
          </div>

          <div className="card p-4">
            <div className="mb-2 text-sm font-medium">执行进度</div>
            {lines.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-400">
                暂无执行记录。点击右上角「立即打卡」发起一轮，或等待每日调度自动执行。
              </p>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-md bg-slate-50 p-3 font-mono text-[11px] leading-5 text-slate-600 dark:bg-zinc-900 dark:text-zinc-300">
                {lines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
