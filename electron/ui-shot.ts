import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'

/** 一级导航的标签，顺序与 src/lib/nav.ts 的 HOME_TABS 一致。 */
const SHOT_TABS = ['启动', '整合包', 'DSH版本', '插件', '技能', '预设', '设置'] as const

/**
 * 开发者自查界面的开关：--ui-shots=<目录>。
 * 不传就什么都不做——这是给人看截图用的旁路，不参与任何产品流程。
 */
export function uiShotDirectory(argv: readonly string[]): string | null {
  const arg = argv.find(item => item.startsWith('--ui-shots='))
  if (!arg) return null
  const directory = arg.slice('--ui-shots='.length).trim()
  return directory || null
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function clickTabScript(label: string): string {
  const wanted = JSON.stringify(label)
  return `(() => {
    const buttons = [...document.querySelectorAll('.topbar-tabs button')]
    const hit = buttons.find(button => (button.textContent || '').trim() === ${wanted})
    if (!hit) return false
    hit.click()
    return true
  })()`
}

type ShotPosition = 'top' | 'middle' | 'bottom'

function scrollScript(position: ShotPosition): string {
  // 每个栏目用了哪层当滚动容器并不统一，所以按「真的能滚」来判断，别写死类名。
  const offset = position === 'top' ? '0' : position === 'middle' ? 'element.scrollHeight / 2' : 'element.scrollHeight'
  return `(() => {
    let scrolled = 0
    for (const element of document.querySelectorAll('*')) {
      if (element.scrollHeight <= element.clientHeight + 4) continue
      const overflowY = getComputedStyle(element).overflowY
      if (overflowY !== 'auto' && overflowY !== 'scroll') continue
      element.scrollTop = ${offset}
      scrolled += 1
    }
    return scrolled
  })()`
}

const SHOT_POSITIONS: ReadonlyArray<{ position: ShotPosition; suffix: string }> = [
  { position: 'top', suffix: '' },
  { position: 'middle', suffix: '-中部' },
  { position: 'bottom', suffix: '-底部' },
]

/** 逐栏目截图（首屏 / 中部 / 底部），用于人眼复核界面；每一步都写进 <目录>/log.txt。 */
export async function captureUiShots(window: BrowserWindow, directory: string): Promise<string[]> {
  await mkdir(directory, { recursive: true })
  const logFile = path.join(directory, 'log.txt')
  const lines: string[] = []
  const note = async (line: string) => {
    lines.push(line)
    await writeFile(logFile, lines.join('\n') + '\n', 'utf8')
  }
  await note('start ' + new Date().toISOString())
  try {
    if (window.webContents.isLoading()) {
      await new Promise<void>(resolve => window.webContents.once('did-finish-load', () => resolve()))
    }
    await wait(2000)
    const tabCount = await window.webContents.executeJavaScript("document.querySelectorAll('.topbar-tabs button').length")
    await note('tabs=' + tabCount)
    const written: string[] = []
    for (const label of SHOT_TABS) {
      const clicked = await window.webContents.executeJavaScript(clickTabScript(label))
      await note('click ' + label + ' => ' + clicked)
      if (!clicked) continue
      await wait(800)
      for (const { position, suffix } of SHOT_POSITIONS) {
        await window.webContents.executeJavaScript(scrollScript(position))
        await wait(200)
        const image = await window.webContents.capturePage()
        const file = path.join(directory, `${label}${suffix}.png`)
        await writeFile(file, image.toPNG())
        written.push(file)
      }
      await window.webContents.executeJavaScript(scrollScript('top'))
      await note('shot ' + label)
    }
    await note('done ' + written.length)
    return written
  } catch (error) {
    await note('error ' + String(error instanceof Error ? error.stack || error.message : error))
    throw error
  }
}
