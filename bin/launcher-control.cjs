#!/usr/bin/env node
'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const HELP = `DSH Launcher control (Node >=20)
  pack list
  pack start|stop|restart <pack-id>
  pack stop <pack-id> --no-elevated
  pack restart <pack-id> --resume "<prompt>" [--session <session-id>]
  pack config get <pack-id>
  pack config set <pack-id> --port 3081 --port-mode fixed --auto-start true
  pack upgrade <pack-id> --dsh-version <version>
  settings get
  settings set --args '{"openAfterLaunch":false}'
  settings launch-at-login [on|off]
  idle-shutdown status|arm|disarm|cancel
  api list
  api add <route> --name <name> --base-url <url> --protocol <protocol> --models a,b [--api-key <key>]
  api remove <route>
  pack api list <pack-id>
  pack api enable|disable <pack-id> <route>
  storage info
  storage set <absolute-directory>
  storage reset
  pending list [--pack <pack-id>]
  pending retry <id>
  pending discard <id>
  path migrate dshHome|dshInstallPath <absolute-directory>
  uninstall plan
  uninstall script --out <absolute-directory> [--delete-data]
  uninstall now --yes [--delete-data]
  resource <operation> <pack-id> --args '{...}'
  pack <operation> [pack-id] --args '{...}'
  request <dotted.command> [pack-id] --args '{...}'
Options: --json --user-data <directory> --launcher <explicit executable>
          --no-elevated (pack stop only: don't raise UAC, only the silent stop paths)
Config flags: --port, --port-mode, --run-as-admin, --auto-start, --pinned-at,
              --workspace, --launch-args '["web"]'
API flags (api add only): --name, --base-url, --protocol, --models, --api-key
Resume flags: --resume "<prompt>" --session <id> (both with pack restart only), --pack <id> (pending list only)
Upgrade flag: --dsh-version <version> (pack upgrade only; upgrades only, the pack must be stopped)
Protocols: openai-completions, openai-responses, anthropic-messages
Set DSH_LAUNCHER_USER_DATA instead of --user-data if desired.
--launcher starts only the executable supplied, when control is unavailable.
`
const FLAG_KEYS = ['user-data','launcher','args','port','port-mode','run-as-admin','auto-start','pinned-at','workspace','launch-args','name','base-url','protocol','models','api-key','resume','session','pack','out','dsh-version']
function objectJSON(value) {
  const result = JSON.parse(value)
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('--args requires a JSON object')
  return result
}
function parse(argv) {
  const flags = Object.create(null), words = []
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (!item.startsWith('--')) { words.push(item); continue }
    const key = item.slice(2)
    if (['json', 'help', 'keep-data', 'delete-data', 'yes', 'no-elevated'].includes(key)) { flags[key] = true; continue }
    if (!FLAG_KEYS.includes(key)) throw new Error('Unknown option: ' + item)
    if (i + 1 >= argv.length || argv[i+1].startsWith('--')) throw new Error('Missing value for ' + item)
    flags[key] = argv[++i]
  }
  if (flags.help) return { help: true }
  const group = words.shift(), action = words.shift()
  let command, packId, storageDir, apiRoute, apiEnabled, launchAtLogin, pendingPackId, pendingId, pathKind, pathTarget, uninstallOut
  if (group === 'request') { command = action; packId = words.shift() }
  else if (group === 'pack' && action === 'api') {
    const operation = words.shift()
    if (!['list', 'enable', 'disable'].includes(operation)) throw new Error('用法：pack api list <pack-id> | pack api enable|disable <pack-id> <route>')
    command = operation === 'list' ? 'pack.api.list' : 'pack.api.set'
    packId = words.shift()
    if (!packId) throw new Error('pack api 需要一个整合包 ID')
    if (operation !== 'list') {
      apiRoute = words.shift()
      if (!apiRoute) throw new Error('pack api ' + operation + ' 需要一个 API 路由')
      apiEnabled = operation === 'enable'
    }
  }
  else if (group === 'pack' && action === 'config') { command = 'pack.config.' + words.shift(); packId = words.shift(); if (!['pack.config.get','pack.config.set'].includes(command)) throw new Error('Use pack config get|set <pack-id>') }
  else if (group === 'api') {
    if (action === 'list') command = 'api.list'
    else if (action === 'add') { command = 'api.save'; apiRoute = words.shift(); if (!apiRoute) throw new Error('用法：api add <route> --name <name> --base-url <url> --protocol <protocol> --models a,b [--api-key <key>]') }
    else if (action === 'remove') { command = 'api.remove'; apiRoute = words.shift(); if (!apiRoute) throw new Error('用法：api remove <route>') }
    else throw new Error('用法：api list | api add <route> ... | api remove <route>')
  }
  else if (group === 'settings' && action === 'launch-at-login') {
    command = 'settings.launchAtLogin'
    const value = words.shift()
    if (value !== undefined && !['on', 'off'].includes(value)) throw new Error('用法：settings launch-at-login [on|off]')
    if (value !== undefined) launchAtLogin = value === 'on'
  }
  else if (group === 'storage') {
    command = 'storage.' + action
    if (!['storage.info','storage.set','storage.reset'].includes(command)) throw new Error('用法：storage info | storage set <绝对路径目录> | storage reset')
    if (command === 'storage.set') { storageDir = words.shift(); if (!storageDir) throw new Error('storage set 需要一个目录参数：storage set <绝对路径目录>') }
  }
  else if (group === 'pending') {
    if (!['list', 'retry', 'discard'].includes(action)) throw new Error('用法：pending list [--pack <id>] | pending retry <id> | pending discard <id>')
    command = 'pending.' + action
    if (action === 'list') {
      if (words.length) throw new Error('Unexpected positional arguments')
      if (flags.pack !== undefined) pendingPackId = flags.pack
    } else {
      pendingId = words.shift()
      if (!pendingId) throw new Error('pending ' + action + ' 需要一个续接请求 ID')
    }
  }
  else if (group === 'path') {
    if (action !== 'migrate') throw new Error('用法：path migrate dshHome|dshInstallPath <绝对路径目录>')
    command = 'path.migrate'
    pathKind = words.shift()
    if (!['dshHome', 'dshInstallPath'].includes(pathKind)) throw new Error('path migrate 的迁移目标只能是 dshHome 或 dshInstallPath')
    pathTarget = words.shift()
    if (!pathTarget) throw new Error('path migrate 需要一个目标目录：path migrate <dshHome|dshInstallPath> <绝对路径目录>')
    if (!path.isAbsolute(pathTarget)) throw new Error('path migrate 的目录必须是绝对路径，当前收到：' + pathTarget)
  }
  else if (group === 'uninstall') {
    if (!['plan', 'script', 'now'].includes(action)) throw new Error('用法：uninstall plan | uninstall script --out <绝对路径目录> | uninstall now --yes')
    if (action === 'plan') command = 'uninstall.plan'
    else if (action === 'script') {
      command = 'uninstall.script'
      const out = flags.out
      if (!out) throw new Error('uninstall script 需要一个导出目录：uninstall script --out <绝对路径目录>')
      if (!path.isAbsolute(out)) throw new Error('uninstall script 的 --out 必须是绝对路径，当前收到：' + out)
      uninstallOut = path.resolve(out)
    } else {
      if (!flags.yes) throw new Error('卸载会删除启动器文件，必须带 --yes 确认：uninstall now --yes')
      command = 'uninstall.run'
    }
  }
  else if (group === 'idle-shutdown') {
    if (!['status', 'arm', 'disarm', 'cancel'].includes(action)) throw new Error('用法：idle-shutdown status|arm|disarm|cancel')
    command = 'idleShutdown.' + action
  }
  else if (['pack','settings','resource'].includes(group) && action) { command = (group === 'resource' ? 'pack.resources' : group) + '.' + action; packId = words.shift() }
  else throw new Error('A command is required. Use --help')
  if (words.length) throw new Error('Unexpected positional arguments')
  if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(command)) throw new Error('Invalid command')
  if ((/^pack\.(start|stop|restart|upgrade|config\.(get|set))$/.test(command) || group === 'resource') && !packId) throw new Error('An explicit pack ID is required')
  if ((command === 'pack.list' || group === 'settings') && packId) throw new Error('This command does not accept a pack ID')
  const args = flags.args ? objectJSON(flags.args) : {}
  if (storageDir !== undefined) {
    if (!path.isAbsolute(storageDir)) throw new Error('storage set 的目录必须是绝对路径，当前收到：' + storageDir)
    args.dir = storageDir
  }
  if (apiRoute !== undefined) args.route = apiRoute
  if (apiEnabled !== undefined) args.enabled = apiEnabled
  if (launchAtLogin !== undefined) args.enabled = launchAtLogin
  const configKeys = { port: 'port', 'port-mode': 'portMode', 'run-as-admin': 'runAsAdmin', 'auto-start': 'autoStart', 'pinned-at': 'pinnedAt', workspace: 'workspace', 'launch-args': 'launchArgs' }
  for (const [flag, key] of Object.entries(configKeys)) {
    if (flags[flag] === undefined) continue
    if (command !== 'pack.config.set') throw new Error('--' + flag + ' is only valid with pack config set')
    let value = flags[flag]
    if (flag === 'port') { value = Number(value); if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Port must be 1–65535') }
    if (flag === 'port-mode' && !['auto','fixed'].includes(value)) throw new Error('Port mode must be auto or fixed')
    if (['run-as-admin','auto-start'].includes(flag)) { if (!['true','false'].includes(value)) throw new Error('--' + flag + ' expects true or false'); value = value === 'true' }
    if (flag === 'pinned-at' && value === 'null') value = null
    if (flag === 'launch-args') { value = JSON.parse(value); if (!Array.isArray(value) || value.some(x => typeof x !== 'string')) throw new Error('--launch-args expects a JSON string array') }
    args[key] = value
  }
  const apiKeys = { name: 'displayName', 'base-url': 'baseUrl', protocol: 'protocol', 'api-key': 'apiKey' }
  for (const [flag, key] of Object.entries(apiKeys)) {
    if (flags[flag] === undefined) continue
    if (command !== 'api.save') throw new Error('--' + flag + ' is only valid with api add')
    args[key] = flags[flag]
  }
  if (flags.models !== undefined) {
    if (command !== 'api.save') throw new Error('--models is only valid with api add')
    args.modelIds = String(flags.models).split(',').map(value => value.trim()).filter(Boolean)
    if (args.modelIds.length === 0) throw new Error('--models expects a comma separated model list')
  }
  if (pendingPackId !== undefined) args.packId = pendingPackId
  if (pendingId !== undefined) args.id = pendingId
  if (pathKind !== undefined) { args.kind = pathKind; args.target = path.resolve(pathTarget) }
  if (flags.out !== undefined && command !== 'uninstall.script') throw new Error('--out 只用于 uninstall script')
  if (uninstallOut !== undefined) args.out = uninstallOut
  if (flags['delete-data'] !== undefined) {
    if (!['uninstall.script', 'uninstall.run'].includes(command)) throw new Error('--delete-data 只用于 uninstall script 或 uninstall now')
    args.deleteData = true
  }
  if (flags.yes !== undefined) {
    if (command !== 'uninstall.run') throw new Error('--yes 只用于 uninstall now')
    args.confirm = true
  }
  if (flags.pack !== undefined && command !== 'pending.list') throw new Error('--pack 只用于 pending list')
  if (flags.resume !== undefined) {
    if (command !== 'pack.restart') throw new Error('--resume 只用于 pack restart <pack-id>')
    if (!packId) throw new Error('pack restart --resume 需要一个整合包 ID')
    if (!String(flags.resume).trim()) throw new Error('--resume 需要一段续接内容')
    args.resume = { prompt: flags.resume, ...(flags.session ? { sessionId: flags.session } : {}) }
  }
  if (flags['dsh-version'] !== undefined) {
    if (command !== 'pack.upgrade') throw new Error('--dsh-version 只用于 pack upgrade <pack-id>')
    const version = String(flags['dsh-version']).trim()
    if (!version) throw new Error('--dsh-version 需要一个 DSH 版本号，例如 0.2.1')
    args.dshVersion = version
  }
  if (command === 'pack.upgrade' && args.dshVersion === undefined) throw new Error('pack upgrade 需要 --dsh-version <version>')
  if (flags.session !== undefined && flags.resume === undefined) throw new Error('--session 必须与 --resume 一起使用')
  if (flags['no-elevated'] !== undefined) {
    if (command !== 'pack.stop') throw new Error('--no-elevated 只用于 pack stop <pack-id>')
    args.noElevated = true
  }
  return { flags, request: { command, ...(packId ? { packId } : {}), ...(Object.keys(args).length ? { args } : {}) } }
}
function defaultUserData() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dsh-launcher')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'dsh-launcher')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dsh-launcher')
}
async function invoke(userData, request) {
  let endpoint
  try { endpoint = JSON.parse(await fs.readFile(path.join(userData, 'launcher-control.json'), 'utf8')) }
  catch { throw Object.assign(new Error('Launcher control is unavailable; open the launcher or use --launcher <executable>'), { unavailable: true }) }
  let url
  try { url = new URL(endpoint.url) } catch { throw new Error('Invalid launcher endpoint metadata') }
  if (endpoint.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/control' || url.username || url.password || url.search || url.hash || typeof endpoint.token !== 'string' || !/^[a-f0-9]{64}$/.test(endpoint.token)) throw new Error('Invalid launcher endpoint metadata')
  const body = JSON.stringify(request)
  if (Buffer.byteLength(body) > 65536) throw new Error('Control payload exceeds 64 KiB')
  let response
  try { response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(120000) }) }
  catch (error) {
    const unavailable = error.cause?.code === 'ECONNREFUSED'
    throw Object.assign(new Error(unavailable ? 'Cannot reach launcher control; open the launcher and retry' : 'Launcher request interrupted; its outcome is unknown. Inspect pack status before retrying'), { unavailable })
  }
  let envelope
  try { envelope = await response.json() } catch { throw new Error('Launcher returned an invalid JSON response') }
  if (!response.ok || envelope.ok !== true) throw Object.assign(new Error(envelope.error?.message || 'Launcher command failed (HTTP ' + response.status + ')'), { code: envelope.error?.code || 'HTTP_' + response.status })
  return envelope.result
}
async function main() {
  const parsed = parse(process.argv.slice(2))
  if (parsed.help) { process.stdout.write(HELP); return }
  const { flags, request } = parsed
  const userData = path.resolve(flags['user-data'] || process.env.DSH_LAUNCHER_USER_DATA || defaultUserData())
  let result
  try { result = await invoke(userData, request) }
  catch (error) {
    if (!error.unavailable || !flags.launcher) throw error
    const executable = path.resolve(flags.launcher)
    await fs.access(executable)
    await new Promise((resolve, reject) => { const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: true }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve() }) })
    const deadline = Date.now() + 15000
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 200))
      try { result = await invoke(userData, request); break } catch (next) { if (!next.unavailable || Date.now() >= deadline) throw next }
    }
  }
  if (request.command === 'pending.list' && request.args && request.args.packId) {
    const wanted = request.args.packId
    if (Array.isArray(result)) result = result.filter(entry => entry && entry.packId === wanted)
  }
  process.stdout.write(JSON.stringify(result ?? null, null, flags.json ? 0 : 2) + '\n')
}
main().catch(error => {
  const json = process.argv.includes('--json')
  process.stderr.write((json ? JSON.stringify({ ok: false, error: { code: error.code || 'CLI_ERROR', message: error.message } }) : error.message) + '\n')
  process.exitCode = 1
})
