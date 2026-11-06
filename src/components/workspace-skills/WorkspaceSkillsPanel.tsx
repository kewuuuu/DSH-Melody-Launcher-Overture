import { AlertTriangle, Copy, FolderOpen, LoaderCircle, Power, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLauncherApi } from '../../api/client'
import type { WorkspaceSkillEntry, WorkspaceSkillsOverview } from '../../types'
import './workspace-skills.css'

/**
 * 设置页「工作区 Skills」：全局 skill 与 <workspace>/.dsh/skills 下的 skill 一起列、一起管。
 * 同名不同来源靠来源标签区分；停用只是改名成 .disabled，删除会进备份。
 */

export interface SkillGroupView {
  key: string
  title: string
  path: string
  missing: boolean
  skills: WorkspaceSkillEntry[]
}

/** 全局一组，其余按工作区分组；工作区已失效的条目单独成组并标灰。 */
export function groupSkills(overview: WorkspaceSkillsOverview): SkillGroupView[] {
  const groups: SkillGroupView[] = [{
    key: 'global',
    title: '全局',
    path: '',
    missing: false,
    skills: overview.skills.filter(skill => skill.scope === 'global'),
  }]
  for (const workspace of overview.workspaces) {
    groups.push({
      key: workspace.id,
      title: workspace.title,
      path: workspace.path,
      missing: workspace.missing,
      skills: overview.skills.filter(skill => skill.scope === 'workspace' && skill.workspaceId === workspace.id),
    })
  }
  // 条目指向的工作区已经不在列表里：照样列出来，否则用户没法清理它们。
  const known = new Set(overview.workspaces.map(workspace => workspace.id))
  const orphanIds = [...new Set(overview.skills
    .filter(skill => skill.scope === 'workspace' && (!skill.workspaceId || !known.has(skill.workspaceId)))
    .map(skill => skill.workspaceId ?? ''))]
  for (const workspaceId of orphanIds) {
    const skills = overview.skills.filter(skill => skill.scope === 'workspace' && (skill.workspaceId ?? '') === workspaceId)
    groups.push({
      key: `orphan:${workspaceId}`,
      title: skills[0]?.workspaceTitle ?? (workspaceId || '未知工作区'),
      path: '',
      missing: true,
      skills,
    })
  }
  return groups
}

const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback

/** 来源标签：全局就写「全局」，工作区写工作区名——同名 skill 靠它区分。 */
function sourceLabel(skill: WorkspaceSkillEntry): string {
  return skill.scope === 'global' ? '全局' : skill.workspaceTitle ?? skill.workspaceId ?? '工作区'
}

export function WorkspaceSkillsPanel() {
  const api = useLauncherApi()
  const [overview, setOverview] = useState<WorkspaceSkillsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const load = useCallback(async () => {
    const skills = api.workspaceSkills
    if (!skills) { setError('当前环境没有提供工作区 skill 接口。'); return }
    setLoading(true)
    setError(null)
    try { setOverview(await skills.list()) }
    catch (cause) { setError(errorText(cause, '读取工作区 skill 失败，请稍后重试。')) }
    finally { setLoading(false) }
  }, [api])

  useEffect(() => { void load() }, [load])

  const groups = useMemo(() => (overview ? groupSkills(overview) : []), [overview])
  // 没有 skill 也没失效的工作区分组不占版面；失效的工作区必须露出来提示用户。
  const visibleGroups = groups.filter(group => group.key === 'global' || group.skills.length > 0 || group.missing)
  const total = overview?.skills.length ?? 0

  const run = async (key: string, action: () => Promise<WorkspaceSkillsOverview>, fallback: string) => {
    setWorking(key)
    setError(null)
    setNotice(null)
    try {
      setOverview(await action())
      setConfirming(null)
    } catch (cause) {
      setError(errorText(cause, fallback))
    } finally { setWorking(null) }
  }

  const toggle = (skill: WorkspaceSkillEntry) => {
    const skills = api.workspaceSkills
    if (!skills) return
    void run(
      `toggle:${skill.id}`,
      () => skills.setEnabled(skill.id, skill.disabled),
      skill.disabled ? '启用 skill 失败。' : '停用 skill 失败。',
    )
  }
  const remove = (skill: WorkspaceSkillEntry) => {
    const skills = api.workspaceSkills
    if (!skills) return
    void run(`remove:${skill.id}`, () => skills.remove(skill.id), '删除 skill 失败。')
  }
  const reveal = (skill: WorkspaceSkillEntry) => {
    const skills = api.workspaceSkills
    if (skills) void skills.reveal(skill.id)
  }
  const copyPath = async (path: string) => {
    setNotice(null)
    try {
      const clipboard = navigator.clipboard
      if (!clipboard?.writeText) throw new Error('clipboard unavailable')
      await clipboard.writeText(path)
      setNotice(`已复制路径：${path}`)
    } catch {
      setNotice(`当前环境不能自动复制，请手动选择这一行路径：${path}`)
    }
  }

  return (
    <section className="settings-panel settings-home-panel workspace-skill-panel" aria-label="工作区 Skills">
      <div className="settings-panel-heading">
        <div className="settings-panel-title">
          <span className="settings-group-icon"><FolderOpen size={16} /></span>
          <span>工作区 Skills</span>
          {total > 0 && <span className="settings-count">{total}</span>}
        </div>
        <button type="button" className="secondary-button compact" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} />{loading ? '读取中…' : '刷新'}
        </button>
      </div>
      <p className="settings-hint">全局 skill 对所有整合包生效；工作区 skill 只在对应工作区里生效。停用只改名不删文件，删除会进备份区。</p>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <p className="workspace-skill-notice" role="status">{notice}</p>}

      {overview === null
        ? <p className="workspace-skill-empty">{loading ? '正在读取 skill 列表…' : '还没有读到 skill 列表。'}</p>
        : visibleGroups.map(group => (
          <div
            key={group.key}
            className={`workspace-skill-group ${group.missing ? 'is-missing' : ''}`}
            role="group"
            aria-label={`${group.title} skill`}
          >
            <div className="workspace-skill-group-heading">
              <strong>{group.title}</strong>
              <span className="workspace-skill-count">{group.skills.length} 个</span>
              {group.path && <code title={group.path}>{group.path}</code>}
            </div>
            {group.missing && (
              <p className="workspace-skill-missing">
                <AlertTriangle size={13} />工作区路径不存在，可能已被移动或删除；这里的 skill 暂时不会被加载。
              </p>
            )}
            {group.skills.length === 0
              ? <p className="workspace-skill-empty">这个分组下还没有 skill。</p>
              : group.skills.map(skill => (
                <div className={`workspace-skill-row ${skill.disabled ? 'is-disabled' : ''}`} key={skill.id}>
                  <div className="workspace-skill-main">
                    <div className="workspace-skill-title">
                      <strong>{skill.name}</strong>
                      <span className="workspace-skill-source">{sourceLabel(skill)}</span>
                      {skill.disabled && <span className="workspace-skill-state">已停用</span>}
                    </div>
                    {skill.description && <p>{skill.description}</p>}
                    <code title={skill.path}>{skill.path}</code>
                  </div>
                  <div className="workspace-skill-actions">
                    {confirming === skill.id ? (
                      <>
                        <span className="workspace-skill-confirm-hint">删除会进备份，之后可以恢复。</span>
                        <button type="button" className="danger-button compact" disabled={working !== null} onClick={() => remove(skill)}>确认删除</button>
                        <button type="button" className="secondary-button compact" onClick={() => setConfirming(null)}>取消</button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="secondary-button compact" disabled={working !== null} onClick={() => toggle(skill)}>
                          <Power size={12} />{skill.disabled ? '启用' : '停用'}
                        </button>
                        <button type="button" className="secondary-button compact" onClick={() => setConfirming(skill.id)}>
                          <Trash2 size={12} />删除
                        </button>
                        <button type="button" className="secondary-button compact" onClick={() => reveal(skill)}>
                          <FolderOpen size={12} />打开文件夹
                        </button>
                        <button type="button" className="secondary-button compact" onClick={() => void copyPath(skill.path)}>
                          <Copy size={12} />复制路径
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
          </div>
        ))}
    </section>
  )
}
