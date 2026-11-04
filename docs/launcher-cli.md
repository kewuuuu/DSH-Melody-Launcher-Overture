# Launcher control CLI

Run Node 20+ with bin/launcher-control.cjs (use your actual absolute path):

~~~sh
node bin/launcher-control.cjs pack list --json
node bin/launcher-control.cjs pack start pack-a
node bin/launcher-control.cjs pack stop pack-a
node bin/launcher-control.cjs pack restart pack-a
node bin/launcher-control.cjs pack config get pack-a --json
node bin/launcher-control.cjs pack config set pack-a --port 3081 --port-mode fixed --auto-start true --run-as-admin false
node bin/launcher-control.cjs pack config set pack-a --workspace 'D:/work' --launch-args '["web"]' --pinned-at null
node bin/launcher-control.cjs settings get --json
node bin/launcher-control.cjs settings set --args '{"openAfterLaunch":false}'
~~~

Always obtain pack IDs from pack list. Runtime/config operations never fall back to the active pack. Config flags become a flat args patch; --args accepts any additional JSON object fields. Boolean flags require true or false. A pinned timestamp is a string; use null to unpin. Changes to launch configuration take effect on next start/restart. Stopping/restarting the pack serving your conversation disconnects its DSH Web.

All successful commands print the JSON result (compact with --json, indented otherwise). Failures return exit code 1 and stderr; --json formats stderr as {ok:false,error:{code,message}}. Stdout is empty on errors. Backend errors, including unknown packs and unsupported commands, are propagated. Normal results match LauncherApi.launcherControl: pack.list returns {packs:[...]}, config commands return config and runtime commands return RuntimeState.

## Additional commands

The generic form preserves the backend command and JSON args without guessing semantics:

~~~sh
node bin/launcher-control.cjs request pack.openWeb pack-a
node bin/launcher-control.cjs request pack.resources.list pack-a --args '{"kind":"skills"}' --json
node bin/launcher-control.cjs request pack.resources.enabled pack-a --args '{"kind":"skills","name":"example","enabled":false}'
node bin/launcher-control.cjs request pack.resources.remove pack-a --args '{"kind":"skills","name":"example"}'
node bin/launcher-control.cjs request pack.resources.link pack-a --args '{"kind":"skills","name":"example","sourcePackId":"pack-b"}'
node bin/launcher-control.cjs request pack.market.install pack-a --args '{"name":"example-plugin"}'
node bin/launcher-control.cjs pack create --args '{"name":"My pack","dshVersion":"<installed-version>"}'
node bin/launcher-control.cjs pack rename pack-a --args '{"name":"Renamed pack"}'
node bin/launcher-control.cjs pack delete pack-a
~~~

Resource kinds are plugins, skills, presets. resource <operation> <id> maps to pack.resources.<operation> with that explicit pack ID; for example resource list pack-a --args '{"kind":"skills"}' calls pack.resources.list. Supported lifecycle commands are pack create with args {name,dshVersion}, pack rename with an explicit pack ID and args {name}, and pack delete with an explicit pack ID. The pack <operation> [id] and request forms forward commands to the backend; forwarding does not add operations. Unsupported commands, including pack.export, return an error. All operations on an existing pack should include its ID; the server enforces it for runtime and config commands, and the backend validates additional commands.

## Connection and launcher startup

--user-data <directory> overrides DSH_LAUNCHER_USER_DATA. Otherwise the CLI resolves Electron's dsh-launcher userData: %APPDATA%/dsh-launcher on Windows, ~/Library/Application Support/dsh-launcher on macOS, $XDG_CONFIG_HOME/dsh-launcher or ~/.config/dsh-launcher on Linux. Product support remains Windows. Specify the directory for a launcher using custom userData.

The launcher must already be running. On unavailable control only, --launcher <explicit-executable-path> starts that executable detached and waits up to 15 seconds for control. It does not guess binaries or start a DSH runtime. It does not add guessed Electron arguments, so development Electron startup should be done separately. Launcher-start retries are only made before a command is accepted; backend errors are not retried.

The launcher binds an ephemeral IPv4 loopback port and atomically publishes userData/launcher-control.json containing version, URL, token and PID. POST /control requires its Bearer token. Requests are limited to 64 KiB and reject browser Origin headers. Metadata uses owner-only permissions where the OS supports POSIX modes, inherits the userData ACL on Windows, and is removed by the owning server on close. Do not distribute this file or log its token. Local processes running as the same user can access launcher control. HTTP errors use {ok:false,error:{code,message}}; success uses {ok:true,result}. The CLI validates loopback metadata, refuses redirects, and times out after 120 seconds. A timeout is not proof an operation was cancelled; inspect status before retrying.

## Electron integration

Import createLauncherControlServer from electron/launcher-control-server.ts. After app readiness call:

~~~ts
const control = await createLauncherControlServer({
  userData: app.getPath('userData'),
  execute: request => launcherControl(request),
})
// Await control.close() during launcher shutdown.
~~~

The exported request is {command:string;packId?:string;args?:Record<string,unknown>}. Keep the same execute implementation behind launcher:control IPC and this server. The server does not import Electron and is fixture-testable.

Import ensureLauncherControlSkill from electron/launcher-control-skill.ts and invoke for each explicitly resolved isolated pack home (before start or when initializing/importing it):

~~~ts
await ensureLauncherControlSkill({
  packHome: absolutePackHome,
  packId: id,
  cliPath: path.join(app.getAppPath(), 'bin/launcher-control.cjs'),
  userData: app.getPath('userData'),
  nodePath: managedNodeExecutable,
})
~~~

packHome, cliPath and userData must be absolute. nodePath is the managed Node executable, never Electron's process.execPath; omit only when node is available on PATH. The helper reads the source through Electron's ASAR-aware filesystem and copies it to a versioned userData/tools/launcher-control-<hash>.cjs path, runnable by external Node. package.json includes the source CLI in packaged files and exposes dsh-launcher-control as a bin entry. Old content-addressed CLI copies are retained so existing pack skills remain runnable until refreshed.

The helper returns {path,status:'installed'|'updated'|'preserved'} for packHome/skills/launcher-control/SKILL.md. Only skills containing its management marker may be updated. Existing custom skills and symlinked skills paths are preserved. Generated commands are JSON argv arrays with exact absolute paths and explicit pack IDs; callers execute entries as process arguments instead of evaluating a shell string. The helper writes only the explicit supplied pack home and launcher userData. Tests use temporary fixture homes.
