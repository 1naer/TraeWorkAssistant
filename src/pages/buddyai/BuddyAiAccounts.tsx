import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshCw,
  Globe,
  LogIn,
  KeyRound,
  Trash2,
  Loader2,
  RotateCcw,
  Power,
  PowerOff,
  Pencil,
  Download,
  CircleHelp,
  FolderCog,
  Tags,
  Copy,
  Package,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { Badge, EmptyState, Modal, Spinner } from '../../components/ui';
import PageHeader from '../../components/PageHeader';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import { withMinDelay } from '../../lib/delay';
import { GroupsModal } from '../accounts/GroupsModal';
import { TagChips } from '../accounts/TagSelect';
import { AccountTagsEditModal, TagsModal } from '../accounts/TagsModal';
import { BuddyAiHelpModal } from './HelpModal';
import type { BuddyAiAccountView, GroupView, TagView, WbCheckinRecord, WbOauthDone, WbOauthProgress } from '../../types';

/**
 * BuddyAI（buddy-ai 国际版）账号管理页（P3 对齐国内 Buddy 账号管理）。
 *
 * 列对齐：账号（昵称+uid）/ 分组（共享分组下拉）/ 备注 / 积分 / TOKEN 到期 /
 * 凭证状态 / 启停 / 操作（编辑·启停·续期·移除）+ 批量勾选移除。
 * 国际不适用项（不展示）：每日目标 / 休假锁单 / 签到策略（intl 打卡为 ACP 链，
 * 无 UI 签到通道与签到点概念）。
 *
 * §3.4 隔离清单：本页所有命令走 buddy_ai_* 独立池；OAuth 事件前缀 buddy-ai-oauth-*。
 */

type ConfirmTarget =
  | { kind: 'remove-account'; account: BuddyAiAccountView }
  | { kind: 'remove-batch'; ids: string[] }
  | null;

export default function BuddyAiAccounts() {
  const pushToast = useAppStore((s) => s.pushToast);
  const [accounts, setAccounts] = useState<BuddyAiAccountView[] | null>(null);
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowOp, setRowOp] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  // OAuth 弹框
  const [oauthOpen, setOauthOpen] = useState(false);
  const [oauthStage, setOauthStage] = useState('');
  const [oauthMessage, setOauthMessage] = useState('');
  const [oauthAuthUrl, setOauthAuthUrl] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  // 手工导入弹框
  const [importOpen, setImportOpen] = useState(false);
  const [importName, setImportName] = useState('');
  const [importAccess, setImportAccess] = useState('');
  const [importRefresh, setImportRefresh] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const importAccessRef = useRef<HTMLInputElement>(null);
  // 编辑弹框（昵称/备注）
  const [editTarget, setEditTarget] = useState<BuddyAiAccountView | null>(null);
  const [editName, setEditName] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  // 导出弹框（P8：默认脱敏；附带凭证副本需强确认——导出文件等同密码）
  const [exportOpen, setExportOpen] = useState(false);
  const [exportWithCreds, setExportWithCreds] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  // 帮助 / 分组管理 / 标签管理弹框（对齐国内 BuddyAccounts）
  const [helpOpen, setHelpOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagDefs, setTagDefs] = useState<TagView[]>([]);
  const [tagMap, setTagMap] = useState<Record<string, string[]>>({});
  const [tagEditTarget, setTagEditTarget] = useState<BuddyAiAccountView | null>(null);
  // 积分包明细弹窗（对齐国内「积分包」列内弹窗；数据源 credits_packages 池快照）
  const [pkgTarget, setPkgTarget] = useState<BuddyAiAccountView | null>(null);
  // 今日打卡状态（签到状态列；对齐国内「今日已签」徽标列）
  const [todayStatus, setTodayStatus] = useState<Map<string, WbCheckinRecord>>(new Map());

  const reloadTags = useCallback(async () => {
    try {
      const [defs, map] = await Promise.all([api.tags.list(), api.tags.map()]);
      setTagDefs(defs);
      setTagMap(map);
    } catch {
      // 标签为增强面：失败不阻塞账号列表（静默保留旧值）
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [accs, gs, recs] = await Promise.all([
        api.buddyai.accountsList(),
        api.groups.sharedList().catch(() => [] as GroupView[]),
        api.buddyai.checkinResults(7).catch(() => [] as WbCheckinRecord[]),
      ]);
      setAccounts(accs);
      setGroups(gs);
      // 签到状态列（对齐国内「今日已签」）：records.user_id = 池账号 id
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const m = new Map<string, WbCheckinRecord>();
      for (const r of recs) if (r.date === todayStr) m.set(r.user_id, r);
      setTodayStatus(m);
      // FH-4 配套：selected 裁剪到现存账号（他端增删后全选框判定不失真）
      setSelected((prev) => {
        const ids = new Set(accs.map((a) => a.id));
        const next = new Set([...prev].filter((id) => ids.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch (err) {
      pushToast('error', `账号列表读取失败：${String(err).slice(0, 120)}`);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void reloadTags();
  }, [reloadTags]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const groupName = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) m.set(g.id, g.name);
    return m;
  }, [groups]);

  // OAuth 弹框事件契约：事件前缀 buddy-ai-oauth-*（310s 看门狗兜底事件丢失）。
  // FL-6 审查修复：监听只在弹框打开时注册一次（原依赖含 oauthBusy，done 置 false
  // 会触发 cleanup+重挂监听/重启 watchdog——无泄漏但属无谓重建）
  useEffect(() => {
    if (!oauthOpen) return;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const unProgress = listen<WbOauthProgress>('buddy-ai-oauth-progress', (e) => {
      setOauthStage(e.payload.stage ?? '');
      setOauthMessage(e.payload.message ?? '');
      if (e.payload.auth_url) setOauthAuthUrl(e.payload.auth_url);
    });
    const unDone = listen<WbOauthDone>('buddy-ai-oauth-done', (e) => {
      setOauthBusy(false);
      if (e.payload.ok) {
        pushToast('success', e.payload.message || '国际账号已扫码登录并自动入池');
        void refresh();
        setTimeout(() => setOauthOpen(false), 1200);
      } else {
        setOauthMessage(e.payload.message || '登录失败');
        pushToast('error', e.payload.message || '登录失败');
      }
    });
    watchdog = setTimeout(() => {
      setOauthBusy(false);
      setOauthMessage('登录超时（超过 310 秒无响应），请重试');
    }, 310_000);
    return () => {
      void unProgress.then((f) => f());
      void unDone.then((f) => f());
      if (watchdog) clearTimeout(watchdog);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthOpen]);

  const startOauth = async () => {
    if (oauthBusy) return;
    setOauthOpen(true);
    setOauthStage('init');
    setOauthMessage('正在请求登录 state…');
    setOauthAuthUrl(null);
    setOauthBusy(true);
    try {
      await api.buddyai.oauthLogin();
    } catch (err) {
      setOauthBusy(false);
      setOauthMessage(String(err));
      pushToast('error', `发起登录失败：${String(err).slice(0, 120)}`);
    }
  };

  const openImport = () => {
    setImportName('');
    setImportAccess('');
    setImportRefresh('');
    setImportOpen(true);
    setTimeout(() => importAccessRef.current?.focus(), 50);
  };

  const confirmImport = async () => {
    const token = importAccess.trim();
    if (!token) {
      pushToast('error', 'access_token 不能为空');
      return;
    }
    setImportBusy(true);
    try {
      const r = await withMinDelay(
        api.buddyai.accountImportCreds(importName.trim() || undefined, token, importRefresh.trim() || undefined),
        600,
      );
      pushToast('success', `凭证已导入并入池（${r.id}，域 ${r.domain}）`);
      setImportOpen(false);
      await refresh();
    } catch (err) {
      pushToast('error', `导入失败：${String(err).slice(0, 160)}`);
    } finally {
      setImportBusy(false);
    }
  };

  const doRenew = async (a: BuddyAiAccountView) => {
    setRowOp(`renew:${a.id}`);
    try {
      const msg = await withMinDelay(api.buddyai.refreshToken(a.id), 800);
      pushToast('success', `${a.nickname || a.id}：${msg}`);
      await refresh();
    } catch (err) {
      pushToast('error', `续期失败：${String(err).slice(0, 160)}`);
    } finally {
      setRowOp(null);
    }
  };

  const doToggle = async (a: BuddyAiAccountView) => {
    setRowOp(`toggle:${a.id}`);
    try {
      await withMinDelay(api.buddyai.accountToggle(a.id, !a.disabled), 400);
      pushToast('success', a.disabled ? `已启用 ${a.nickname || a.id}` : `已停用 ${a.nickname || a.id}（退出打卡与网关取号）`);
      await refresh();
    } catch (err) {
      pushToast('error', `启停失败：${String(err).slice(0, 120)}`);
    } finally {
      setRowOp(null);
    }
  };

  const openEdit = (a: BuddyAiAccountView) => {
    setEditTarget(a);
    setEditName(a.nickname);
    setEditNote(a.note);
  };

  const confirmEdit = async () => {
    if (!editTarget) return;
    setEditBusy(true);
    try {
      await api.buddyai.accountSave(editTarget.id, { name: editName.trim(), note: editNote.trim() });
      pushToast('success', '账号信息已保存');
      setEditTarget(null);
      await refresh();
    } catch (err) {
      pushToast('error', `保存失败：${String(err).slice(0, 120)}`);
    } finally {
      setEditBusy(false);
    }
  };

  const setGroup = async (a: BuddyAiAccountView, group_id: string) => {
    try {
      await api.buddyai.accountSave(a.id, { group_id });
      pushToast('success', '分组已更新');
      await refresh();
    } catch (err) {
      pushToast('error', `分组更新失败：${String(err).slice(0, 120)}`);
    }
  };

  // 导出账号池（P8 对齐国内 F-46：默认脱敏；凭证副本强确认——文件含明文 token 等同密码）
  const doExport = async () => {
    setExportBusy(true);
    try {
      const payload = await api.buddyai.accountsExport(exportWithCreds);
      // FL-5：导出计数取自导出载荷（页面快照可能已过期）
      const exportedCount = Array.isArray(payload.accounts) ? payload.accounts.length : 0;
      const filePath = await save({
        defaultPath: `buddy-ai-accounts-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!filePath) {
        setExportBusy(false);
        return;
      }
      await api.misc.writeTextFile(filePath, JSON.stringify(payload, null, 2));
      pushToast('success', `已导出 ${exportedCount} 个账号到 ${filePath}${exportWithCreds ? '（含凭证明文，请妥善保管）' : ''}`);
      setExportOpen(false);
    } catch (err) {
      pushToast('error', `导出失败：${String(err).slice(0, 160)}`);
    } finally {
      setExportBusy(false);
    }
  };

  const doRemove = async () => {
    if (!confirmTarget) return;
    setConfirmBusy(true);
    try {
      if (confirmTarget.kind === 'remove-account') {
        await withMinDelay(api.buddyai.accountRemove(confirmTarget.account.id), 800);
        pushToast('info', `已移除 ${confirmTarget.account.nickname || confirmTarget.account.id}`);
        setConfirmTarget(null);
      } else {
        // FH-4 审查修复：批量移除逐项容错——失败项收集继续，成功项即时从 selected
        // 剔除（原实现中途失败即中断且 selected 残留已删 id，重试必撞「账号不存在」，
        // 排在失败项之后的账号永远删不掉）
        const failed: string[] = [];
        let removed = 0;
        for (const id of confirmTarget.ids) {
          try {
            await api.buddyai.accountRemove(id);
            removed += 1;
            setSelected((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          } catch {
            failed.push(id);
          }
        }
        if (failed.length === 0) {
          pushToast('info', `已批量移除 ${removed} 个账号`);
          setConfirmTarget(null);
        } else {
          pushToast('error', `已移除 ${removed} 个，${failed.length} 个失败（${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}），弹框保留可重试`);
        }
      }
      await refresh();
    } catch (err) {
      pushToast('error', `移除失败：${String(err).slice(0, 120)}`);
    } finally {
      setConfirmBusy(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = accounts != null && accounts.length > 0 && selected.size === accounts.length;
  const expText = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString() : '-');

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="BuddyAI · 账号管理"
        desc="buddy-ai 独立池 · workbuddy.ai · 与国内 Buddy 池完全隔离"
        actions={
          <>
            <button className="btn-secondary inline-flex items-center gap-1.5" onClick={() => void startOauth()} disabled={oauthBusy}>
              <LogIn size={14} /> 扫码登录
            </button>
            <button className="btn-secondary inline-flex items-center gap-1.5" onClick={openImport}>
              <KeyRound size={14} /> 导入凭证
            </button>
            <button
              className="btn-outline inline-flex items-center gap-1.5"
              onClick={() => setExportOpen(true)}
              disabled={!accounts || accounts.length === 0}
              title="导出账号池为 JSON（可选是否附带凭证副本）"
            >
              <Download size={14} /> 导出账号
            </button>
            <button className="btn-outline inline-flex items-center gap-1.5" onClick={() => setGroupOpen(true)} title="新建 / 重命名 / 换色 / 删除分组">
              <FolderCog size={14} /> 分组管理
            </button>
            <button className="btn-outline inline-flex items-center gap-1.5" onClick={() => setTagsOpen(true)} title="共享标签管理（三池通用）">
              <Tags size={14} /> 标签管理
            </button>
            <button className="btn-outline inline-flex items-center gap-1.5" onClick={() => setHelpOpen(true)} title="使用帮助">
              <CircleHelp size={14} /> 帮助
            </button>
            {selected.size > 0 && (
              <button
                className="btn-secondary inline-flex items-center gap-1.5 text-red-500"
                onClick={() => setConfirmTarget({ kind: 'remove-batch', ids: [...selected] })}
              >
                <Trash2 size={14} /> 批量移除（{selected.size}）
              </button>
            )}
            <button className="btn-outline inline-flex items-center gap-1.5" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Spinner /> : <RefreshCw size={14} />} 刷新
            </button>
          </>
        }
      />

      {/* 账号列表 */}
      <div className="card overflow-x-auto p-4">
        {loading && accounts === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin" /> 加载中…
          </div>
        ) : !accounts || accounts.length === 0 ? (
          <EmptyState
            icon={<Globe size={28} />}
            title="还没有国际版账号"
            hint="点击「扫码登录」走 workbuddy.ai OAuth，或「导入凭证」手工导入国际账号 token（须为 .workbuddy.ai 域）"
          />
        ) : (
          <table className="w-full min-w-[1080px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400 dark:border-zinc-800">
                <th className="py-2 pl-1 pr-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(accounts.map((a) => a.id)) : new Set())}
                  />
                </th>
                <th className="py-2 pr-3 font-medium">账号</th>
                <th className="py-2 pr-3 font-medium">分组</th>
                <th className="py-2 pr-3 font-medium">标签</th>
                <th className="py-2 pr-3 font-medium">积分</th>
                <th className="py-2 pr-3 font-medium">签到</th>
                <th className="py-2 pr-3 font-medium">TOKEN 到期</th>
                <th className="py-2 pr-3 font-medium">凭证状态</th>
                <th className="py-2 pr-3 font-medium">状态</th>
                <th className="py-2 pr-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b border-slate-50 last:border-0 dark:border-zinc-800/50">
                  <td className="py-2.5 pl-1 pr-2">
                    <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSelect(a.id)} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="font-medium">
                      {a.nickname || a.id}
                      {a.note ? <span className="ml-1.5 text-[11px] font-normal text-slate-400">（{a.note}）</span> : null}
                    </div>
                    <div className="text-[11px] text-slate-400">{a.uid || a.id}</div>
                  </td>
                  <td className="py-2.5 pr-3">
                    <select
                      className="rounded-md border border-slate-200 bg-transparent px-1.5 py-1 text-xs focus:border-brand-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
                      value={a.group_id}
                      onChange={(e) => void setGroup(a, e.target.value)}
                    >
                      <option value="">未分组</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2.5 pr-3">
                    <TagChips tagIds={tagMap[a.id] ?? []} allTags={tagDefs} onEdit={() => setTagEditTarget(a)} />
                  </td>
                  <td className="py-2.5 pr-3 tabular-nums">
                    {a.credits_balance != null ? (
                      <button
                        className="inline-flex items-center gap-1 hover:text-brand-500"
                        title="查看积分包明细"
                        onClick={() => setPkgTarget(a)}
                      >
                        {a.credits_balance.toFixed(2)}
                        {(a.credits_packages?.length ?? 0) > 0 ? (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-zinc-800 dark:text-zinc-400">
                            <Package size={10} /> {a.credits_packages!.length} 包
                          </span>
                        ) : null}
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    {(() => {
                      const rec = todayStatus.get(a.id);
                      if (a.disabled) return <Badge tone="slate">已停用</Badge>;
                      if (!rec) return <Badge tone="slate">待打卡</Badge>;
                      if (rec.status === 'success')
                        return (
                          <Badge tone="green" title={rec.message}>
                            今日已签{rec.reward != null ? ` +${rec.reward}` : ''}
                          </Badge>
                        );
                      if (rec.status === 'already') return <Badge tone="blue" title={rec.message}>已完成</Badge>;
                      return <Badge tone="red" title={rec.message}>失败</Badge>;
                    })()}
                  </td>
                  <td className="py-2.5 pr-3 text-xs tabular-nums text-slate-500">{expText(a.access_token_expires_at)}</td>
                  <td className="py-2.5 pr-3">
                    {!a.has_credential ? (
                      <Badge tone="red">无凭证</Badge>
                    ) : a.needs_relogin ? (
                      <Badge tone="amber">需重新登录</Badge>
                    ) : (
                      <Badge tone="green">已授权</Badge>
                    )}
                    {a.needs_relogin && a.relogin_reason ? (
                      <div className="mt-0.5 text-[11px] text-slate-400">{a.relogin_reason}</div>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-3">
                    {a.disabled ? (
                      <Badge tone="slate">已停用</Badge>
                    ) : (
                      <Badge tone="green">启用</Badge>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        className="btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs"
                        title="编辑昵称/备注"
                        disabled={rowOp !== null}
                        onClick={() => openEdit(a)}
                      >
                        <Pencil size={13} /> 编辑
                      </button>
                      <button
                        className="btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs"
                        title={a.disabled ? '启用（恢复打卡与网关取号）' : '停用（退出打卡与网关取号）'}
                        disabled={rowOp !== null}
                        onClick={() => void doToggle(a)}
                      >
                        {rowOp === `toggle:${a.id}` ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : a.disabled ? (
                          <Power size={13} className="text-emerald-500" />
                        ) : (
                          <PowerOff size={13} className="text-amber-500" />
                        )}
                        {a.disabled ? '启用' : '停用'}
                      </button>
                      <button
                        className="btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs"
                        title="凭证续期（refreshToken 轮换回写）"
                        disabled={rowOp !== null || !a.has_credential}
                        onClick={() => void doRenew(a)}
                      >
                        {rowOp === `renew:${a.id}` ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                        续期
                      </button>
                      <button
                        className="btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs text-red-500 hover:text-red-600"
                        title="移除账号（池条目 + 凭证 + vault 条目三清）"
                        disabled={rowOp !== null}
                        onClick={() => setConfirmTarget({ kind: 'remove-account', account: a })}
                      >
                        <Trash2 size={13} /> 移除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* OAuth 进度弹框 */}
      <Modal
        open={oauthOpen}
        onClose={() => {
          if (!oauthBusy) setOauthOpen(false);
        }}
        title="Buddy 国际版扫码登录"
        widthClass="max-w-md"
      >
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            {oauthBusy ? <Loader2 size={15} className="animate-spin text-brand-500" /> : <Globe size={15} className="text-brand-500" />}
            <span className="font-medium">{oauthStage === 'done' ? '完成' : '进行中'}</span>
          </div>
          <p className="text-slate-500 dark:text-zinc-400">{oauthMessage}</p>
          {oauthAuthUrl ? (
            <>
              <a href={oauthAuthUrl} target="_blank" rel="noreferrer" className="btn-primary inline-flex w-full items-center justify-center gap-2">
                打开登录页（workbuddy.ai）
              </a>
              {/* 浏览器未自动打开时的兜底（对齐国内「复制完整链接」） */}
              <button
                className="btn-outline inline-flex w-full items-center justify-center gap-2"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(oauthAuthUrl)
                    .then(() => pushToast('success', '登录链接已复制，请勿泄露'))
                    .catch(() => pushToast('error', '复制失败，请手动选中地址栏链接复制'));
                }}
              >
                <Copy size={14} /> 复制完整链接
              </button>
            </>
          ) : null}
          <p className="text-[11px] leading-4 text-slate-400">
            登录流程：浏览器完成 workbuddy.ai 授权后，网关自动轮询拿票并国际账号入池（最长 300 秒）。
          </p>
          <div className="flex justify-end">
            <button className="btn-secondary" disabled={oauthBusy} onClick={() => setOauthOpen(false)}>
              {oauthBusy ? '运行中…' : '关闭'}
            </button>
          </div>
        </div>
      </Modal>

      {/* 手工导入弹框 */}
      <Modal open={importOpen} onClose={() => !importBusy && setImportOpen(false)} title="导入国际账号凭证" widthClass="max-w-md">
        <div className="space-y-3 text-sm">
          <div className="rounded-md bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            区域校验：本池仅接受国际账号（domain 须含 .workbuddy.ai）；国内账号请走 Buddy 页导入。
          </div>
          <div>
            <label className="label">access_token（必填）</label>
            <input
              ref={importAccessRef}
              className="input"
              value={importAccess}
              onChange={(e) => setImportAccess(e.target.value)}
              placeholder="粘贴国际账号 access_token"
            />
          </div>
          <div>
            <label className="label">refresh_token（可选，缺失则不可自动续期）</label>
            <input
              className="input"
              value={importRefresh}
              onChange={(e) => setImportRefresh(e.target.value)}
              placeholder="粘贴国际账号 refresh_token"
            />
          </div>
          <div>
            <label className="label">备注名（可选）</label>
            <input className="input" value={importName} onChange={(e) => setImportName(e.target.value)} placeholder="如：Intl-主力" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-secondary" disabled={importBusy} onClick={() => setImportOpen(false)}>
              取消
            </button>
            <button className="btn-primary inline-flex items-center gap-1.5" disabled={importBusy || !importAccess.trim()} onClick={() => void confirmImport()}>
              {importBusy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} 导入并入池
            </button>
          </div>
        </div>
      </Modal>

      {/* 编辑弹框 */}
      <Modal open={editTarget !== null} onClose={() => !editBusy && setEditTarget(null)} title="编辑账号" widthClass="max-w-sm">
        {editTarget ? (
          <div className="space-y-3 text-sm">
            <div>
              <label className="label">昵称</label>
              <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div>
              <label className="label">备注</label>
              <input className="input" value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="如：主力打卡号" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button className="btn-secondary" disabled={editBusy} onClick={() => setEditTarget(null)}>
                取消
              </button>
              <button className="btn-primary inline-flex items-center gap-1.5" disabled={editBusy} onClick={() => void confirmEdit()}>
                {editBusy ? <Loader2 size={14} className="animate-spin" /> : null} 保存
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* 导出弹框（P8：默认脱敏；凭证副本强确认） */}
      <Modal open={exportOpen} onClose={() => !exportBusy && setExportOpen(false)} title="导出 BuddyAI 账号池" widthClass="max-w-sm">
        <div className="space-y-3 text-sm">
          <div>导出账号池为 JSON 文件，可用于备份或迁移到其他设备的 BuddyAI 应用。</div>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={exportWithCreds}
              onChange={(e) => setExportWithCreds(e.target.checked)}
            />
            <span>
              附带凭证副本
              <span className="ml-1 text-xs text-slate-400">（不勾选 = 仅账号清单，导入后需重新登录/导入凭证）</span>
            </span>
          </label>
          {exportWithCreds ? (
            <div className="rounded-md bg-red-50 px-3 py-2 text-[11px] leading-4 text-red-600 dark:bg-red-500/10 dark:text-red-300">
              ⚠ 勾选后导出文件包含 access_token / refresh_token 明文，等同账号密码——请妥善保管，切勿通过不可信渠道传输。
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-secondary" disabled={exportBusy} onClick={() => setExportOpen(false)}>
              取消
            </button>
            <button
              className={`btn-primary inline-flex items-center gap-1.5 ${exportWithCreds ? 'bg-red-600 hover:bg-red-700' : ''}`}
              disabled={exportBusy}
              onClick={() => void doExport()}
            >
              {exportBusy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {exportWithCreds ? '我已知晓风险，确认导出' : '确认导出'}
            </button>
          </div>
        </div>
      </Modal>

      {/* 移除确认弹框（删除类操作二次确认） */}
      <Modal open={confirmTarget !== null} onClose={() => !confirmBusy && setConfirmTarget(null)} title="确认移除账号" widthClass="max-w-sm">
        {confirmTarget ? (
          <div className="space-y-3 text-sm">
            <p>
              {confirmTarget.kind === 'remove-account' ? (
                <>
                  确定移除国际账号 <b>{confirmTarget.account.nickname || confirmTarget.account.id}</b>？
                </>
              ) : (
                <>确定批量移除 <b>{confirmTarget.ids.length}</b> 个国际账号？</>
              )}
              将同时清除其凭证记录与 buddy-ai vault 条目，不可恢复。
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" disabled={confirmBusy} onClick={() => setConfirmTarget(null)}>
                取消
              </button>
              <button
                className="btn-primary inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-700"
                disabled={confirmBusy}
                onClick={() => void doRemove()}
              >
                {confirmBusy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} 确认移除
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* 积分包明细弹窗（对齐国内积分包列内弹窗；数据源 get-user-resource 分包快照） */}
      <Modal open={pkgTarget !== null} onClose={() => setPkgTarget(null)} title={`积分包明细 · ${pkgTarget?.nickname || pkgTarget?.id || ''}`} widthClass="max-w-lg">
        {pkgTarget ? (
          <div className="space-y-3 text-sm">
            {(pkgTarget.credits_packages?.length ?? 0) === 0 ? (
              <p className="py-4 text-center text-xs text-slate-400">无积分包数据，请先到「积分看板」同步。</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-slate-400 dark:border-zinc-800">
                    <th className="py-1.5 pr-2 font-medium">包名</th>
                    <th className="py-1.5 pr-2 text-right font-medium">剩余 / 总额</th>
                    <th className="py-1.5 text-right font-medium">到期时间</th>
                  </tr>
                </thead>
                <tbody>
                  {(pkgTarget.credits_packages ?? []).map((p, i) => {
                    const soon = p.expire_secs != null && p.expire_secs <= Math.floor(Date.now() / 1000) + 7 * 86400;
                    return (
                      <tr key={i} className="border-b border-slate-50 last:border-0 dark:border-zinc-800/50">
                        <td className="py-1.5 pr-2">
                          {p.name || p.code}
                          {soon && p.remain > 0 ? <Badge tone="amber">7 日内到期</Badge> : null}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {p.remain.toFixed(2)} / {p.size.toFixed(2)}
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-slate-500">
                          {p.expire_secs ? new Date(p.expire_secs * 1000).toLocaleDateString() : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="flex justify-end">
              <button className="btn-secondary" onClick={() => setPkgTarget(null)}>关闭</button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* 分组管理弹框（复用共享 GroupsModal；buddy-ai 分组走共享分组体系） */}
      <GroupsModal
        open={groupOpen}
        onClose={() => setGroupOpen(false)}
        groups={groups}
        onCreate={async (name, color) => {
          try {
            await api.groups.create(name, color);
            await refresh();
          } catch (err) {
            pushToast('error', `新建分组失败：${String(err)}`);
            throw err;
          }
        }}
        onRename={async (id, name) => {
          try {
            await api.groups.update(id, { name });
            await refresh();
          } catch (err) {
            pushToast('error', `重命名分组失败：${String(err)}`);
            throw err;
          }
        }}
        onRecolor={async (id, color) => {
          try {
            await api.groups.update(id, { color });
            await refresh();
          } catch (err) {
            pushToast('error', `修改分组颜色失败：${String(err)}`);
            throw err;
          }
        }}
        onDelete={async (id) => {
          try {
            await api.groups.remove(id);
            await refresh();
            pushToast('success', '分组已删除，组内账号回落未分组');
          } catch (err) {
            pushToast('error', `删除分组失败：${String(err)}`);
            throw err;
          }
        }}
      />

      {/* 共享标签管理 + 账号标签编辑（三池通用组件复用） */}
      <TagsModal
        open={tagsOpen}
        onClose={() => setTagsOpen(false)}
        tags={tagDefs}
        onCreate={async (name, color) => {
          try {
            await api.tags.create(name, color);
            await reloadTags();
          } catch (err) {
            pushToast('error', `创建标签失败：${String(err)}`);
            throw err;
          }
        }}
        onRename={async (id, name) => {
          try {
            await api.tags.update(id, { name });
            pushToast('success', `标签已重命名为「${name}」`);
            await reloadTags();
          } catch (err) {
            pushToast('error', `重命名标签失败：${String(err)}`);
            throw err;
          }
        }}
        onRecolor={async (id, color) => {
          try {
            await api.tags.update(id, { color });
            pushToast('success', '标签颜色已更新');
            await reloadTags();
          } catch (err) {
            pushToast('error', `修改标签颜色失败：${String(err)}`);
            throw err;
          }
        }}
        onDelete={async (id) => {
          try {
            await api.tags.remove(id);
            await reloadTags();
            await refresh();
            pushToast('success', '标签已删除，引用已清理');
          } catch (err) {
            pushToast('error', `删除标签失败：${String(err)}`);
            throw err;
          }
        }}
      />
      <AccountTagsEditModal
        open={tagEditTarget != null}
        onClose={() => setTagEditTarget(null)}
        accountName={tagEditTarget?.nickname || tagEditTarget?.id || ''}
        tags={tagDefs}
        selected={tagEditTarget ? (tagMap[tagEditTarget.id] ?? []) : []}
        onSave={async (ids) => {
          if (!tagEditTarget) return;
          try {
            await api.tags.setAccountTags(tagEditTarget.id, ids);
            await reloadTags();
            pushToast('success', '标签已更新');
          } catch (err) {
            pushToast('error', `标签保存失败：${String(err)}`);
            throw err;
          }
        }}
      />

      {/* 使用帮助弹框（国际版口径） */}
      <BuddyAiHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
