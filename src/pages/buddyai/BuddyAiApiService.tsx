import { useCallback, useEffect, useState } from 'react';
import { Loader2, Play, PowerOff, RefreshCw, Server, Globe } from 'lucide-react';
import { Badge, Spinner } from '../../components/ui';
import PageHeader from '../../components/PageHeader';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import { withMinDelay } from '../../lib/delay';
import type { ApiPoolFile } from '../../types';

/**
 * BuddyAI · 资源调度页（六页子导航对齐国内 Buddy「资源调度」）。
 *
 * 管控 buddy-ai 国际档网关调度：API 网关启停（统一网关，buddy-ai 档随网关
 * 对外暴露 /v1/models・/v1/chat/completions 等，Intl 静态目录已并入统一目录）+
 * buddy-ai 独立池开关（显式开启制）+ 会话粘性。
 * 保存口径与 Buddy/Qoder 资源调度页同构：uids/strategy/groups 原样回传防丢
 * （池快照未加载禁止保存——否则会把 Trae 池 enabled_uids 清空）。
 */
export default function BuddyAiApiService() {
  const pushToast = useAppStore((s) => s.pushToast);
  const apiStatus = useAppStore((s) => s.apiStatus);
  const [pool, setPool] = useState<ApiPoolFile | null>(null);
  const [flags, setFlags] = useState({ buddyAiEnabled: false, buddyAiStickyEnabled: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 网关启停 busy（与 store apiStatus 同步）
  const [gwBusy, setGwBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const pf = await api.apiServer.poolList().catch(() => null);
      setPool(pf);
      if (pf) {
        setFlags({
          buddyAiEnabled: pf.buddy_ai_enabled ?? false,
          buddyAiStickyEnabled: pf.buddy_ai_sticky_enabled ?? false,
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveFlags = async (next: { buddyAiEnabled: boolean; buddyAiStickyEnabled: boolean }) => {
    // 池配置未加载时禁止保存：uids/strategy/groups 原样回传依赖 pool 快照（同 Buddy 页防护）
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

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="BuddyAI · 资源调度"
        desc="buddy-ai 国际档网关调度 · 独立池开关 / 会话粘性 / 统一网关启停"
        actions={
          <button className="btn-outline inline-flex items-center gap-1.5" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Spinner /> : <RefreshCw size={14} />} 刷新
          </button>
        }
      />

      {/* API 网关状态卡 */}
      <div className="card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Server size={15} className="text-brand-500" />
            <span className="text-sm font-medium">统一 API 网关</span>
            <Badge tone={running ? 'green' : 'slate'}>
              {running ? `运行中 :${apiStatus?.port}` : '未启动'}
            </Badge>
          </div>
          <button
            className={running ? 'btn-outline inline-flex items-center gap-1.5' : 'btn-primary inline-flex items-center gap-1.5'}
            onClick={() => void toggleGateway()}
            disabled={gwBusy}
          >
            {gwBusy ? <Loader2 size={14} className="animate-spin" /> : running ? <PowerOff size={14} /> : <Play size={14} />}
            {running ? '停止网关' : '启动API网关'}
          </button>
        </div>
        <p className="text-[11px] leading-4 text-slate-400">
          网关运行时，buddy-ai 国际档模型随统一目录对外暴露（/v1/models 携带 buddy-ai 来源徽章，
          /v1/chat/completions・/v1/messages・/v1/responses 按模型路由国际池）。开关读取在网关启动后实时生效。
        </p>
      </div>

      {/* buddy-ai 调度开关卡 */}
      <div className="card mt-4 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Globe size={15} className="text-brand-500" />
          <span className="text-sm font-medium">buddy-ai 国际档调度</span>
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
                <span className="ml-1 text-xs text-slate-400">
                  开启后「buddy-ai」档参与调度（与国内 Buddy 档平级、独立账号池/粘性/记账）；需先在「账号管理」登录国际账号
                </span>
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
                <span className="ml-1 text-xs text-slate-400">
                  显式 conversationId 在国际池内绑定账号（TTL 同国内档口径）；默认关
                </span>
              </span>
            </label>
          </div>
        )}
        <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-500 dark:bg-zinc-900 dark:text-zinc-400">
          隔离说明：buddy-ai 档账号池 / 凭证存储（buddy-ai vault 命名空间）/ 模型冷却表 /
          用量记账（buddy_ai_days）/ 清洗模板全部独立于国内 Buddy 档，两侧上下文与额度互不影响。
        </div>
      </div>
    </div>
  );
}
