import { createPackControl } from '../../electron/pack-control'
import { DSH_PACKAGE_NAME } from '../../src/constants'
import type { AppSettings } from '../../src/types'
import path from 'node:path'

export function fixtureControl(root: string, userData: string) {
  const settings = {
    dshHome: path.join(root, 'home'), dshInstallPath: root, workspace: root, profileName: 'alpha',
    activePackId: 'alpha', launchExecutable: process.execPath,
    launchArgs: [path.join(root, 'server.cjs'), DSH_PACKAGE_NAME, 'web'], webPort: 45000, openAfterLaunch: false,
  } as AppSettings
  return createPackControl({
    userData, registryPath: path.join(root, 'packs.json'), readSettings: async () => settings,
    resolveSettings: async (_record, config) => ({ ...settings, webPort: config.port }),
    runtimeOptions: () => ({
      prepareNodeRuntime: async () => ({ node: process.execPath, npm: 'npm', npx: 'npx', root, managed: false }),
      fallbackWorkspace: () => root, emitOutput: () => undefined, emitState: () => undefined, openExternal: () => undefined,
    }),
    openExternal: async () => undefined,
    externalRuntime: { scan: async () => new Map() },
    probePackActiveSessions: async () => 0,
  })
}

if (process.send && process.argv.includes('--owner-fixture')) {
  const root = process.argv.at(-1)!
  const control = fixtureControl(root, path.join(root, 'owner'))
  try {
    await control.execute({ command: 'pack.start', packId: 'alpha' })
    process.send('started')
    process.on('message', async message => {
      if (message !== 'leave') return
      try { await control.shutdown('keep'); process.exit(0) }
      catch (error) { process.send?.(String(error)); await control.shutdown('stop'); process.exit(1) }
    })
  } catch (error) { process.send(String(error)); await control.shutdown('stop'); process.exit(1) }
}
