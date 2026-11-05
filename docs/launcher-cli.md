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
node bin/launcher-control.cjs settings launch-at-login on
node bin/launcher-control.cjs api add acme --name 'Acme' --base-url 'https://api.acme.test/v1' --protocol openai-completions --models 'acme-1,acme-2' --api-key 'sk-acme'
node bin/launcher-control.cjs pack api enable pack-a acme
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

## Storage location

The packaged launcher keeps all of its data in a launcher-data directory next to its own executable: <EXE directory>/launcher-data (the portable build uses PORTABLE_EXECUTABLE_DIR, so a portable EXE carries its data in its own folder). packs.json, launcher settings, the plugin store and the managed DSH runtime all live there, and Chromium's cache is isolated in launcher-data/browser-data. Two launchers in different folders on the same machine therefore never share packs or a single-instance lock. A development build (not packaged) keeps the historical <appData>/dsh-launcher directory and cannot switch it.

Resolution order, first match wins:

1. --data-dir=<absolute-directory> or --data-dir <absolute-directory> on the launcher command line (a relative path is ignored with a warning). Electron's --user-data-dir is honored at the same level when --data-dir is absent, which is how a development launcher keeps the isolation vite hands it; --data-dir wins when both are present because it is the launcher's own switch.
2. <EXE directory>/launcher-storage.json containing {"dataDir":"<absolute-directory>"} (a corrupt file is ignored with a warning).
3. <EXE directory>/launcher-data.

Switching the data directory writes that pointer file, and requires a launcher restart to take effect. The launcher UI exposes the same switch through launcher:storage:choose|reset|relaunch, which use a native directory picker. launcher:storage:choose takes an optional defaultPath (for example %APPDATA%/dsh-launcher, to take over legacy data in one click); it only positions the picker, a relative or empty value is ignored, and it is never written to the pointer file. The CLI is a separate Node process with no access to Electron dialogs, so it only writes the pointer file:

~~~sh
node bin/launcher-control.cjs storage info --json
node bin/launcher-control.cjs storage set 'D:/launcher-data' --json
node bin/launcher-control.cjs storage reset --json
~~~

storage info returns {dataDir,source,portableDir,pointerFile,legacy:{dataDir,hasData},restartRequired,warning}, where source is argument, pointer, portable, install or development. storage set takes one existing or creatable absolute directory, verifies it is writable, writes the pointer file and reports restartRequired true. storage reset deletes the pointer file, so the next start returns to the default location; restartRequired stays true and dataDir keeps naming the directory this process is still using. legacy describes %APPDATA%/dsh-launcher on Windows (the appData equivalent elsewhere) and hasData is true when that directory already holds launcher data.

To take over data from an older installation or another launcher, stop that launcher and run storage set with its data directory, for example 'C:/Users/<user>/AppData/Roaming/dsh-launcher' (quote paths containing spaces), then start the launcher again. The pointer file lives next to the EXE, so it travels with a portable copy but not with a copied launcher-data folder; run storage reset to go back to the default.

## Launcher API library, per-pack grants and launch at login

The launcher keeps one API library for the whole machine-wide launcher profile, in userData/api-library.json (version 1). Entries hold route, name, base URL, protocol and model IDs; the API key never lands in that file. It is written to userData/.credentials.yaml as <ROUTE>_API_KEY, the same credential store the DSH runtime already uses. Routes match ^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$ and must be unique. api add on an existing route updates it in place and keeps the stored key when --api-key is omitted. The library is the single source of truth: saving an entry re-syncs displayName, base URL, protocol and model IDs into every pack that has the grant, and renaming a route moves each of those packs' provider to the new route (the pack-side key migrates with it, the old route and its key are removed). api remove is a cascade: it revokes the grant in every pack that had it — pack settings.yaml provider and pack-side key are removed first — then clears the grant records, the library entry and its key.

A grant is per pack and lives in userData/pack-api-grants.json (version 1). Enabling one writes that pack's own settings.yaml (llm-pi-ai.providers.<route>, exactly like the custom API editor) and that pack's .credentials.yaml; disabling removes both again. A running pack accepts the change and reports restartRequired true, and the new provider only takes effect on next start/restart; restartRequired is true only when that call really changed the grant, so a plain pack api list reports false and shows no "restart to apply" hint when nothing is pending. If the sync fails, the grant is rolled back, the reason is kept, and the next pack api list shows it in error. pack api disable only ever touches a route the pack was granted, so a provider the user configured by hand inside a pack is never deleted by a disable of some other route.

launchAtLogin is the launcher's own Windows login item. It is independent of pack autoStart: a pack with autoStart true is started by a launcher that is already running, and it no longer registers anything at login. Saving the setting applies the login item immediately (exe path is PORTABLE_EXECUTABLE_FILE when set, otherwise the launcher executable, with --background so it starts hidden in the tray), and startup re-applies it once, so a missing launchAtLogin means off and any stale registration is removed.

~~~sh
node bin/launcher-control.cjs settings launch-at-login
node bin/launcher-control.cjs settings launch-at-login on
node bin/launcher-control.cjs settings launch-at-login off

node bin/launcher-control.cjs api add acme --name 'Acme' --base-url 'https://api.acme.test/v1' --protocol openai-completions --models 'acme-1,acme-2' --api-key 'sk-acme'
node bin/launcher-control.cjs api list
node bin/launcher-control.cjs api remove acme

node bin/launcher-control.cjs pack api list pack-a
node bin/launcher-control.cjs pack api enable pack-a acme
node bin/launcher-control.cjs pack api disable pack-a acme
~~~

settings launch-at-login without an argument reports the current value and does not change it; on and off write the setting and apply it. These are real outputs from the fixture launcher (API keys and pack IDs are fixture values):

~~~text
$ node bin/launcher-control.cjs settings launch-at-login on
{
  "launchAtLogin": true
}
~~~

~~~text
$ node bin/launcher-control.cjs api add acme --name 'Acme' --base-url 'https://api.acme.test/v1' --protocol openai-completions --models 'acme-1,acme-2' --api-key 'sk-acme'
[
  {
    "route": "acme",
    "displayName": "Acme",
    "baseUrl": "https://api.acme.test/v1",
    "protocol": "openai-completions",
    "modelIds": [
      "acme-1",
      "acme-2"
    ],
    "hasApiKey": true
  }
]
~~~

~~~text
$ node bin/launcher-control.cjs pack api enable alpha acme
{
  "packId": "alpha",
  "enabled": [
    "acme"
  ],
  "available": [
    {
      "route": "acme",
      "displayName": "Acme",
      "baseUrl": "https://api.acme.test/v1",
      "protocol": "openai-completions",
      "modelIds": [
        "acme-1",
        "acme-2"
      ],
      "hasApiKey": true
    }
  ],
  "restartRequired": false,
  "error": null
}
~~~

Removing a library entry that a pack had been granted takes the provider out of that pack as well:

~~~text
$ node bin/launcher-control.cjs api remove acme
[]

$ node bin/launcher-control.cjs pack api list alpha
{
  "packId": "alpha",
  "enabled": [],
  "available": [],
  "restartRequired": false,
  "error": null
}
~~~

pack api list and pack api enable return the same shape: enabled is the pack's granted routes, available is the current library, restartRequired is true only for a call that actually changed the grant while the pack was running, and error is null or the last sync failure. Every one of these commands is also reachable through request: api.list, api.save and api.remove are plain commands, and pack.api.list/pack.api.set take {args:{route,enabled}} behind the pack ID.

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
