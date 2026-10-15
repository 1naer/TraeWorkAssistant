import { Globe, Info } from 'lucide-react';

/**
 * BuddyAI（buddy-ai 国际版）概述页（阶段 1 池骨架占位）。
 *
 * 《Buddy国际版支持落地方案.md》阶段 1 已落地的后端能力：
 * - 独立池 `buddy-ai`（buddy_ai_accounts / buddy_ai_tokens 双表 + 独立 vault 命名空间）；
 * - Intl OAuth 登录命令（workbuddy.ai + platform=workbuddy-ai，R-1 全链路实测）；
 * - 手工导入凭证（区域必选校验）/ 凭证续期（R-2a 实测端点）/ 账号列表与移除命令；
 * - 存量迁移（wb 池混居的国际账号启动时一次性迁入）；
 * - healthz 四池 selectable（buddy-ai 开关默认关）。
 *
 * 阶段 2（网关转发）与阶段 3（运营面/前端分区 UI）按方案推进，
 * 本页届时替换为账号管理 / 打卡 / 积分完整分区界面。
 */
export default function BuddyAiHome() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pt-10">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow">
          <Globe size={22} />
        </div>
        <div>
          <h1 className="text-lg font-semibold">BuddyAI（国际版）</h1>
          <p className="text-xs text-slate-400">buddy-ai 独立池 · 与国内 Buddy 池完全隔离</p>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <Info size={15} className="text-slate-400" />
          池骨架已就绪
        </div>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-500 dark:text-zinc-400">
          <li>独立账号池与 token store（账号 / 凭证 / 锁 / 失败域六面隔离，不与国内池交织）</li>
          <li>国际版 OAuth 扫码登录（www.workbuddy.ai，platform=workbuddy-ai）与手工导入凭证通道</li>
          <li>凭证续期（refreshToken 轮换回写）、账号列表 / 移除管理命令</li>
          <li>存量混居国际账号启动时自动迁入本池（幂等 + 备份）</li>
          <li>网关「buddy-ai」档位（默认关，阶段 2 接线后可在资源调度页开启）</li>
        </ul>
      </div>

      <div className="card p-4 text-sm text-slate-500 dark:text-zinc-400">
        账号管理、每日活跃打卡与积分看板将在后续阶段于本页分区呈现；
        本应用的入口默认隐藏，可在 <b>系统设置 → 应用显示</b> 中勾选「BuddyAI」开启。
      </div>
    </div>
  );
}
