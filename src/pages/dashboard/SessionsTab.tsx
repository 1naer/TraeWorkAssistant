import { useEffect, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { Badge, EmptyState } from '../../components/ui';
import { api } from '../../lib/tauri';
import { fmtCredits, fmtTokens } from '../../lib/format';
import { useAppStore } from '../../store';
import type { UsageSessionsResult } from '../../types';
import type { PlatformScope } from './KpiRow';

/**
 * 会话明细 Tab（issue #82）：
 * 展示会话级明细行——时间 / 账号 / 会话说明 / 模型 / 消耗积分 / 消耗 token 等。
 * Trae 数据源为官网 query_user_usage_group_by_session 会话行缓存（纯缓存零网络）；
 * Buddy 数据源为官网请求级计费明细落盘（get-user-request-usage，随官方用量拉取保鲜），
 * 上游无 token/会话说明字段 → 相应列显示 '—'；Qoder 官网未提供会话级明细 → 空态说明。
 */

const PAGE_SIZE = 50;

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function SessionsTab({
  scope,
  accountOptions,
  refreshKey,
}: {
  scope: PlatformScope;
  /** 账号筛选下拉（Trae=vault 账号；Buddy=积分接口账号清单） */
  accountOptions: { user_id: string; name: string }[];
  /** 全局刷新联动键：看板「刷新数据」完成后 +1，触发重查缓存 */
  refreshKey: number;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  // 会话概述显示开关（issue #82 T6.1）：settings 未加载/缺字段时按默认开处理
  const showPreview = useAppStore((s) => s.settings?.sessions_preview_enabled) !== false;
  const [start, setStart] = useState(() => fmtDate(new Date(Date.now() - 6 * 86400_000)));
  const [end, setEnd] = useState(() => fmtDate(new Date()));
  const [model, setModel] = useState('');
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<UsageSessionsResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (scope === 'qoder') return;
    let cancelled = false;
    setLoading(true);
    const fetchFn = scope === 'buddy' ? api.workbuddy.usageSessions : api.accounts.usageSessions;
    fetchFn({
      start,
      end,
      model: model || null,
      userId: userId || null,
      page,
      pageSize: PAGE_SIZE,
    })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((err) => {
        if (!cancelled) {
          setData(null);
          pushToast('error', `会话明细查询失败：${String(err)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, start, end, model, userId, page, refreshKey, pushToast]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const setRange = (days: number) => {
    setStart(fmtDate(new Date(Date.now() - days * 86400_000)));
    setEnd(fmtDate(new Date()));
    setPage(1);
  };

  if (scope === 'qoder') {
    return (
      <EmptyState
        icon={<MessagesSquare size={22} />}
        title="该平台暂无会话明细数据源"
        hint="Qoder 官网未提供会话级消耗明细接口；Trae / Buddy 页可查看明细（时间 / 账号 / 模型 / 消耗积分）。"
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* 筛选行：日期区间 + 快捷区间 + 账号 / 模型下拉 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">筛选</span>
        <input
          type="date"
          value={start}
          onChange={(e) => {
            setStart(e.target.value);
            setPage(1);
          }}
          className="input !py-1.5 !text-xs w-36"
        />
        <span className="text-xs text-slate-400">至</span>
        <input
          type="date"
          value={end}
          onChange={(e) => {
            setEnd(e.target.value);
            setPage(1);
          }}
          className="input !py-1.5 !text-xs w-36"
        />
        <button className="chip border" onClick={() => setRange(6)}>
          近 7 天
        </button>
        <button className="chip border" onClick={() => setRange(29)}>
          近 30 天
        </button>
        <select
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setPage(1);
          }}
          className="input !w-auto !py-1 text-xs"
        >
          <option value="">全部账号</option>
          {accountOptions.map((a) => (
            <option key={a.user_id} value={a.user_id}>
              {a.name || a.user_id}
            </option>
          ))}
        </select>
        <select
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setPage(1);
          }}
          className="input !w-auto !py-1 text-xs"
        >
          <option value="">全部模型</option>
          {(data?.models ?? []).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {loading && <span className="text-xs text-slate-400">加载中…</span>}
      </div>

      {data && data.total === 0 ? (
        // fetched_at > 0 表示已成功拉取过缓存：total===0 属筛选后无结果，不再引导刷新（审查 P4）
        <EmptyState
          icon={<MessagesSquare size={22} />}
          title="暂无会话明细"
          hint={
            data.fetched_at > 0
              ? '当前筛选条件下暂无会话记录，可调整时间范围、账号或模型后重试。'
              : '点击右上角「刷新数据」拉取消耗明细后查看；仅展示已拉取缓存窗口内的会话。'
          }
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-zinc-800">
            <h3 className="font-medium">会话明细</h3>
            <span className="text-xs text-slate-400">
              {data
                ? `共 ${data.total.toLocaleString()} 条会话 · 区间合计 ${fmtCredits(data.credits_total)} 积分`
                : ''}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-2 text-left">时间</th>
                  <th className="px-4 py-2 text-left">账号</th>
                  <th className="px-4 py-2 text-left">会话说明</th>
                  <th className="px-4 py-2 text-left">模型</th>
                  <th className="px-4 py-2 text-right">消耗积分</th>
                  <th
                    className="px-4 py-2 text-right"
                    title="输入 / 输出 token（悬停查看精确值）"
                  >
                    Token (入/出)
                  </th>
                  <th
                    className="px-4 py-2 text-right"
                    title="缓存读 / 缓存写 token（悬停查看精确值）"
                  >
                    缓存 (读/写)
                  </th>
                  <th className="px-4 py-2 text-right">费用</th>
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((r) => (
                  <tr
                    key={`${r.user_id}-${r.session_id}-${r.ts}`}
                    className="row-hover border-t border-slate-200 dark:border-zinc-800"
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-xs tabular-nums text-slate-500">
                      {fmtTime(r.ts)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs">
                      {r.account_name || r.user_id}
                    </td>
                    {/* 概述开关关闭（T6.1）时仅隐藏展示（显示 '—'），不动缓存与查询 */}
                    <td
                      className="max-w-[260px] truncate px-4 py-2 text-xs"
                      title={showPreview ? r.preview : undefined}
                    >
                      {showPreview ? r.preview || '—' : '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        <span>{r.model}</span>
                        {r.mode && (
                          <Badge tone="slate" title="会话模式">
                            {r.mode}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right text-xs tabular-nums">
                      {fmtCredits(r.credits)}
                    </td>
                    <td
                      className="px-4 py-2 text-right text-xs tabular-nums text-slate-500"
                      title={
                        r.input_tokens || r.output_tokens
                          ? `输入 ${r.input_tokens.toLocaleString()} / 输出 ${r.output_tokens.toLocaleString()}`
                          : undefined
                      }
                    >
                      {/* Buddy 官网行级明细无 token 字段 → 显示 '—'（无数据留空口径） */}
                      {r.input_tokens || r.output_tokens
                        ? `${fmtTokens(r.input_tokens)} / ${fmtTokens(r.output_tokens)}`
                        : '—'}
                    </td>
                    <td
                      className="px-4 py-2 text-right text-xs tabular-nums text-slate-400"
                      title={
                        r.cache_read_tokens || r.cache_write_tokens
                          ? `缓存读 ${r.cache_read_tokens.toLocaleString()} / 缓存写 ${r.cache_write_tokens.toLocaleString()}`
                          : undefined
                      }
                    >
                      {r.cache_read_tokens || r.cache_write_tokens
                        ? `${fmtTokens(r.cache_read_tokens)} / ${fmtTokens(r.cache_write_tokens)}`
                        : '—'}
                    </td>
                    <td className="px-4 py-2 text-right text-xs tabular-nums text-slate-500">
                      {r.cost_money > 0 ? `$${r.cost_money.toFixed(4)}` : '—'}
                    </td>
                  </tr>
                ))}
                {data && data.rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-xs text-slate-400">
                      当前筛选条件下无会话记录
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {/* 分页 */}
          <div className="flex items-center justify-between border-t border-slate-100 px-5 py-2.5 dark:border-zinc-800">
            <span className="text-xs text-slate-400">
              第 {data?.page ?? 1} / {totalPages} 页 · 每页 {PAGE_SIZE} 条
            </span>
            <div className="flex gap-2">
              <button
                className="btn-outline !px-2.5 !py-1 text-xs"
                disabled={loading || (data?.page ?? 1) <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <button
                className="btn-outline !px-2.5 !py-1 text-xs"
                disabled={loading || !data || data.page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
