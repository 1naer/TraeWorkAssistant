import { useEffect, useRef, useState } from 'react';
import { Loader2, LogIn, RefreshCw } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { Badge } from '../../components/ui';
import PageHeader from '../../components/PageHeader';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import { withMinDelay } from '../../lib/delay';

/**
 * BuddyAI · 一键签到页（六页子导航对齐国内 Buddy「签到与成长」）。
 *
 * 每日活跃打卡（阶段 3b，tasks/buddy_ai_checkin.rs）：开关/时刻/间隔配置 +
 * 手动触发整轮 + NDJSON 进度（buddy-ai-checkin-progress 事件）+ 积分同步。
 * 打卡机制：网页会话 + 沙箱 ACP 六步链，服务端自动入账 30/50 积分（无 claim 端点）。
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

  // 打卡进度事件（NDJSON 契约对齐 BuddyCheckin：payload 为序列化 JSON 字符串）。
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
      } else if (parsed.index) {
        setLines((prev) => [...prev, `#${parsed.index} ${parsed.name ?? ''}：${parsed.status ?? ''} — ${parsed.message ?? ''}`]);
      } else if (parsed.type === 'exit') {
        setRunning(false);
      }
    });
    return () => {
      void un.then((f) => f());
    };
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

  const syncCredits = async () => {
    setSyncing(true);
    try {
      const n = await withMinDelay(api.buddyai.creditsFetch(), 800);
      pushToast('success', `积分已同步（${n.filter((a) => a.credits_balance != null).length} 个账号取数成功）`);
    } catch (err) {
      pushToast('error', `积分同步失败：${String(err).slice(0, 120)}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="BuddyAI · 一键签到"
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
            <button className="btn-outline inline-flex items-center gap-1.5" onClick={() => void syncCredits()} disabled={syncing}>
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> 同步积分
            </button>
          </>
        }
      />

      {/* 调度配置卡 */}
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
          轮次执行期间再次触发会被忙态跳过（skipped_busy）。模型钉死官方免费档（deepseek-v4.1-flash），不消耗付费额度。
        </p>
      </div>

      {/* 执行进度（NDJSON 逐账号结果） */}
      <div className="card mt-4 p-4">
        <div className="mb-2 text-sm font-medium">执行进度</div>
        {lines.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-400">
            暂无执行记录。点击右上角「立即打卡」发起一轮，或等待每日调度自动执行。
          </p>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto rounded-md bg-slate-50 p-3 font-mono text-[11px] leading-5 text-slate-600 dark:bg-zinc-900 dark:text-zinc-300">
            {lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
