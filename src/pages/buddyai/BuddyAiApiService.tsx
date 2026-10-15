import { useCallback, useEffect, useState } from 'react';
import { Loader2, Play, PowerOff, RefreshCw, Server, Globe, AlertTriangle } from 'lucide-react';
import { Badge, Spinner, StatCard } from '../../components/ui';
import PageHeader from '../../components/PageHeader';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import { withMinDelay } from '../../lib/delay';
import type { ApiPoolFile, BuddyAiAccountView, WbModelInfo } from '../../types';

/**
 * BuddyAI · 资源调度页（P6 对齐国内 Buddy「资源调度」）。
 *
 * 调度状态横幅（未启用国际档时提示 + 一键开启）+ 统计卡（调度账号/今日启用/池内
 * 账号）+ 账号调度池（复选启停，复用 buddy_ai_account_toggle）+ buddy-ai 调度
 * 参数（开关/会话粘性，poolSet 快照回传防丢）+ 国际档模型目录表（§4.4 静态配置）。
 */
export default function BuddyAiApiService() {
  const pushToast = useAppStore((s) => s.pushToast);
  const apiStatus = useAppStore((s) => s.apiStatus);
  const [pool, setPool] = useState<ApiPoolFile | null>(null);
  const [accounts, setAccounts] = useState<BuddyAiAccountView[]>([]);
  const [catalog, setCatalog] = useState<WbModelInfo[]>([]);
  const [flags, setFlags] = useState<{
    buddyAiEnabled: boolean;
    buddyAiStickyEnabled: boolean;
    buddyAiPoolStickyTtlSecs?: number;
  }>({ buddyAiEnabled: false, buddyAiStickyEnabled: false });
  const [poolTtl, setPoolTtl] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rowOp, setRowOp] = useState<string | null>(null);
  const [gwBusy, setGwBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [pf, accs, cat] = await Promise.all([
        api.apiServer.poolList().catch((e) => {
          // FM-1 审查修复：池配置加载失败必须可见（原静默吞掉 → 横幅显示「未启用」
          // 假态，点一键开启又报池未加载，用户无从分辨）
          pushToast('error', `池配置加载失败：${String(e).slice(0, 120)}`);
          return null;
        }),
        api.buddyai.accountsList().catch((e) => {
          pushToast('error', `账号列表加载失败：${String(e).slice(0, 120)}`);
          return [] as BuddyAiAccountView[];
        }),
        api.apiServer.buddyAiCatalogList().catch(() => [] as WbModelInfo[]),
      ]);
      setPool(pf);
      setAccounts(accs);
      setCatalog(cat);
      if (pf) {
        setFlags({
          buddyAiEnabled: pf.buddy_ai_enabled ?? false,
          buddyAiStickyEnabled: pf.buddy_ai_sticky_enabled ?? false,
        });
        setPoolTtl(pf.buddy_ai_pool_sticky_ttl_secs ?? 0);
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveFlags = async (next: {
    buddyAiEnabled: boolean;
    buddyAiStickyEnabled: boolean;
    buddyAiPoolStickyTtlSecs?: number;
  }) => {
    if (!pool) {
      pushToast('error', '池配置未加载，无法保存（请先刷新重试）');
      return;
    }
    setSaving(true);
    try {
      await withMinDelay(
        api.apiServer.poolSet(pool.enabled_uids, pool.strategy, pool.group_ids, next),
        400,
      );
      setFlags(next);
      pushToast(
        'success',
        next.buddyAiEnabled ? 'buddy-ai 国际档已开启（独立池参与调度）' : '已保存 buddy-ai 调度配置',
      );
    } catch (err) {
      pushToast('error', `保存失败：${String(err).slice(0, 160)}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleAccount = async (a: BuddyAiAccountView) => {
    setRowOp(a.id);
    try {
      await withMinDelay(api.buddyai.accountToggle(a.id, !a.disabled), 400);
      pushToast('success', a.disabled ? `已启用 ${a.nickname || a.id}` : `已停用 ${a.nickname || a.id}`);
      await refresh();
    } catch (err) {
      pushToast('error', `启停失败：${String(err).slice(0, 120)}`);
    } finally {
      setRowOp(null);
    }
  };

  const toggleGateway = async () => {
    if (gwBusy) return;
    const running = apiStatus?.running ?? false;
    setGwBusy(true);
    try {
      if (running) {
        await api.apiServer.stop();
        useAppStore.setState({ apiStatus: null });
        pushToast('info', 'API 网关已停止');
      } else {
        const s = await api.apiServer.start();
        useAppStore.setState({ apiStatus: s });
        pushToast('success', `API 网关已启动（端口 ${s.port}）`);
      }
    } catch (e) {
      pushToast('error', `API 网关${running ? '停止' : '启动'}失败：${String(e)}`);
    } finally {
      setGwBusy(false);
    }
  };

  const running = apiStatus?.running ?? false;
  const dispatchable = accounts.filter((a) => !a.disabled && a.has_credential && !a.needs_relogin);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="BuddyAI · 资源调度"
        desc="buddy-ai 国际档网关调度 · 独立池开关 / 会话粘性 / 账号调度池"
        actions={
          <button className="btn-outline inline-flex items-center gap-1.5" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Spinner /> : <RefreshCw size={14} />} 刷新
          </button>
        }
      />

      {/* 调度状态横幅（对齐国内「调度状态总览」） */}
      {!flags.buddyAiEnabled ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/30 dark:bg-amber-500/10">
          <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
            <AlertTriangle size={16} />
            <span>
              国际档调度未启用——BuddyAI 独立池未参与网关路由。开启后「buddy-ai」档与国内 Buddy 档平级调度、互不影响。
            </span>
          </div>
          <button
            className="btn-primary shrink-0"
            disabled={saving}
            onClick={() => void saveFlags({ ...flags, buddyAiEnabled: true })}
          >
            一键开启
          </button>
        </div>
      ) : null}

      {/* 统计卡（对齐国内三卡） */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="调度账号"
          value={dispatchable.length}
          hint={flags.buddyAiEnabled ? '国际档已启用' : '国际档未启用'}
          tone={flags.buddyAiEnabled ? 'green' : 'slate'}
        />
        <StatCard label="今日启用" value={dispatchable.length} hint="当前可取号账号数" tone="brand" />
        <StatCard label="池内账号" value={accounts.length} hint={`停用 ${accounts.filter((a) => a.disabled).length} · 需重登 ${accounts.filter((a) => a.needs_relogin).length}`} tone="slate" />
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Server size={15} className="text-brand-500" />
              <span className="text-sm font-medium">API 网关</span>
              <Badge tone={running ? 'green' : 'slate'}>{running ? `运行中 :${apiStatus?.port}` : '未启动'}</Badge>
            </div>
            <button
              className={running ? 'btn-outline inline-flex items-center gap-1.5 text-xs' : 'btn-primary inline-flex items-center gap-1.5 text-xs'}
              onClick={() => void toggleGateway()}
              disabled={gwBusy}
            >
              {gwBusy ? <Loader2 size={13} className="animate-spin" /> : running ? <PowerOff size={13} /> : <Play size={13} />}
              {running ? '停止' : '启动'}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 账号调度池（对齐国内账号调度列表） */}
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3 dark:border-zinc-800">
            <div className="text-sm font-medium">账号调度池</div>
            <p className="text-[11px] text-slate-500">启用/停用即插即拔：停用账号即刻退出打卡与网关取号（与「账号管理」同源）。</p>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {accounts.length === 0 ? (
              <p className="py-8 text-center text-xs text-slate-400">暂无账号，先到「账号管理」导入。</p>
            ) : (
              accounts.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3 border-b border-slate-50 px-4 py-2.5 last:border-0 dark:border-zinc-800/50">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      className="mt-0"
                      checked={!a.disabled}
                      disabled={rowOp === a.id}
                      onChange={() => void toggleAccount(a)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{a.nickname || a.id}</span>
                      <span className="text-[11px] text-slate-400">
                        {a.uid || a.id}
                        {a.credits_balance != null ? ` · ${a.credits_balance.toFixed(0)} 积分` : ''}
                      </span>
                    </span>
                  </label>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {a.needs_relogin ? <Badge tone="amber">需重登</Badge> : !a.has_credential ? <Badge tone="red">无凭证</Badge> : null}
                    {a.disabled ? (
                      <Badge tone="slate">已停用</Badge>
                    ) : (
                      <Badge tone="green">启用</Badge>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* buddy-ai 调度参数（对齐国内「资源开关与调度参数」国际档分区） */}
        <div className="card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Globe size={15} className="text-brand-500" />
            <span className="text-sm font-medium">buddy-ai 调度参数</span>
            {flags.buddyAiEnabled ? <Badge tone="green">已开启</Badge> : <Badge tone="amber">未开启</Badge>}
            {saving && <span className="text-xs text-slate-400">保存中…</span>}
          </div>
          {loading ? (
            <div className="py-4 text-center text-xs text-slate-400">加载中…</div>
          ) : (
            <div className="space-y-2.5">
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={flags.buddyAiEnabled}
                  onChange={(e) => void saveFlags({ ...flags, buddyAiEnabled: e.target.checked })}
                />
                <span>
                  启用 buddy-ai 国际档
                  <span className="ml-1 text-xs text-slate-400">开启后「buddy-ai」档参与调度（独立账号池/粘性/记账）</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={flags.buddyAiStickyEnabled}
                  onChange={(e) => void saveFlags({ ...flags, buddyAiStickyEnabled: e.target.checked })}
                />
                <span>
                  buddy-ai 会话粘性
                  <span className="ml-1 text-xs text-slate-400">显式 conversationId 在国际池内绑定账号；默认关</span>
                </span>
              </label>
              <div className="flex items-center gap-2 pl-6 text-xs text-slate-500">
                池粘性 TTL
                <input
                  type="number"
                  min={60}
                  max={86400}
                  className="w-24 rounded-md border border-slate-200 bg-transparent px-2 py-1 text-right text-xs tabular-nums focus:border-brand-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
                  value={poolTtl}
                  onChange={(e) => setPoolTtl(Number(e.target.value))}
                  onBlur={() => {
                    const clamped = Math.min(Math.max(Math.round(poolTtl || 0), 60), 86400);
                    setPoolTtl(clamped);
                    void saveFlags({ ...flags, buddyAiPoolStickyTtlSecs: clamped });
                  }}
                />
                秒
                <span className="text-[11px] text-slate-400">（粘性绑定有效期，60s–24h）</span>
              </div>
            </div>
          )}
          <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-500 dark:bg-zinc-900 dark:text-zinc-400">
            隔离说明：buddy-ai 档账号池 / 凭证存储（buddy-ai vault 命名空间）/ 模型冷却 /
            用量记账（buddy_ai_days）/ 清洗模板全部独立于国内 Buddy 档。
          </div>
        </div>
      </div>

      {/* 国际档模型目录（对齐国内「同步官网模型」表格；静态配置原则） */}
      <div className="card mt-4 overflow-x-auto p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">国际档模型目录</span>
          <span className="text-[11px] text-slate-400">静态配置（§4.4）· 倍率占位待官网核对回填</span>
        </div>
        {catalog.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-400">目录未加载</p>
        ) : (
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400 dark:border-zinc-800">
                <th className="py-2 pr-3 font-medium">模型 ID</th>
                <th className="py-2 pr-3 font-medium">展示名</th>
                <th className="py-2 pr-3 font-medium">积分倍率</th>
                <th className="py-2 pr-3 font-medium">思考档位</th>
                <th className="py-2 pr-3 font-medium">上下文</th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((m) => (
                <tr key={m.id} className="border-b border-slate-50 last:border-0 dark:border-zinc-800/50">
                  <td className="py-2 pr-3 font-mono text-xs">{m.id}</td>
                  <td className="py-2 pr-3 text-xs">{m.display || m.id}</td>
                  <td className="py-2 pr-3 text-xs tabular-nums">{m.rate.toFixed(2)}x</td>
                  <td className="py-2 pr-3 text-xs text-slate-500">
                    {m.supported_efforts?.length ? m.supported_efforts.join(' / ') : '—'}
                  </td>
                  <td className="py-2 pr-3 text-xs tabular-nums text-slate-500">
                    {m.context_length > 0 ? `${Math.round(m.context_length / 1000)}k` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
