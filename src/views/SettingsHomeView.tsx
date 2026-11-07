import { Check, Folder, Globe, ImagePlus, Info, LoaderCircle, Palette, RefreshCw, Rocket, RotateCcw, Wrench } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import packageMetadata from '../../package.json'
import { useLauncherApi } from '../api/client'
import { ApiLibraryCard } from '../components/ApiLibraryCard'
import { BackupManager } from '../components/backup/BackupManager'
import { PathMigrationSection } from '../components/path-migration/PathMigrationSection'
import { StorageLocationCard } from '../components/StorageLocationCard'
import { UninstallPanel } from '../components/uninstall/UninstallPanel'
import { GITHUB_MIRROR_PRESETS } from '../constants'
import {
  ACCENT_PRESETS,
  APPEARANCE_IMAGE_FORMAT_LABEL,
  DEFAULT_THEME_ACCENT,
  MAX_APPEARANCE_IMAGE_BYTES,
  appearanceImageUrl,
  appearancePickErrorText,
  clampBackgroundOpacity,
  clampPanelOpacity,
  nextAppearanceImageVersion,
} from '../lib/appearance'
import type { AppSettings, AppearanceSettings, UiTheme } from '../types'
import '../components/settings-home.css'

/**
 * 设置主页（顶栏「设置」）：把原本散在设置弹窗里的东西收成整页。
 * 分区顺序即使用频率：外观 → 启动器 → 存储位置 → API 库 → 备份管理 → 工作区 Skills → 网络 → 关于。
 * 只有点「保存设置」才写盘；外观改动会实时预览，离开本页即回到已保存设置。
 */

interface Props {
  settings: AppSettings
  busy: boolean
  /** 保存整份设置；返回 false 表示主进程拒绝，草稿保留供修正。 */
  onSave: (settings: AppSettings) => Promise<boolean>
  /** 实时预览外观；null = 回到已保存设置。 */
  onPreview: (appearance: AppearanceSettings | null) => void
  /** 打开启动器更新弹窗。 */
  onCheckUpdate: () => void
  /** 在系统里打开一个路径。 */
  onOpenPath: (targetPath: string) => void
  /** 打开 DSH 本体目录（主进程按当前安装位置解析）。 */
  onOpenDshFolder: () => void
}

const UI_THEMES: Array<{ id: UiTheme; label: string }> = [
  { id: 'deepseek', label: '日间' },
  { id: 'night', label: '夜间' },
]

/** 下拉里代表「手填地址」的哨兵值，不会真的存进设置。 */
const CUSTOM_MIRROR = '__custom__'
/** 比较镜像地址时忽略首尾空格与结尾斜杠（手敲的常常少一个 / ）。 */
const normalizeMirror = (value: string): string => value.trim().replace(/\/+$/, '')

/** <dshHome>/profiles/<name>：整合包在 DSH_HOME 里的固定位置，备份按钮备份的就是它。 */
function profileDirectory(dshHome: string, profileName: string): string {
  const root = dshHome.trim().replace(/[\\/]+$/, '')
  if (!root) return ''
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root}${separator}profiles${separator}${profileName}`
}

function Section({ icon, title, desc, children }: { icon: ReactNode; title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="settings-panel settings-home-panel" aria-label={title}>
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><span className="settings-group-icon">{icon}</span><span>{title}</span></div>
      </div>
      {desc && <p className="settings-hint">{desc}</p>}
      {children}
    </section>
  )
}

export function SettingsHomeView({ settings, busy, onSave, onPreview, onCheckUpdate, onOpenPath, onOpenDshFolder }: Props) {
  const api = useLauncherApi()
  const [draft, setDraft] = useState(settings)
  // 参数在界面上是一整行文本，保存时才切成数组。
  const [argsText, setArgsText] = useState(settings.launchArgs.join(' '))
  // 选图失败（格式不支持 / 超过 10MB / 文件不存在）时在设置页内就地提示。
  const [imageError, setImageError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // 已保存设置变了（保存成功、切换整合包等）：草稿跟着回到最新值，别用旧草稿覆盖磁盘。
  useEffect(() => {
    setDraft(settings)
    setArgsText(settings.launchArgs.join(' '))
    setSaved(false)
  }, [settings])
  // 离开设置页时撤掉实时预览：没保存就等于没改过。
  useEffect(() => () => onPreview(null), [onPreview])

  const mirrorValue = draft.network?.githubMirror ?? ''
  const matchedPreset = GITHUB_MIRROR_PRESETS.find(prefix => normalizeMirror(prefix) === normalizeMirror(mirrorValue) && mirrorValue.trim() !== '')
  const mirrorPreset = mirrorValue.trim() === '' ? '' : (matchedPreset ?? CUSTOM_MIRROR)

  const patch = (next: Partial<AppSettings>) => { setDraft(current => ({ ...current, ...next })); setSaved(false) }

  const chooseDirectory = async (kind: 'dshInstallPath' | 'dshHome' | 'workspace') => {
    const chosen = await api.chooseDirectory(kind)
    if (chosen) patch({ [kind]: chosen } as Partial<AppSettings>)
  }

  const appearance: AppearanceSettings = draft.appearance ?? {}
  const theme = draft.uiTheme ?? 'deepseek'
  const previewAppearance = (next: AppSettings) => {
    setDraft(next)
    setSaved(false)
    onPreview(next.appearance ?? null)
  }
  const updateAppearance = (next: Partial<AppearanceSettings>) => {
    const merged = { ...appearance, ...next }
    // 清成 undefined / 空串的项直接丢掉：appearance 里出现空值会让运行期变量算错。
    const cleaned = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined && value !== null && value !== ''),
    ) as AppearanceSettings
    previewAppearance({ ...draft, appearance: Object.keys(cleaned).length > 0 ? cleaned : undefined })
  }
  const resetAppearance = () => {
    setImageError(null)
    previewAppearance({ ...draft, appearance: undefined })
  }
  const chooseAppearanceImage = async (kind: 'background' | 'logo') => {
    setImageError(null)
    try {
      const picked = await api.chooseAppearanceImage(kind)
      if (!picked) return
      // 复制件文件名固定，只换内容；路径不变时浏览器会复用旧图，所以每次递增内容版本。
      updateAppearance(kind === 'background'
        ? { backgroundPath: picked.path, backgroundVersion: nextAppearanceImageVersion(appearance.backgroundVersion) }
        : { logoPath: picked.path, logoVersion: nextAppearanceImageVersion(appearance.logoVersion) })
    } catch (cause) {
      setImageError(appearancePickErrorText(cause))
    }
  }
  const fileLabel = (target: string | undefined): string => (target ? target.split(/[\\/]/).pop() ?? target : '')

  const resetDraft = () => {
    setDraft(settings)
    setArgsText(settings.launchArgs.join(' '))
    setImageError(null)
    setSaveError(null)
    setSaved(false)
    onPreview(null)
  }

  const save = async () => {
    setSaveError(null)
    const ok = await onSave({ ...draft, launchArgs: argsText.trim().split(/\s+/).filter(Boolean) })
    if (ok) {
      setSaved(true)
      onPreview(null)
    } else {
      setSaveError('设置没有保存成功，请检查填写内容后重试。')
    }
  }

  return (
    <div className="home-tab-page">
      <main className="settings-content">
        <div className="settings-stack">
          <Section icon={<Palette size={16} />} title="外观" desc="界面主题、主题色、透明度与启动器图标；保存后立即生效。">
            <div className="theme-options" role="radiogroup" aria-label="界面主题">
              {UI_THEMES.map(option => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={theme === option.id}
                  className={`theme-option ${theme === option.id ? 'selected' : ''}`}
                  onClick={() => patch({ uiTheme: option.id })}
                >
                  <span className={`theme-swatch ${option.id}`} aria-hidden="true"><i /><i /><i /></span>
                  <span>{option.label}</span>
                  {theme === option.id && <Check size={14} />}
                </button>
              ))}
            </div>

            <div className="appearance-field">
              <span className="appearance-label">主题色</span>
              <div className="appearance-swatches" role="radiogroup" aria-label="主题色">
                {ACCENT_PRESETS.map(preset => {
                  const selected = (appearance.accent ?? null) === preset.color
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`appearance-swatch ${preset.color ? '' : 'auto'} ${selected ? 'selected' : ''}`}
                      style={preset.color ? { background: preset.color } : undefined}
                      title={preset.label}
                      onClick={() => updateAppearance({ accent: preset.color ?? undefined })}
                    >
                      {preset.color === null && <span>自动</span>}
                    </button>
                  )
                })}
                <label className="appearance-custom-color" title="自定义主题色">
                  <input
                    type="color"
                    value={appearance.accent ?? DEFAULT_THEME_ACCENT[theme]}
                    onChange={event => updateAppearance({ accent: event.target.value })}
                  />
                  <span>自定义</span>
                </label>
              </div>
            </div>

            <label className="appearance-slider-row">
              <span>面板透明度</span>
              <input
                type="range"
                min={20}
                max={100}
                step={1}
                value={Math.round(clampPanelOpacity(appearance.panelOpacity ?? 1) * 100)}
                onChange={event => updateAppearance({ panelOpacity: Number(event.currentTarget.value) / 100 })}
              />
              <em>{Math.round(clampPanelOpacity(appearance.panelOpacity ?? 1) * 100)}%</em>
            </label>

            <div className="appearance-image-row">
              <span>背景图片</span>
              <div className="appearance-image-actions">
                <button type="button" className="secondary-button" onClick={() => void chooseAppearanceImage('background')}>
                  <ImagePlus size={14} />选择图片…
                </button>
                {appearance.backgroundPath && (
                  <button type="button" className="secondary-button" onClick={() => updateAppearance({ backgroundPath: undefined, backgroundVersion: undefined, backgroundOpacity: undefined })}>清除</button>
                )}
                <small title={appearance.backgroundPath ?? ''}>{appearance.backgroundPath ? fileLabel(appearance.backgroundPath) || '已选择' : '跟随主题色渐变'}</small>
              </div>
            </div>

            {appearance.backgroundPath && (
              <label className="appearance-slider-row">
                <span>背景透明度</span>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={1}
                  value={Math.round(clampBackgroundOpacity(appearance.backgroundOpacity ?? 1) * 100)}
                  onChange={event => updateAppearance({ backgroundOpacity: Number(event.currentTarget.value) / 100 })}
                />
                <em>{Math.round(clampBackgroundOpacity(appearance.backgroundOpacity ?? 1) * 100)}%</em>
              </label>
            )}

            <div className="appearance-image-row">
              <span>启动器图标</span>
              <div className="appearance-image-actions">
                <img
                  className="appearance-logo-preview"
                  src={appearanceImageUrl(appearance.logoPath, appearance.logoVersion) ?? `${import.meta.env.BASE_URL}launcher-logo.png`}
                  alt=""
                />
                <button type="button" className="secondary-button" onClick={() => void chooseAppearanceImage('logo')}>
                  <ImagePlus size={14} />选择图片…
                </button>
                {appearance.logoPath && (
                  <button type="button" className="secondary-button" onClick={() => updateAppearance({ logoPath: undefined, logoVersion: undefined })}>清除</button>
                )}
                <small>仅替换首页头像</small>
              </div>
            </div>

            <p className="settings-group-note">
              选图限制：{APPEARANCE_IMAGE_FORMAT_LABEL}，单张不超过 {MAX_APPEARANCE_IMAGE_BYTES / 1024 / 1024} MB，尺寸不限。背景图自动铺满整窗；头像按比例缩放，不拉伸。原图会被复制到启动器数据目录，之后移动或删除原图不影响外观。
            </p>
            {imageError && <p className="appearance-pick-error" role="alert">{imageError}</p>}

            <div className="appearance-actions">
              <button type="button" className="secondary-button" onClick={resetAppearance}>
                <RotateCcw size={14} />恢复外观默认
              </button>
            </div>
          </Section>

          <Section icon={<Rocket size={16} />} title="启动器" desc="开机自启、DSH 本体目录、DSH_HOME 与工作区；DSH 本体目录存程序与依赖，DSH_HOME 存整合包、配置、插件和 Skills。">
            <label className="check-field">
              <input
                type="checkbox"
                aria-label="随 Windows 登录启动"
                checked={draft.launchAtLogin ?? false}
                onChange={event => patch({ launchAtLogin: event.target.checked })}
              />
              <span><strong>随 Windows 登录启动</strong><small>开机后自动把启动器收进托盘，不打开主窗口。</small></span>
            </label>
            <label className="check-field">
              <input type="checkbox" checked={draft.openAfterLaunch} onChange={event => patch({ openAfterLaunch: event.target.checked })} />
              <span><strong>启动后打开 Harness</strong><small>识别到本地 Web 地址时，在默认浏览器中打开。</small></span>
            </label>
            <label className="form-field">
              <span>本体安装目录</span>
              <div className="path-input">
                <input value={draft.dshInstallPath} onChange={event => patch({ dshInstallPath: event.target.value })} />
                <button type="button" onClick={() => void chooseDirectory('dshInstallPath')} title="选择 DSH 本体安装目录"><Folder size={17} /></button>
              </div>
            </label>
            <PathMigrationSection
              kind="dshInstallPath"
              label="本体安装目录"
              current={draft.dshInstallPath}
              onMigrated={result => patch({ dshInstallPath: result.current })}
            />
            <label className="form-field">
              <span>DSH_HOME</span>
              <div className="path-input">
                <input value={draft.dshHome} onChange={event => patch({ dshHome: event.target.value })} />
                <button type="button" onClick={() => void chooseDirectory('dshHome')} title="选择 DSH_HOME"><Folder size={17} /></button>
              </div>
            </label>
            <PathMigrationSection
              kind="dshHome"
              label="DSH_HOME"
              current={draft.dshHome}
              onMigrated={result => patch({ dshHome: result.current })}
            />
            <label className="form-field">
              <span>工作区</span>
              <div className="path-input">
                <input value={draft.workspace} onChange={event => patch({ workspace: event.target.value })} />
                <button type="button" onClick={() => void chooseDirectory('workspace')} title="选择工作目录"><Folder size={17} /></button>
              </div>
            </label>
          </Section>

          <StorageLocationCard />

          <UninstallPanel />

          <ApiLibraryCard onChanged={() => { /* 包配置页每次进入都会重新读取，这里无需广播。 */ }} />

          <BackupManager packDir={profileDirectory(draft.dshHome, draft.profileName)} packId={draft.profileName} />


          <Section icon={<Globe size={16} />} title="网络" desc="默认使用国内 npm 镜像（npmmirror），并自动跟随 Windows 系统代理；留空即可。">
            <label className="form-field">
              <span>npm 镜像</span>
              <input value={draft.network?.npmRegistry ?? ''} placeholder="https://registry.npmmirror.com" onChange={event => patch({ network: { ...draft.network, npmRegistry: event.target.value } })} />
            </label>
            <label className="form-field">
              <span>代理地址</span>
              <input value={draft.network?.proxy ?? ''} placeholder="留空自动探测系统代理；如 http://127.0.0.1:7890" onChange={event => patch({ network: { ...draft.network, proxy: event.target.value } })} />
            </label>
            {/* 镜像用预设下拉而不是裸文本框：国内用户最容易卡在这一格。 */}
            <label className="form-field">
              <span>GitHub 镜像</span>
              <select
                value={mirrorPreset}
                onChange={event => {
                  const value = event.target.value
                  patch({ network: { ...draft.network, githubMirror: value === CUSTOM_MIRROR ? (draft.network?.githubMirror ?? '') : value } })
                }}
              >
                <option value="">自动（直连太慢或断流时自动换公共镜像）</option>
                {GITHUB_MIRROR_PRESETS.map(prefix => <option key={prefix} value={prefix}>{prefix.replace(/^https?:\/\//, '').replace(/\/$/, '')}</option>)}
                <option value={CUSTOM_MIRROR}>自定义…</option>
              </select>
            </label>
            {mirrorPreset === CUSTOM_MIRROR && (
              <label className="form-field">
                <span>自定义镜像</span>
                <input value={draft.network?.githubMirror ?? ''} placeholder="如 https://gh-proxy.com" onChange={event => patch({ network: { ...draft.network, githubMirror: event.target.value } })} />
              </label>
            )}
            <p className="settings-group-note">下载整合包 / 插件 / DSH 时优先走这里的镜像；选「自动」则先试直连，8 秒无响应或速度低于 300KB/s 就自动切到公共镜像（整合包页会显示当前用的是哪一个）。</p>
          </Section>

          <Section icon={<Info size={16} />} title="关于">
            <div className="settings-about-rows">
              <div><span>启动器版本</span><strong>v{packageMetadata.version}</strong></div>
            </div>
            <div className="settings-home-row-actions">
              <button type="button" className="secondary-button" onClick={onCheckUpdate}><RefreshCw size={14} />检查更新</button>
              <button type="button" className="secondary-button" onClick={onOpenDshFolder}><Folder size={14} />打开 DSH 目录</button>
              <button type="button" className="secondary-button" disabled={!draft.dshHome} onClick={() => onOpenPath(draft.dshHome)}><Folder size={14} />打开 DSH_HOME</button>
            </div>
          </Section>

          <details className="settings-panel settings-home-panel settings-advanced">
            <summary><span className="settings-group-icon"><Wrench size={16} /></span>高级设置<small>启动命令、端口、Copilot 提示词——一般不需要改动</small></summary>
            <label className="form-field"><span>可执行文件</span><input value={draft.launchExecutable} onChange={event => patch({ launchExecutable: event.target.value })} /></label>
            <label className="form-field"><span>参数</span><input value={argsText} onChange={event => { setArgsText(event.target.value); setSaved(false) }} /></label>
            <label className="form-field"><span>首选 Web 端口</span><input type="number" min={1} max={65535} step={1} value={draft.webPort} onChange={event => patch({ webPort: Number(event.target.value) })} /></label>
            <p className="settings-advanced-note">DSH Copilot：默认模式会把自定义内容追加到内置提示词；开发者模式可替换基础提示词，但凭据保护、工作区边界和操作审批始终有效。</p>
            <label className="check-field"><input type="checkbox" checked={Boolean(draft.aiDeveloperMode)} onChange={event => patch({ aiDeveloperMode: event.target.checked })} /><span><strong>开发者模式</strong><small>允许使用下面的内容替换 Copilot 基础 persona。</small></span></label>
            <label className="form-field copilot-prompt-field"><span>AI 分析提示词</span><textarea rows={7} value={draft.aiPrompt ?? ''} placeholder="留空使用内置 DSH Copilot 提示词。" onChange={event => patch({ aiPrompt: event.target.value })} /><small>{draft.aiDeveloperMode ? '当前：替换基础 persona；固定安全规则仍会自动追加。' : '当前：作为附加开发指引追加到内置提示词。'}</small></label>
            <div className="settings-inline-actions"><button type="button" className="secondary-button" onClick={() => patch({ aiPrompt: '' })}>恢复默认提示词</button></div>
          </details>

          {saveError && <div className="error-banner" role="alert">{saveError}</div>}
          <div className="settings-home-actions">
            <span className="settings-home-actions-hint">{saved ? '已保存。' : '改动只在点「保存设置」后写入磁盘。'}</span>
            <button type="button" className="secondary-button" disabled={busy} onClick={resetDraft}>取消更改</button>
            <button type="button" className="primary-command" disabled={busy} onClick={() => void save()}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存设置
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
