import { describe, expect, it } from 'vitest'
import { uiShotDirectory } from '../electron/ui-shot'

describe('uiShotDirectory', () => {
  it('没有这个参数时返回 null', () => {
    expect(uiShotDirectory(['app.exe', '--background'])).toBeNull()
  })

  it('读出目录参数', () => {
    expect(uiShotDirectory(['app.exe', '--ui-shots=D:/shots'])).toBe('D:/shots')
  })

  it('参数为空字符串时按未开启处理', () => {
    expect(uiShotDirectory(['app.exe', '--ui-shots=   '])).toBeNull()
  })
})
