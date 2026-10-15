import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, MonitorCheck, MonitorX } from 'lucide-react';
import { Badge } from '../../components/ui';
import PageHeader from '../../components/PageHeader';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import type { AppLocate } from '../../types';

/**
 * BuddyAI · 环境配置页（六页子导航对齐国内 Buddy「环境配置」）。
 *
 * 内容：应用入口可见性（系统设置 opt-in 同源开关）+ 国际客户端检测与打开
 * （WorkBuddy AI @ Programs\WorkBuddyAI / CodeBuddy AI @ Programs\CodeBuddy，
 * 与国内客户端为不同安装目录，P1 审查修复走独立探测档案）+
 * 数据隔离与配置说明。打卡调度配置归「一键签到」页，不在此重复。
 */
export default function BuddyAiSettings() {
  const pushToast = useAppStore((s) => s.pushToast);
  const settings = useAppStore((s) => s.settings);
  const refreshSettings = useAppStore((s) => s.refreshSettings);
  const [visible, setVisible] = useState(false);
  const [savingVisible, setSavingVisible] = useState(false);
  const [wbLocate, setWbLocate] = useState<AppLocate | null>(null);
  const [cbLocate, setCbLocate] = useState<AppLocate | null>(null);
  const [launching, setLaunching] = useState<'wb' | 'cb' | null>(null);

  useEffect(() => {
    setVisible(settings?.buddy_ai_visible === true);
  }, [settings]);

  useEffect(() => {
    let alive = true;
    api.env
      .locate('workbuddy_ai')
      .then((r) => alive && setWbLocate(r))
      .catch(() => {});
    api.env
      .locate('codebuddy_ai')
      .then((r) => alive && setCbLocate(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const saveVisible = async (next: boolean) => {
    setSavingVisible(true);
    try {
      await api.misc.settingsSet({ buddy_ai_visible: next });
      await refreshSettings();
      setVisible(next);
      pushToast('success', next ? 'BuddyAI 应用入口已显示（侧边栏应用 Tab）' : 'BuddyAI 应用入口已隐藏');
    } catch (err) {
      pushToast('error', `保存失败：${String(err).slice(0, 120)}`);
    } finally {
      setSavingVisible(false);
    }
  };

  const launchApp = async (which: 'wb' | 'cb') => {
    if (launching) return;
    const label = which === 'wb' ? 'WorkBuddy AI' : 'CodeBuddy AI';
    setLaunching(which);
    try {
      if (which === 'wb') await api.env.openWorkbuddyAiApp();
      else await api.env.openCodebuddyAiApp();
      pushToast('success', `已启动 ${label}`);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('未检测到')) pushToast('warn', msg);
      else pushToast('error', `打开 ${label} 失败：${msg}`);
    } finally {
      setLaunching(null);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="BuddyAI · 环境配置"
        desc="应用入口可见性 · 国际客户端检测与打开 · 隔离与配置说明"
      />

      {/* 应用入口可见性 */}
      <div className="card p-4">
        <div className="text-sm font-medium">应用入口</div>
        <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={visible}
            disabled={savingVisible}
            onChange={(e) => void saveVisible(e.target.checked)}
          />
          <span>
            在侧边栏显示 BuddyAI 应用 Tab
            <span className="ml-1 text-xs text-slate-400">（与系统设置 → 应用显示 同源；关闭后本应用默认回落 Trae）</span>
          </span>
        </label>
      </div>

      {/* 国际客户端检测 */}
      <div className="card mt-4 p-4">
        <div className="mb-3 text-sm font-medium">国际客户端</div>
        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {wbLocate?.exe ? (
                <Badge tone="green" title={wbLocate.version ? `WorkBuddy AI 当前版本：v${wbLocate.version}（${wbLocate.exe}）` : wbLocate.exe}>
                  <MonitorCheck size={13} /> WorkBuddy AI已安装
                </Badge>
              ) : (
                <Badge tone="red">
                  <MonitorX size={13} /> WorkBuddy AI未检测到
                </Badge>
              )}
              <span className="text-xs text-slate-400">国际版客户端（Programs\WorkBuddyAI，登录 workbuddy.ai，与国内 WorkBuddy 为不同安装）</span>
            </div>
            <button className="btn-outline inline-flex items-center gap-1.5 text-xs" onClick={() => void launchApp('wb')} disabled={launching != null}>
              {launching === 'wb' ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />} 打开
            </button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {cbLocate?.exe ? (
                <Badge tone="green" title={cbLocate.version ? `CodeBuddy AI 当前版本：v${cbLocate.version}（${cbLocate.exe}）` : cbLocate.exe}>
                  <MonitorCheck size={13} /> CodeBuddy AI已安装
                </Badge>
              ) : (
                <Badge tone="red">
                  <MonitorX size={13} /> CodeBuddy AI未检测到
                </Badge>
              )}
              <span className="text-xs text-slate-400">codebuddy 客户端（国际域登录态）</span>
            </div>
            <button className="btn-outline inline-flex items-center gap-1.5 text-xs" onClick={() => void launchApp('cb')} disabled={launching != null}>
              {launching === 'cb' ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />} 打开
            </button>
          </div>
        </div>
      </div>

      {/* 配置说明 */}
      <div className="card mt-4 p-4 text-xs leading-5 text-slate-500 dark:text-zinc-400">
        <div className="mb-1 text-sm font-medium text-slate-700 dark:text-zinc-200">配置说明</div>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            每日活跃打卡的开关 / 时刻 / 账号间隔在 <b>一键签到</b> 页配置；调度器按每日时刻触发，幂等跳过当日已完成账号。
          </li>
          <li>
            国际档调度开关（buddy-ai 独立池参与网关路由）在 <b>资源调度</b> 页开启；需先完成国际账号登录入池。
          </li>
          <li>
            数据隔离：buddy-ai 独立池使用独立账号表 / 凭证 vault 命名空间 / 模型冷却 / 用量记账，与国内 Buddy 档零共享。
          </li>
          <li>
            抓包代理与 API 网关按钮在顶栏（与其他应用同构）；网关启动后 /v1/models 即可见国际档模型目录。
          </li>
        </ul>
      </div>
    </div>
  );
}
