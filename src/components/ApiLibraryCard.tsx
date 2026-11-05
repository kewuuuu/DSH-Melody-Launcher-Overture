import { Check, Cpu, LoaderCircle, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useLauncherApi } from '../api/client'
import type { CustomApiProtocol, LauncherApiEntry, LauncherApiEntryInput } from '../types'
import './api-library.css'

/**
 * 启动器级 API 库：登记一次，多个整合包各取所需。
 * 密钥只写不读——界面永远拿不到明文，编辑时留空即保留原密钥。
 */

type FormState = {
  /** 编辑态的原始 route：改 route 时靠它定位原条目。 */
  originalRoute: string | null
  route: string
  displayName: string
  baseUrl: string
  protocol: CustomApiProtocol
  modelIds: string
  apiKey: string
}

const PROTOCOL_LABELS: Record<CustomApiProtocol, string> = {
  'openai-completions': 'OpenAI 兼容',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
}

const PROTOCOL_OPTIONS: ReadonlyArray<{ id: CustomApiProtocol; label: string }> = [
  { id: 'openai-completions', label: 'OpenAI 兼容（chat/completions）' },
  { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
]

/** route 会进环境变量名，因此只允许小写字母开头、段间单个连字符。 */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

const blankForm = (): FormState => ({
  originalRoute: null,
  route: '',
  displayName: '',
  baseUrl: '',
  protocol: 'openai-completions',
  modelIds: '',
  apiKey: '',
})

const formFromEntry = (entry: LauncherApiEntry): FormState => ({
  originalRoute: entry.route,
  route: entry.route,
  displayName: entry.displayName,
  baseUrl: entry.baseUrl,
  protocol: entry.protocol,
  modelIds: entry.modelIds.join(', '),
  apiKey: '',
})

/** 模型 ID 允许逗号（中英文）或换行分隔。 */
const parseModelIds = (text: string): string[] => text.split(/[,，\n]/).map(item => item.trim()).filter(Boolean)

const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback

function validate(form: FormState): string | null {
  if (!ROUTE_PATTERN.test(form.route.trim())) return '路由只能用小写字母、数字和单个连字符，且以字母开头，例如 library-openai。'
  if (!form.displayName.trim()) return '请填写显示名称。'
  const baseUrl = form.baseUrl.trim()
  if (!/^https?:\/\/\S+$/.test(baseUrl)) return 'Base URL 需要以 http:// 或 https:// 开头。'
  if (parseModelIds(form.modelIds).length === 0) return '至少填写一个模型 ID，多个用逗号或换行分隔。'
  return null
}

interface Props {
  /** 条目变更后通知外部（整合包页的可用列表可能需要重新读取）。 */
  onChanged?: () => void
}

export function ApiLibraryCard({ onChanged }: Props) {
  const api = useLauncherApi()
  // null = 还没读到；读取失败时保持 null 并只显示错误。
  const [entries, setEntries] = useState<LauncherApiEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setEntries(await api.apiLibrary.list())
    } catch (cause) {
      setError(errorText(cause, '读取 API 库失败，请稍后重试。'))
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  const submit = async () => {
    if (!form) return
    const invalid = validate(form)
    if (invalid) { setFormError(invalid); return }
    setWorking(true); setFormError(null); setError(null)
    try {
      const payload: LauncherApiEntryInput = {
        ...(form.originalRoute ? { originalRoute: form.originalRoute } : {}),
        route: form.route.trim(),
        displayName: form.displayName.trim(),
        baseUrl: form.baseUrl.trim(),
        protocol: form.protocol,
        modelIds: parseModelIds(form.modelIds),
        // 留空即不下发 apiKey：编辑表示保留原密钥，新建表示该服务无需鉴权。
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      }
      setEntries(await api.apiLibrary.save(payload))
      setForm(null)
      onChanged?.()
    } catch (cause) {
      setFormError(errorText(cause, '保存 API 失败，请检查填写内容。'))
    } finally {
      setWorking(false)
    }
  }

  const remove = async (route: string) => {
    setWorking(true); setError(null)
    try {
      setEntries(await api.apiLibrary.remove(route))
      setConfirming(null)
      onChanged?.()
    } catch (cause) {
      setError(errorText(cause, '删除 API 失败，请稍后重试。'))
    } finally {
      setWorking(false)
    }
  }

  const update = (patch: Partial<FormState>) => setForm(current => (current ? { ...current, ...patch } : current))

  return (
    <section className="settings-panel api-library-panel" aria-label="API 库">
      <div className="settings-panel-heading">
        <div className="settings-panel-title">
          <Cpu size={17} />
          <span>API 库</span>
          {entries && entries.length > 0 && <span className="settings-count">{entries.length}</span>}
        </div>
        <div className="api-library-heading-actions">
          <button type="button" className="icon-button" aria-label="刷新 API 库" disabled={working} onClick={() => void load()}>
            <RefreshCw size={15} />
          </button>
          <button type="button" className="secondary-button" disabled={working || form !== null} onClick={() => { setForm(blankForm()); setFormError(null) }}>
            新增 API
          </button>
        </div>
      </div>
      <p className="settings-hint">启动器级 API：在这里登记一次，再在「整合包配置 → API」里按包授予。密钥存放在启动器数据目录，界面只显示是否已保存。</p>

      {error && <div className="error-banner" role="alert">{error}</div>}

      {form ? (
        <form
          className="api-library-form"
          onSubmit={event => { event.preventDefault(); void submit() }}
        >
          <div className="api-library-field-grid">
            <label className="form-field">
              <span>显示名称</span>
              <input value={form.displayName} placeholder="如 OpenAI 官方" onChange={event => update({ displayName: event.target.value })} />
            </label>
            <label className="form-field">
              <span>路由</span>
              <input value={form.route} placeholder="如 library-openai" onChange={event => update({ route: event.target.value })} />
            </label>
          </div>
          <label className="form-field">
            <span>Base URL</span>
            <input value={form.baseUrl} placeholder="https://api.openai.com/v1" onChange={event => update({ baseUrl: event.target.value })} />
          </label>
          <label className="form-field">
            <span>协议</span>
            <select value={form.protocol} onChange={event => update({ protocol: event.target.value as CustomApiProtocol })}>
              {PROTOCOL_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className="form-field">
            <span>模型 ID</span>
            <input value={form.modelIds} placeholder="gpt-5, gpt-5-mini（逗号或换行分隔）" onChange={event => update({ modelIds: event.target.value })} />
          </label>
          <label className="form-field">
            <span>API Key</span>
            <input
              type="password"
              autoComplete="new-password"
              value={form.apiKey}
              placeholder={form.originalRoute ? '留空表示保留原密钥' : '留空表示该服务无需鉴权'}
              onChange={event => update({ apiKey: event.target.value })}
            />
            <small>密钥只写不读：保存后界面不会再显示明文。</small>
          </label>
          {formError && <p className="api-library-error" role="alert">{formError}</p>}
          <div className="api-library-form-actions">
            <button type="submit" className="primary-command" disabled={working}>
              {working ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
              {form.originalRoute ? '保存修改' : '添加到 API 库'}
            </button>
            <button type="button" className="secondary-button" disabled={working} onClick={() => { setForm(null); setFormError(null) }}>
              取消
            </button>
          </div>
        </form>
      ) : entries === null ? (
        !error && <div className="settings-empty"><LoaderCircle className="spin" size={16} />正在读取 API 库…</div>
      ) : entries.length === 0 ? (
        <div className="settings-empty api-library-empty">还没有登记任何 API。点右上角「新增 API」填入服务地址与密钥，之后就能按包授予。</div>
      ) : (
        <div className="api-library-list">
          {entries.map(entry => (
            <div className="api-library-row" key={entry.route}>
              <div className="api-library-row-main">
                <strong>{entry.displayName}</strong>
                <code>{entry.route}</code>
                <span className="api-library-model-count">{entry.modelIds.length > 0 ? `${entry.modelIds.length} 个模型` : '未指定模型'}</span>
                <small>{PROTOCOL_LABELS[entry.protocol]} · {entry.baseUrl}</small>
              </div>
              <div className="api-library-row-actions">
                <span className={entry.hasApiKey ? 'api-library-key is-set' : 'api-library-key'}>{entry.hasApiKey ? '已保存密钥' : '无需鉴权'}</span>
                <button type="button" className="secondary-button" disabled={working} onClick={() => { setForm(formFromEntry(entry)); setFormError(null) }}>
                  <Pencil size={13} />编辑
                </button>
                {confirming === entry.route ? (
                  <>
                    <button type="button" className="secondary-button is-danger" disabled={working} onClick={() => void remove(entry.route)}>确认删除</button>
                    <button type="button" className="secondary-button" disabled={working} onClick={() => setConfirming(null)}>取消</button>
                  </>
                ) : (
                  <button type="button" className="secondary-button" aria-label={`删除 ${entry.displayName}`} disabled={working} onClick={() => setConfirming(entry.route)}>
                    <Trash2 size={13} />删除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
