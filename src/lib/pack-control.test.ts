import { describe, expect, it } from 'vitest'
import { sortPacks, type ControlledPack } from './pack-control'

const pack = (id: string, name: string, port: number, date: string, pinnedAt: string | null = null) => ({
  id, name, installedAt: date,
  config: { portMode: 'auto', port, runAsAdmin: false, autoStart: false, pinnedAt },
  runtime: { port: null, running: false },
}) as ControlledPack
const packs = [pack('b', 'Beta', 4200, '2025-03-01'), pack('a', 'Alpha', 4300, '2025-01-01'), pack('c', 'Gamma', 4100, '2025-02-01')]
describe('pack dashboard ordering', () => {
  it('sorts each supported field in both directions without mutating input', () => {
    expect(sortPacks(packs, 'name', false).map(p => p.id)).toEqual(['a', 'b', 'c'])
    expect(sortPacks(packs, 'name', true).map(p => p.id)).toEqual(['c', 'b', 'a'])
    expect(sortPacks(packs, 'created', false).map(p => p.id)).toEqual(['a', 'c', 'b'])
    expect(sortPacks(packs, 'created', true).map(p => p.id)).toEqual(['b', 'c', 'a'])
    expect(sortPacks(packs, 'port', false).map(p => p.id)).toEqual(['c', 'b', 'a'])
    expect(sortPacks(packs, 'port', true).map(p => p.id)).toEqual(['a', 'b', 'c'])
    expect(packs.map(p => p.id)).toEqual(['b', 'a', 'c'])
  })
  it('keeps pins in timestamp order independently of ordinary sort and direction', () => {
    const pinned = [pack('new', 'AAA', 1000, '2025-01-01', '2025-06-02'), pack('old', 'ZZZ', 9000, '2025-12-01', '2025-06-01'), ...packs]
    for (const field of ['name', 'created', 'port'] as const) {
      for (const descending of [false, true]) expect(sortPacks(pinned, field, descending).slice(0, 2).map(p => p.id)).toEqual(['old', 'new'])
    }
  })
  it('uses the actual running port and stable ID ties', () => {
    const active = { ...packs[0], runtime: { ...packs[0].runtime, port: 1000 } }
    expect(sortPacks([packs[2], active], 'port', false)[0].id).toBe('b')
    const tied = [pack('z', 'same', 1000, '2025-01-01'), pack('a', 'same', 1000, '2025-01-01')]
    expect(sortPacks(tied, 'name', true).map(p => p.id)).toEqual(['a', 'z'])
  })
})
