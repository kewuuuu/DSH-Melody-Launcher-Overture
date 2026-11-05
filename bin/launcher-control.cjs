#!/usr/bin/env node
'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const HELP = `DSH Launcher control (Node >=20)
  pack list
  pack start|stop|restart <pack-id>
  pack config get <pack-id>
  pack config set <pack-id> --port 3081 --port-mode fixed --auto-start true
  settings get
  settings set --args '{"openAfterLaunch":false}'
  storage info
  storage set <absolute-directory>
  storage reset
  resource <operation> <pack-id> --args '{...}'
  pack <operation> [pack-id] --args '{...}'
  request <dotted.command> [pack-id] --args '{...}'
Options: --json --user-data <directory> --launcher <explicit executable>
Config flags: --port, --port-mode, --run-as-admin, --auto-start, --pinned-at,
              --workspace, --launch-args '["web"]'
Set DSH_LAUNCHER_USER_DATA instead of --user-data if desired.
--launcher starts only the executable supplied, when control is unavailable.
`
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
    if (['json', 'help'].includes(key)) { flags[key] = true; continue }
    if (!['user-data','launcher','args','port','port-mode','run-as-admin','auto-start','pinned-at','workspace','launch-args'].includes(key)) throw new Error('Unknown option: ' + item)
    if (i + 1 >= argv.length || argv[i+1].startsWith('--')) throw new Error('Missing value for ' + item)
    flags[key] = argv[++i]
  }
  if (flags.help) return { help: true }
  const group = words.shift(), action = words.shift()
  let command, packId, storageDir
  if (group === 'request') { command = action; packId = words.shift() }
  else if (group === 'pack' && action === 'config') { command = 'pack.config.' + words.shift(); packId = words.shift(); if (!['pack.config.get','pack.config.set'].includes(command)) throw new Error('Use pack config get|set <pack-id>') }
  else if (group === 'storage') {
    command = 'storage.' + action
    if (!['storage.info','storage.set','storage.reset'].includes(command)) throw new Error('用法：storage info | storage set <绝对路径目录> | storage reset')
    if (command === 'storage.set') { storageDir = words.shift(); if (!storageDir) throw new Error('storage set 需要一个目录参数：storage set <绝对路径目录>') }
  }
  else if (['pack','settings','resource'].includes(group) && action) { command = (group === 'resource' ? 'pack.resources' : group) + '.' + action; packId = words.shift() }
  else throw new Error('A command is required. Use --help')
  if (words.length) throw new Error('Unexpected positional arguments')
  if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(command)) throw new Error('Invalid command')
  if ((/^pack\.(start|stop|restart|config\.(get|set))$/.test(command) || group === 'resource') && !packId) throw new Error('An explicit pack ID is required')
  if ((command === 'pack.list' || group === 'settings') && packId) throw new Error('This command does not accept a pack ID')
  const args = flags.args ? objectJSON(flags.args) : {}
  if (storageDir !== undefined) {
    if (!path.isAbsolute(storageDir)) throw new Error('storage set 的目录必须是绝对路径，当前收到：' + storageDir)
    args.dir = storageDir
  }
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
  process.stdout.write(JSON.stringify(result ?? null, null, flags.json ? 0 : 2) + '\n')
}
main().catch(error => {
  const json = process.argv.includes('--json')
  process.stderr.write((json ? JSON.stringify({ ok: false, error: { code: error.code || 'CLI_ERROR', message: error.message } }) : error.message) + '\n')
  process.exitCode = 1
})
