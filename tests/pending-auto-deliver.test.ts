import { describe, expect, it } from 'vitest'
import { pendingDeliveryFor } from '../electron/launcher-control'

describe('续接投递触发条件', () => {
  it('包启动成功且拿到 URL 时投递', () => {
    expect(pendingDeliveryFor({ command: 'pack.start', packId: 'web' }, { running: true, url: 'http://127.0.0.1:3080/?token=t' }))
      .toEqual({ packId: 'web', url: 'http://127.0.0.1:3080/?token=t' })
  })

  it('重启同样触发，非启动命令一律不触发', () => {
    expect(pendingDeliveryFor({ command: 'pack.restart', packId: 'web' }, { url: 'http://127.0.0.1:3081/' })).not.toBeNull()
    for (const command of ['pack.stop', 'pack.openWeb', 'pack.list', 'pack.config.set']) {
      expect(pendingDeliveryFor({ command, packId: 'web' }, { url: 'http://127.0.0.1:3081/' })).toBeNull()
    }
  })

  it('没有 URL、没有包 ID 或结果为空都不投递', () => {
    expect(pendingDeliveryFor({ command: 'pack.start', packId: 'web' }, { running: true, url: null })).toBeNull()
    expect(pendingDeliveryFor({ command: 'pack.start' }, { url: 'http://127.0.0.1:3080/' })).toBeNull()
    expect(pendingDeliveryFor({ command: 'pack.start', packId: 'web' }, null)).toBeNull()
    expect(pendingDeliveryFor({ command: 'pack.start', packId: 'web' }, { url: '' })).toBeNull()
  })
})
