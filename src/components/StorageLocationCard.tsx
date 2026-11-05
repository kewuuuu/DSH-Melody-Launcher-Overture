import { Check, Copy, FolderOpen, History, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useStorageLocation } from '../hooks/use-storage-location'
import type { StorageSource } from '../types'
import './storage-location.css'

/**
 * 数据目录（app 的 userData）的来源 → 中文说明。
 * 只读 storage.get() 的 source 字段，不看路径长什么样：来源由主进程解析，渲染层不猜。
 */
const STORAGE_SOURCE_LABELS: Record<StorageSource, string> = {
  argument: '来自启动参数 --data-dir',
  pointer: '来自 launcher-storage.json',
  portable: 'EXE 同级的 launcher-data（便携版默认）',
  install: 'EXE 同级的 launcher-data（解压版默认）',
  development: '开发态默认位置（%APPDATA%\\dsh-launcher）',
}

/**
 * 设置页「存储位置」区块：显示当前数据目录与它的来源，并给三枚动作
 * （选目录 / 接管旧版数据 / 恢复默认位置）以及切换后的重启入口。
 */
export function StorageLocationCard() {
  const storage = useStorageLocation()
  const [copied, setCopied] = useState(false)
  const state = storage.state

  const copyPath = async () => {
    if (!state) return
    try {
      await navigator.clipboard.writeText(state.dataDir)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // 剪贴板不可用（预览态 / 无权限）：路径本身就是可选中的文本，不额外报错。
    }
  }

  return (
    <section className="settings-panel" aria-label="存储位置">
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><FolderOpen size={17} /><span>存储位置</span></div>
      </div>
      <div className="settings-hint">启动器的数据都在这个目录里：整合包登记 packs.json、包目录 dsh-packs、DSH 运行时 dsh-runtime、插件存储 plugin-store 与 settings.json。改过之后要重启启动器才生效。</div>

      {storage.error && (
        <div className="error-banner">
          <span>{storage.error}</span>
          <button type="button" onClick={storage.reload}>重试</button>
        </div>
      )}

      {!state && !storage.error && (
        <div className="settings-empty"><LoaderCircle className="spin" size={18} />正在读取数据目录…</div>
      )}

      {state && (
        <>
          <div className="storage-location-path">
            <code>{state.dataDir}</code>
            <button type="button" className="icon-button" onClick={() => { void copyPath() }} title="复制路径" aria-label="复制数据目录路径">
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>

          <div className="settings-about-rows">
            <div><span>来源</span><strong>{STORAGE_SOURCE_LABELS[state.source]}</strong></div>
            {state.pointerFile && <div><span>指针文件</span><strong>{state.pointerFile}</strong></div>}
          </div>

          {state.warning && (
            <div className="storage-location-warning" role="alert"><TriangleAlert size={14} /><span>{state.warning}</span></div>
          )}

          {state.restartRequired && (
            <div className="storage-location-restart">
              <TriangleAlert size={14} />
              <span>数据目录已经改过，重启启动器之后才会生效。</span>
              <button type="button" className="primary-command" disabled={storage.busy !== null} onClick={storage.relaunch}>立即重启启动器</button>
            </div>
          )}

          <div className="storage-location-actions">
            <button type="button" className="secondary-button" disabled={storage.busy !== null} onClick={storage.choose}>
              {storage.busy === 'choose' ? <LoaderCircle size={14} className="spin" /> : <FolderOpen size={14} />}选择文件夹…
            </button>
            {state.legacy.hasData && (
              <button type="button" className="secondary-button" disabled={storage.busy !== null} onClick={storage.takeOverLegacy}>
                <History size={14} />接管旧版数据
              </button>
            )}
            <button type="button" className="secondary-button" disabled={storage.busy !== null} onClick={storage.reset}>
              <RefreshCw size={14} />恢复默认位置
            </button>
          </div>

          {state.legacy.hasData && (
            <p className="storage-location-note">旧版数据还在 {state.legacy.dataDir}；点「接管旧版数据」把数据目录指回那里，重启后原来的整合包与设置照常可用。</p>
          )}
        </>
      )}
    </section>
  )
}
