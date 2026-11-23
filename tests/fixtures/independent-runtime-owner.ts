import { createRuntimeController } from '../../electron/runtime'
import { configureProcessTracker, shutdownTrackedProcesses } from '../../electron/process'
import { createProcessSupervisor } from '../../electron/process-supervisor'
import path from 'node:path'

const [root, mode] = process.argv.slice(2)
const supervisor = await createProcessSupervisor({ root: path.join(root, 'supervisor'), executable: process.execPath })
configureProcessTracker(supervisor)
const controller = createRuntimeController({
  readSettings: async () => ({
    dshHome: root, dshInstallPath: root, profileName: 'fixture', workspace: root,
    launchExecutable: process.execPath,
    launchArgs: ['-e', 'let i=0; setInterval(() => { console.log("tick:" + ++i); console.error("err:" + i) }, 30)'],
    webPort: 39991, openAfterLaunch: false,
  }),
  prepareNodeRuntime: async () => ({
    root, node: process.execPath, npm: '', npx: '', managed: false,
  }),
  fallbackWorkspace: () => root,
  emitOutput: () => {}, emitState: () => {}, openExternal: () => {},
  preserveOnLauncherExit: { root: path.join(root, 'sessions') },
})
await controller.start()
const session = await controller.independentSession?.()
if (!session) throw new Error('Live process identity was not confirmed')
await new Promise<void>(resolve => { process.stdout.write(JSON.stringify(session) + '\n', () => resolve()) })
if (mode === 'shutdown') {
  await supervisor.shutdown()
  await shutdownTrackedProcesses()
} else {
  process.exit(0)
}
