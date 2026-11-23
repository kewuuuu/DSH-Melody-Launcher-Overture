import { Check, Folder, Globe, ImagePlus, Info, Palette, RefreshCw, Rocket, RotateCcw, Wrench } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
 * 改完即自动保存：任何字段一改就排一次写盘，停止输入 SAVE_DEBOUNCE_MS 后整份落盘，连续改多个字段合并成一次；
 * 底部只剩一行「已自动保存」状态，没有保存/取消按钮；离开本页或卸载时还有未落盘的改动会立刻 flush。
 * 唯一例外是「随 Windows 登录启动」：勾选即写登录项，这一步不等防抖。
 */

interface Props {
  settings: AppSettings
  busy: boolean
  /** 保存整份设置；返回 false 表示主进程拒绝，草稿保留供修正。 */
  onSave: (settings: AppSettings) => Promise<boolean>
  /** 实时预览外观；null = 回到磁盘上那份设置。 */
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

/** 自动保存的防抖窗口：停止输入这么久才写盘，连续打字只落一次。 */
const SAVE_DEBOUNCE_MS = 600
/** 自动保存失败的统一文案：草稿还在，改内容或点「重试保存」再来一次。 */
const SAVE_ERROR_TEXT = '自动保存失败，改动还留在这一页没有写盘；可以点「重试保存」再存一次。'

/** 参数那一行文本与整份设置之间的唯一口径：空白切分、丢掉空串。 */
const argsToArray = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean)

/** 设置的稳定指纹（字段顺序无关）：用来分辨 prop 变化是「刚写盘那份的回声」还是别处真的改了设置。 */
function settingsSignature(value: AppSettings): string {
  return JSON.stringify(value, (_key, item: unknown) => (item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : item))
}

/** 「已自动保存」的时间：一分钟内说「刚刚」，更早的给时钟。 */
function savedAtText(at: number, now: number): string {
  if (now - at < 60_000) return '刚刚'
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 自动保存状态机：pending = 在防抖队列里，saved = 已落盘，error = 写盘失败（草稿保留）。 */
type SavePhase = 'idle' | 'pending' | 'saved' | 'error'

/** 管理员权限开关只对 Windows 有意义；在渲染时读 UA，测试可以临时替换。 */
const isWindowsHost = (): boolean => typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

/** 关机参数的默认值与合法区间，与 AppSettings 上的注释同一口径。 */
const SHUTDOWN_IDLE_DEFAULT = 10
const SHUTDOWN_IDLE_MIN = 1
const SHUTDOWN_IDLE_MAX = 1440
const SHUTDOWN_GRACE_DEFAULT = 10
const SHUTDOWN_GRACE_MIN = 0
const SHUTDOWN_GRACE_MAX = 60

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
  // 两个分钟数也是文本态：空串/非数字/越界留在输入框里报错，不写进 draft。
  const [idleText, setIdleText] = useState(String(settings.shutdownIdleMinutes ?? SHUTDOWN_IDLE_DEFAULT))
  const [graceText, setGraceText] = useState(String(settings.shutdownGraceMinutes ?? SHUTDOWN_GRACE_DEFAULT))
  const [idleError, setIdleError] = useState<string | null>(null)
  const [graceError, setGraceError] = useState<string | null>(null)
  // 选图失败（格式不支持 / 超过 10MB / 文件不存在）时在设置页内就地提示。
  const [imageError, setImageError] = useState<string | null>(null)
  // 自动保存的状态与时间：底部那行状态只描述「这一页的改动写没写进磁盘」。
  const [savePhase, setSavePhase] = useState<SavePhase>('idle')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const [saveError, setSaveError] = useState<string | null>(null)
  // 自启开关是勾选即写登录项的，行内状态只描述这一次点选，与自动保存的状态各管一段。
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginStatus, setLoginStatus] = useState<string | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)

  /** 待写内容与防抖计时器都放 ref 里：计时器回调和卸载 flush 读到的总是最新一份。 */
  const pendingRef = useRef<AppSettings | null>(null)
  const timerRef = useRef<number | null>(null)
  const savingRef = useRef(false)
/**
   * 已经提交过写盘的设置的指纹。写盘回来的 settings 会晚一步到，甚至比下一次提交更晚，
   * 所以记一串而不是只记最后一次：只要回流的是我们写出去的那几份之一，就原样跳过，别冲掉正在输入的草稿。
   */
  const submittedRef = useRef<string[]>([])
  /** App 每次渲染都传新的 onSave 箭头函数，卸载 flush 必须读最新那个，不能把 effect 绑在它身上。 */
  const onSaveRef = useRef(onSave)
  useEffect(() => { onSaveRef.current = onSave }, [onSave])

  /**
   * 把待写内容立刻写盘。防抖到点、离开设置页、点「重试保存」都走这里。
   * 写盘途中又改了字段时循环会接着再写一轮：改动永远合并、但一次都不丢。
   */
  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // 已经在写盘：它自己会把队列里的新内容接着处理掉，这里直接返回。
    if (savingRef.current) return
    savingRef.current = true
    try {
      for (;;) {
        const next = pendingRef.current
        if (!next) break
        pendingRef.current = null
        const submitted = settingsSignature(next)
        if (!submittedRef.current.includes(submitted)) submittedRef.current = [...submittedRef.current, submitted].slice(-10)
        let ok = false
        try {
          ok = await onSaveRef.current(next)
        } catch {
          ok = false
        }
        if (!ok) {
          // 失败：内容放回队列，草稿一个字都不动，等用户重试或继续改。
          pendingRef.current = next
          setSaveError(SAVE_ERROR_TEXT)
          setSavePhase('error')
          break
        }
        setSaveError(null)
        setSavedAt(Date.now())
        setClock(Date.now())
        setSavePhase(pendingRef.current ? 'pending' : 'saved')
      }
    } finally {
      savingRef.current = false
    }
  }, [])

  /** 排一次自动保存：SAVE_DEBOUNCE_MS 内的后续改动只覆盖待写内容并重置计时器，所以连续改多个字段只写一次盘。 */
  const scheduleSave = (next: AppSettings) => {
    pendingRef.current = next
    setSavePhase('pending')
    setSaveError(null)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void flush()
    }, SAVE_DEBOUNCE_MS)
  }

  // 磁盘上那份设置变了：只有别处真的改了它（换整合包、存储位置迁移）才把草稿拉回磁盘值。
  // 刚写盘那份自己也会回流一次，那一次必须原样跳过——否则用户在写盘期间敲的字会被旧值冲掉。
  useEffect(() => {
    if (submittedRef.current.includes(settingsSignature(settings))) return
    setDraft(settings)
    setArgsText(settings.launchArgs.join(' '))
    setIdleText(String(settings.shutdownIdleMinutes ?? SHUTDOWN_IDLE_DEFAULT))
    setGraceText(String(settings.shutdownGraceMinutes ?? SHUTDOWN_GRACE_DEFAULT))
    setIdleError(null)
    setGraceError(null)
    setSavePhase('idle')
    setSavedAt(null)
    setSaveError(null)
  }, [settings])

  // 「已自动保存 · 刚刚」要自己走到时钟：挂一个 30 秒的节拍，别让「刚刚」永远停在那儿。
  useEffect(() => {
    if (savePhase !== 'saved') return
    const ticker = window.setInterval(() => setClock(Date.now()), 30_000)
    return () => window.clearInterval(ticker)
  }, [savePhase])

  // 离开设置页（切标签、换整合包）时防抖计时器里的改动不能跟着组件一起消失：立刻写盘。
  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) void onSaveRef.current(pending)
  }, [])

  // 离开设置页时撤掉实时预览：没写盘就等于没改过。
  useEffect(() => () => onPreview(null), [onPreview])

  const mirrorValue = draft.network?.githubMirror ?? ''
  const matchedPreset = GITHUB_MIRROR_PRESETS.find(prefix => normalizeMirror(prefix) === normalizeMirror(mirrorValue) && mirrorValue.trim() !== '')
  const mirrorPreset = mirrorValue.trim() === '' ? '' : (matchedPreset ?? CUSTOM_MIRROR)

  /** 写盘写的是整份设置：草稿 + 参数文本切成的数组，入口不同口径也不分叉。 */
  const composePayload = (base: AppSettings = draft): AppSettings => ({ ...base, launchArgs: argsToArray(argsText) })

  /** 改一个字段：先更新草稿，再把整份设置排进自动保存队列。 */
  const patch = (next: Partial<AppSettings>) => {
    const merged = { ...draft, ...next }
    setDraft(merged)
    scheduleSave(composePayload(merged))
  }

  /** 参数是一整行文本：边打边改草稿，停手 SAVE_DEBOUNCE_MS 才写盘（不做 blur 提交）。 */
  const updateArgsText = (raw: string) => {
    setArgsText(raw)
    scheduleSave({ ...draft, launchArgs: argsToArray(raw) })
  }

  const chooseDirectory = async (kind: 'dshInstallPath' | 'dshHome' | 'workspace') => {
    const chosen = await api.chooseDirectory(kind)
    if (chosen) patch({ [kind]: chosen } as Partial<AppSettings>)
  }

  const appearance: AppearanceSettings = draft.appearance ?? {}
  const theme = draft.uiTheme ?? 'deepseek'
  const previewAppearance = (next: AppSettings) => {
    setDraft(next)
    onPreview(next.appearance ?? null)
    scheduleSave(composePayload(next))
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

  // 分钟数只在合法时写进 draft；非法值留在输入框里，给出行内提示，也就不会被自动保存带走。
  const updateIdleMinutes = (raw: string) => {
    setIdleText(raw)
    const value = Number(raw)
    if (raw.trim() === '' || !Number.isInteger(value) || value < SHUTDOWN_IDLE_MIN || value > SHUTDOWN_IDLE_MAX) {
      setIdleError('请填 1–1440 之间的整数分钟，当前值不会保存。')
      return
    }
    setIdleError(null)
    patch({ shutdownIdleMinutes: value })
  }

  const updateGraceMinutes = (raw: string) => {
    setGraceText(raw)
    const value = Number(raw)
    if (raw.trim() === '' || !Number.isInteger(value) || value < SHUTDOWN_GRACE_MIN || value > SHUTDOWN_GRACE_MAX) {
      setGraceError('请填 0–60 之间的整数分钟，当前值不会保存。')
      return
    }
    setGraceError(null)
    patch({ shutdownGraceMinutes: value })
  }

  /**
   * 「随 Windows 登录启动」勾了就算数：立刻把整份草稿交给主进程写登录项，不等防抖。
   * 失败则把复选框退回点击前的值，并在行内说明，别让界面显示一个磁盘上没有的状态。
   */
  const toggleLaunchAtLogin = async (next: boolean) => {
    if (loginBusy) return
    const previous = draft.launchAtLogin === true
    setLoginBusy(true)
    setLoginStatus(null)
    setLoginError(null)
    setDraft(current => ({ ...current, launchAtLogin: next }))
    let ok = false
    try {
      ok = await onSave(composePayload({ ...draft, launchAtLogin: next }))
    } catch {
      ok = false
    }
    if (ok) {
      setLoginStatus(next ? '已写入登录项，下次登录 Windows 时生效。' : '已移除登录项，下次登录 Windows 时不再自动启动。')
    } else {
      setDraft(current => ({ ...current, launchAtLogin: previous }))
      setLoginError('登录项没有写入，开关已恢复原状；可以稍后重试，或改一下别的字段让自动保存再写一次。')
    }
    setLoginBusy(false)
  }

  const windows = isWindowsHost()

  /** 底部那一行自动保存状态：四态各有各的话，失败时旁边再给一枚重试按钮。 */
  const saveStatusText = savePhase === 'pending'
    ? '正在自动保存…（停止输入约 0.6 秒后写盘）'
    : savePhase === 'saved'
      ? `已自动保存 · ${savedAtText(savedAt ?? clock, clock)}`
      : savePhase === 'error'
        ? '自动保存失败，改动还留在这一页的草稿里。'
        : '改完即自动保存：停止输入约 0.6 秒后写盘。'

  return (
    <div className="home-tab-page">
      <main className="settings-content">
        <div className="settings-stack">
          <Section icon={<Palette size={16} />} title="外观" desc="界面主题、主题色、透明度与启动器图标；改完即自动保存，选的时候就能看到效果。">
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
            <div className="login-item-row">
              <label className="check-field">
                <input
                  type="checkbox"
                  aria-label="随 Windows 登录启动"
                  checked={draft.launchAtLogin ?? false}
                  disabled={loginBusy || busy}
                  onChange={event => { void toggleLaunchAtLogin(event.target.checked) }}
                />
                <span><strong>随 Windows 登录启动</strong><small>开机后自动把启动器收进托盘，不打开主窗口。勾选后立刻写入 Windows 登录项，不等下面的自动保存。</small></span>
              </label>
              {loginBusy && <p className="settings-field-status" role="status">正在写入登录项…</p>}
              {loginStatus && <p className="settings-field-status" role="status">{loginStatus}</p>}
              {loginError && <p className="settings-field-error" role="alert">{loginError}</p>}
            </div>
            <label className="check-field">
              <input
                type="checkbox"
                aria-label="启动器启动时请求管理员权限"
                checked={draft.launchElevated === true}
                disabled={!windows}
                onChange={event => patch({ launchElevated: event.target.checked })}
              />
              <span>
                <strong>启动器启动时请求管理员权限</strong>
                <small>开启后每次启动启动器都会弹一次 UAC 确认；启动器里的启动/停止整合包等操作都继承这份管理员权限，不会再额外弹窗。想只弹这一次，就把各整合包的「管理员」勾选取消。这一项随自动保存写入，下次启动启动器时生效。</small>
              </span>
            </label>
            {!windows && <p className="settings-field-note">仅 Windows 支持：当前系统无法在启动时请求管理员权限，这一项已禁用。</p>}
            <label className="check-field">
              <input
                type="checkbox"
                aria-label="停止提权整合包时允许弹出一次管理员权限请求"
                checked={draft.elevatedStopPrompt !== false}
                onChange={event => patch({ elevatedStopPrompt: event.target.checked })}
              />
              <span><strong>停止提权整合包时允许弹出一次管理员权限请求</strong><small>以管理员权限运行的整合包，在监督进程不在时只能靠提权结束；关掉后只显示可执行的命令。</small></span>
            </label>
            <label className="check-field">
              <input type="checkbox" checked={draft.openAfterLaunch} onChange={event => patch({ openAfterLaunch: event.target.checked })} />
              <span><strong>启动后打开 Harness</strong><small>识别到本地 Web 地址时，在默认浏览器中打开。</small></span>
            </label>
            <label className="form-field">
              <span>退出启动器时如何处理运行中的整合包</span>
              <select
                value={draft.packExitPolicy === 'stop' ? 'stop' : 'ask'}
                onChange={event => patch({ packExitPolicy: event.target.value === 'stop' ? 'stop' : 'ask' })}
              >
                <option value="ask">每次询问</option>
                <option value="stop">停止整合包</option>
              </select>
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                aria-label="任务完成后自动关机"
                checked={draft.shutdownWhenIdle ?? false}
                onChange={event => patch({ shutdownWhenIdle: event.target.checked })}
              />
              <span><strong>任务完成后自动关机</strong><small>所有整合包都空闲超过下面的判定时间后关闭这台电脑；默认关闭，需要在启动页开关上确认一次。</small></span>
            </label>
            <label className="form-field">
              <span>空闲判定（分钟）</span>
              <div className="settings-number-field">
                <input
                  type="number"
                  min={SHUTDOWN_IDLE_MIN}
                  max={SHUTDOWN_IDLE_MAX}
                  step={1}
                  aria-label="空闲判定（分钟）"
                  aria-invalid={idleError !== null}
                  value={idleText}
                  onChange={event => updateIdleMinutes(event.target.value)}
                />
                <small className="settings-field-note">1–1440，默认 {SHUTDOWN_IDLE_DEFAULT}。</small>
                {idleError && <small className="settings-field-error" role="alert">{idleError}</small>}
              </div>
            </label>
            <label className="form-field">
              <span>关机前等待取消（分钟）</span>
              <div className="settings-number-field">
                <input
                  type="number"
                  min={SHUTDOWN_GRACE_MIN}
                  max={SHUTDOWN_GRACE_MAX}
                  step={1}
                  aria-label="关机前等待取消（分钟）"
                  aria-invalid={graceError !== null}
                  value={graceText}
                  onChange={event => updateGraceMinutes(event.target.value)}
                />
                <small className="settings-field-note">
                  0–60，默认 {SHUTDOWN_GRACE_DEFAULT}{draft.shutdownGraceMinutes === 0 ? '；不等待，立即关机' : ''}。
                </small>
                {graceError && <small className="settings-field-error" role="alert">{graceError}</small>}
              </div>
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                aria-label="关机前先停止所有整合包"
                checked={draft.shutdownStopPacks !== false}
                onChange={event => patch({ shutdownStopPacks: event.target.checked })}
              />
              <span><strong>关机前先停止所有整合包</strong><small>避免关机时留下半截进程；默认打开。</small></span>
            </label>
            {/* 路径 / 参数 / 镜像 / 代理这类长串输入按防抖写盘（不做 blur 提交）：边打字边改草稿，停手 600ms 才落盘，粘贴整条路径也只写一次。 */}
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
            {/* 镜像与代理同为长串输入，跟路径一样走防抖自动保存，地址打到一半不会写盘。 */}
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
            <label className="form-field"><span>参数</span><input value={argsText} onChange={event => updateArgsText(event.target.value)} /></label>
            <label className="form-field"><span>首选 Web 端口</span><input type="number" min={1} max={65535} step={1} value={draft.webPort} onChange={event => patch({ webPort: Number(event.target.value) })} /></label>
            <p className="settings-advanced-note">DSH Copilot：默认模式会把自定义内容追加到内置提示词；开发者模式可替换基础提示词，但凭据保护、工作区边界和操作审批始终有效。</p>
            <label className="check-field"><input type="checkbox" checked={Boolean(draft.aiDeveloperMode)} onChange={event => patch({ aiDeveloperMode: event.target.checked })} /><span><strong>开发者模式</strong><small>允许使用下面的内容替换 Copilot 基础 persona。</small></span></label>
            <label className="form-field copilot-prompt-field"><span>AI 分析提示词</span><textarea rows={7} value={draft.aiPrompt ?? ''} placeholder="留空使用内置 DSH Copilot 提示词。" onChange={event => patch({ aiPrompt: event.target.value })} /><small>{draft.aiDeveloperMode ? '当前：替换基础 persona；固定安全规则仍会自动追加。' : '当前：作为附加开发指引追加到内置提示词。'}</small></label>
            <div className="settings-inline-actions"><button type="button" className="secondary-button" onClick={() => patch({ aiPrompt: '' })}>恢复默认提示词</button></div>
          </details>

          {saveError && <div className="error-banner settings-save-error" role="alert">{saveError}</div>}
          <div className="settings-home-actions">
            <span className={`settings-home-actions-hint is-${savePhase}`} role="status" aria-live="polite">{saveStatusText}</span>
            {savePhase === 'error' && (
              <button type="button" className="primary-command" onClick={() => { void flush() }}><RotateCcw size={16} />重试保存</button>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
