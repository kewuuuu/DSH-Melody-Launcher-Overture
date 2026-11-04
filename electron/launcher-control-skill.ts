import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MARKER = '<!-- dsh-launcher-managed-control-skill:v1 -->'

export async function ensureLauncherControlSkill(options: {
  packHome: string
  cliPath: string
  userData: string
  packId?: string
  nodePath?: string
}): Promise<{ path: string; status: 'installed' | 'updated' | 'preserved' }> {
  if (!path.isAbsolute(options.packHome) || !path.isAbsolute(options.cliPath) || !path.isAbsolute(options.userData)) throw new Error('packHome, cliPath and userData must be absolute paths')
  const directory = path.join(options.packHome, 'skills', 'launcher-control')
  const target = path.join(directory, 'SKILL.md')
  // Do not follow a user-created skill directory or skills root into another home.
  for (const candidate of [options.packHome, path.join(options.packHome, 'skills'), directory, target]) {
    try { if ((await lstat(candidate)).isSymbolicLink()) return { path: target, status: 'preserved' } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  let previous: string | undefined
  try { previous = await readFile(target, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (previous !== undefined && !previous.includes(MARKER)) return { path: target, status: 'preserved' }

  const source = await readFile(options.cliPath, 'utf8')
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const tools = path.join(options.userData, 'tools')
  const cli = path.join(tools, 'launcher-control-' + hash + '.cjs')
  await mkdir(tools, { recursive: true })
  try { await writeFile(cli, source, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const node = options.nodePath || 'node'
  const packId = options.packId || '<pack-id-from-list>'
  // A JSON argv array is shell-independent: execute it directly, never eval a command string.
  const command = (suffix: string[]) => JSON.stringify([node, cli, '--user-data', options.userData, ...suffix])
  const content = [
    '---',
    'name: launcher-control',
    'description: Control DSH Launcher packs and settings. Use when the user asks to list packs, start, stop or restart a specific pack, change its port or autostart, or manage pack resources through the launcher.',
    '---', '', MARKER, '',
    '# DSH Launcher control', '',
    'Use the Node CLI below through the shell/command tool. Each example is an exact JSON argv array: pass its entries as separate process arguments. For PowerShell use & followed by individually quoted arguments; for bash quote each argument separately. Do not paste the array as shell syntax.',
    'The absolute CLI path is outside the packaged ASAR. --user-data selects the correct launcher instance. Alternatively set DSH_LAUNCHER_USER_DATA to ' + JSON.stringify(options.userData) + '. Never print or copy launcher-control.json: it contains a local authentication token.', '',
    'First list packs and use the exact id returned; do not infer an id from a display name, current working directory, or active UI selection:',
    command(['pack', 'list', '--json']), '',
    'This skill was generated for pack ID ' + JSON.stringify(options.packId || 'unknown: resolve from list') + '. Every mutation of an existing pack must explicitly target its ID.', '',
    'Start, stop, restart, and inspect pack configuration:',
    command(['pack', 'start', packId, '--json']),
    command(['pack', 'stop', packId, '--json']),
    command(['pack', 'restart', packId, '--json']),
    command(['pack', 'config', 'get', packId, '--json']),
    command(['pack', 'config', 'set', packId, '--port', '3081', '--port-mode', 'fixed', '--auto-start', 'false', '--json']), '',
    'Stopping or restarting the pack hosting this conversation disconnects its DSH Web and may interrupt this tool call. Explain that consequence before acting on the user request. Reconnect to the pack after restart; use a different running pack or an external terminal to start it after stopping.',
    'Port configuration applies on the next start/restart. runAsAdmin can trigger a UAC prompt; only set it when explicitly requested. Do not change the shared runtime installation to alter pack settings.', '',
    'Read and patch launcher settings:',
    command(['settings', 'get', '--json']),
    command(['settings', 'set', '--args', JSON.stringify({ openAfterLaunch: false }), '--json']), '',
    'Additional explicit pack operations (backend support determines availability):',
    command(['request', 'pack.openWeb', packId, '--json']),
    command(['request', 'pack.resources.list', packId, '--args', JSON.stringify({ kind: 'skills' }), '--json']),
    command(['request', 'pack.resources.enabled', packId, '--args', JSON.stringify({ kind: 'skills', name: '<resource-name>', enabled: false }), '--json']),
    command(['request', 'pack.resources.remove', packId, '--args', JSON.stringify({ kind: 'skills', name: '<resource-name>' }), '--json']),
    command(['request', 'pack.resources.link', packId, '--args', JSON.stringify({ kind: 'skills', name: '<resource-name>', sourcePackId: '<source-pack-id>' }), '--json']),
    command(['request', 'pack.market.install', packId, '--args', JSON.stringify({ name: '<plugin-package>' }), '--json']), '',
    'Resource kind is plugins, skills, or presets. The request form passes a dotted command plus JSON args to the same launcher API. Use only commands supported by the launcher. On nonzero exit read stderr; do not report success or retry destructive operations blindly.',
    'The launcher must already be running. Only use --launcher with a known executable path when the user asks to start the launcher. Never guess an executable or launch another DSH host to work around a connection error.', '',
  ].join('\n')
  if (previous === content) return { path: target, status: 'preserved' }
  await mkdir(directory, { recursive: true })
  if (previous === undefined) {
    try { await writeFile(target, content, { flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { path: target, status: 'preserved' }; throw error }
  } else {
    const temporary = target + '.' + randomBytes(8).toString('hex') + '.tmp'
    await writeFile(temporary, content, { flag: 'wx' })
    await rename(temporary, target)
  }
  return { path: target, status: previous === undefined ? 'installed' : 'updated' }
}
