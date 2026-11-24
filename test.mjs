// Runs main.mjs and post.mjs against a fake bqto. Linux only: node test.mjs
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE = `#!/bin/sh
printf '%s\\n' "$@" >"$RUNNER_TEMP/args"
printf '%s' "\${BQTO_LICENSE_KEY-unset}" >"$RUNNER_TEMP/license-key"
tr '\\000' '\\n' </proc/$$/environ >"$RUNNER_TEMP/bqto-environ"
echo "$0" >"$RUNNER_TEMP/bqto-path"
if [ -n "$XDG_CONFIG_HOME" ] && [ -f "$XDG_CONFIG_HOME/bqto/config.toml" ]; then
	cp "$XDG_CONFIG_HOME/bqto/config.toml" "$RUNNER_TEMP/config-seen"
fi
case " $* " in
" license status ")
	[ "\$BQTO_LICENSE_KEY" = BQTO-good ]
	exit
	;;
*" --instance gone "*)
	echo 'instance not found' >&2
	exit 1
	;;
*" --instance stubborn "*" --output json "*)
	trap '' INT
	trap 'sleep 1; echo terminated after cleanup >&2; exit 0' TERM
	echo '{"event":"ready","service":"cloudsql","instance":"db","host":"127.0.0.1","port":15432}'
	while :; do sleep 1; done
	;;
*" --service cloudrun "*" --output json "*)
	trap 'exit 0' INT
	echo '{"event":"ready","service":"cloudrun","instance":"europe-west1/app","host":"127.0.0.1","port":1080,"proxy":"socks5","remote":"app.run.app:443","web":"http://127.0.0.1:8080","web_token":"s3cret-token","bastion":"bqto-y","expires":"2026-10-24T00:00:00Z"}'
	while :; do sleep 1; done
	;;
*" --output json "*)
	trap 'echo deleted the bastion >&2; exit 0' INT
	echo '{"event":"ready","service":"cloudsql","instance":"db","host":"127.0.0.1","port":15432,"remote":"10.0.0.3:5432","bastion":"bqto-x","expires":"2026-10-24T00:00:00Z"}'
	while :; do sleep 1; done
	;;
esac
while [ "$1" != -- ]; do shift; done
shift
PGPORT=15432 exec "$@"
`

const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
const dir = mkdtempSync(join(tmpdir(), 'bqto-action-'))
for (const file of ['main.mjs', 'post.mjs']) copyFileSync(file, join(dir, file))
mkdirSync(join(dir, 'bin'))
writeFileSync(join(dir, 'bin', `bqto_linux_${arch}`), FAKE, { mode: 0o755 })

const files = Object.fromEntries(['GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_STATE'].map(name => [name, join(dir, name)]))
const baseEnv = () => {
  const env = { ...process.env, RUNNER_TEMP: dir, RUNNER_DEBUG: '', ...files }
  delete env.XDG_CONFIG_HOME
  delete env.BQTO_LICENSE_KEY
  for (const name of Object.keys(env)) if (name.startsWith('INPUT_')) delete env[name]
  return env
}
const action = (script, env) => {
  for (const file of Object.values(files)) writeFileSync(file, '')
  for (const file of ['args', 'bqto-path', 'config-seen', 'license-key']) rmSync(join(dir, file), { force: true })
  return spawnSync('node', [join(dir, script)], { env: { ...baseEnv(), ...env }, encoding: 'utf8' })
}
const carried = join(dir, 'bin', `bqto-pro_linux_${arch}`)
const pro = env => {
  writeFileSync(carried, FAKE, { mode: 0o755 })
  return { INPUT_EDITION: 'pro', ...env }
}
const read = name =>
  Object.fromEntries([...readFileSync(files[name], 'utf8').matchAll(/^(\w+)<<(\S+)\n(.*)\n\2$/gm)].map(m => [m[1], m[3]]))
const args = () => readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')

// run: the command sees the session, and its exit code is the step's.
let r = action('main.mjs', {
  INPUT_INSTANCE: 'db',
  INPUT_DURATION: '15m',
  INPUT_RUN: 'test "$PGPORT" = 15432 && exit 3',
  RUNNER_DEBUG: '1',
})
assert.equal(r.status, 3, r.stdout + r.stderr)
assert.match(args().join(' '), /^connect --instance db --duration 15m --debug --no-input -- bash --noprofile --norc -eo pipefail -c test/)
assert.equal(readFileSync(join(dir, 'bqto-path'), 'utf8').trim(), join(dir, 'bin', `bqto_linux_${arch}`))

// args splits as a shell does, with quotes, and refuses --.
r = action('main.mjs', { INPUT_INSTANCE: 'db', INPUT_RUN: 'true', INPUT_ARGS: ` --labels "team=a b" 'x "y"' z\\ w "a\\"b" '' ` })
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.deepEqual(args().slice(0, 9), ['connect', '--instance', 'db', '--labels', 'team=a b', 'x "y"', 'z w', 'a"b', ''])
r = action('main.mjs', { INPUT_INSTANCE: 'db', INPUT_RUN: 'true', INPUT_ARGS: '--labels "a b' })
assert.equal(r.status, 1)
assert.match(r.stdout, /::error::args has an unclosed " quote/)
r = action('main.mjs', { INPUT_INSTANCE: 'db', INPUT_RUN: 'true', INPUT_ARGS: '-- rm -rf /' })
assert.equal(r.status, 1)
assert.match(r.stdout, /::error::args cannot hold --/)
assert.equal(existsSync(join(dir, 'args')), false)

// Without run: the step returns once the session is ready, with outputs and env for later steps.
r = action('main.mjs', { INPUT_INSTANCE: 'db', INPUT_ZONE: 'us-east1-b', INPUT_PORT: '15432', INPUT_ARGS: ' --debug  --network n ' })
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.equal(args().join(' '), 'connect --instance db --zone us-east1-b --port 15432 --debug --network n --no-input --output json')
const { sessions, ...out } = read('GITHUB_OUTPUT')
assert.deepEqual(out, { host: '127.0.0.1', port: '15432', remote: '10.0.0.3:5432', bastion: 'bqto-x', expires: '2026-10-24T00:00:00Z', proxy: '' })
const { proxy, ...ready } = out
assert.deepEqual(JSON.parse(sessions), [{ event: 'ready', service: 'cloudsql', instance: 'db', ...ready, port: 15432 }])
assert.deepEqual(read('GITHUB_ENV'), { BQTO_HOST: '127.0.0.1', BQTO_PORT: '15432', PGHOST: '127.0.0.1', PGPORT: '15432' })
let state = read('GITHUB_STATE')

// The post step ends the session and waits for bqto to clean up.
r = action('post.mjs', { STATE_pid: state.pid, STATE_log: state.log })
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.match(r.stdout, /deleted the bastion/)
assert.doesNotMatch(r.stdout, /::warning::/)

// A bqto that ignores SIGINT gets SIGTERM, and the post step waits for it before printing the log.
r = action('main.mjs', { INPUT_INSTANCE: 'stubborn' })
assert.equal(r.status, 0, r.stdout + r.stderr)
state = read('GITHUB_STATE')
const stubborn = new Promise(resolve => {
  const child = spawn('node', [join(dir, 'post.mjs')], { env: { ...baseEnv(), STATE_pid: state.pid, STATE_log: state.log } })
  let stdout = ''
  child.stdout.on('data', d => (stdout += d))
  child.on('close', status => resolve({ status, stdout }))
})

// bqto ending before ready fails the step and shows why.
r = action('main.mjs', { INPUT_INSTANCE: 'gone' })
assert.equal(r.status, 1)
assert.match(r.stdout, /instance not found[\s\S]*::error::bqto ended before the session was ready/)

// Pro: the carried build runs a Cloud Run session with a profile file.
writeFileSync(join(dir, 'profiles.toml'), '[profiles.app]\nservice = "cloudrun"\n')
r = action('main.mjs', pro({ INPUT_SERVICE: 'cloudrun', INPUT_INSTANCE: 'europe-west1/app', INPUT_CONFIG: join(dir, 'profiles.toml'), INPUT_ARGS: '--web' }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.equal(readFileSync(join(dir, 'bqto-path'), 'utf8').trim(), carried)
assert.match(r.stdout, /^::add-mask::s3cret-token$/m)
assert.equal(readFileSync(join(dir, 'config-seen'), 'utf8'), '[profiles.app]\nservice = "cloudrun"\n')
assert.equal(read('GITHUB_OUTPUT').proxy, 'socks5')
assert.deepEqual(read('GITHUB_ENV'), { BQTO_HOST: '127.0.0.1', BQTO_PORT: '1080', BQTO_PROXY: 'socks5h://127.0.0.1:1080' })
state = read('GITHUB_STATE')
r = action('post.mjs', { STATE_pid: state.pid, STATE_log: state.log })
assert.equal(r.status, 0, r.stdout + r.stderr)

// Pro: with run, --web is refused, and config reaches bqto but not the command.
r = action('main.mjs', pro({ INPUT_SERVICE: 'cloudrun', INPUT_INSTANCE: 'europe-west1/app', INPUT_RUN: 'true', INPUT_ARGS: '--web' }))
assert.equal(r.status, 1)
assert.match(r.stdout, /::error::--web with run would print the web proxy secret/)
assert.equal(existsSync(join(dir, 'args')), false)
r = action('main.mjs', pro({ INPUT_SERVICE: 'cloudrun', INPUT_INSTANCE: 'europe-west1/app', INPUT_RUN: 'true', INPUT_ARGS: '-web=1' }))
assert.equal(r.status, 1)
assert.match(r.stdout, /::error::--web with run/)
r = action('main.mjs', pro({ INPUT_PROFILE: 'app', INPUT_CONFIG: join(dir, 'profiles.toml'), INPUT_RUN: 'test -z "$XDG_CONFIG_HOME" && echo clean' }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.match(r.stdout, /^clean$/m)
assert.equal(readFileSync(join(dir, 'config-seen'), 'utf8'), '[profiles.app]\nservice = "cloudrun"\n')
assert.match(args().join(' '), /^connect --profile app --no-input -- env -u XDG_CONFIG_HOME bash /)
r = action('main.mjs', pro({ INPUT_PROFILE: 'app', INPUT_CONFIG: join(dir, 'profiles.toml'), INPUT_RUN: 'echo "xdg=$XDG_CONFIG_HOME"', XDG_CONFIG_HOME: '/x' }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.match(r.stdout, /^xdg=\/x$/m)

// Pro: a key that bqto Pro accepts adds --web=false with run, and the key reaches license status.
r = action('main.mjs', pro({ INPUT_INSTANCE: 'db', 'INPUT_LICENSE-KEY': 'BQTO-good', INPUT_RUN: 'true' }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.equal(readFileSync(join(dir, 'bqto-path'), 'utf8').trim(), carried)
assert.equal(args().join(' '), 'connect --instance db --no-input --web=false -- env -u BQTO_LICENSE_KEY bash --noprofile --norc -eo pipefail -c true')

// Pro: with a key it refuses, or with no key, bqto Pro works as the free bqto, so it gets no --web=false.
r = action('main.mjs', pro({ INPUT_INSTANCE: 'db', 'INPUT_LICENSE-KEY': 'BQTO-bad', INPUT_RUN: 'true' }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.ok(!args().includes('--web=false'), args().join(' '))
r = action('main.mjs', pro({ INPUT_INSTANCE: 'db', INPUT_RUN: 'true' }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.equal(readFileSync(join(dir, 'bqto-path'), 'utf8').trim(), carried)
assert.equal(args().join(' '), 'connect --instance db --no-input -- bash --noprofile --norc -eo pipefail -c true')

// Pro: an action that carries no bqto Pro fails with a Fix line, before bqto runs.
rmSync(carried)
r = action('main.mjs', { INPUT_EDITION: 'pro', INPUT_INSTANCE: 'db', 'INPUT_LICENSE-KEY': 'BQTO-good', INPUT_RUN: 'true' })
assert.equal(r.status, 1)
assert.match(r.stdout, /^::error::this version of bqto-action carries no bqto Pro%0AFix: use a newer version of pilef-co\/bqto-action$/m)
assert.equal(existsSync(join(dir, 'args')), false)

// license-key: bqto gets the key, the log masks it, and the command in run does not see it.
r = action('main.mjs', pro({ INPUT_INSTANCE: 'db', 'INPUT_LICENSE-KEY': 'BQTO-1111-2222', INPUT_RUN: 'test -z "\${BQTO_LICENSE_KEY+set}" && echo no-key' }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.equal(readFileSync(join(dir, 'license-key'), 'utf8'), 'BQTO-1111-2222')
assert.match(r.stdout, /::add-mask::BQTO-1111-2222/)
assert.doesNotMatch(r.stdout, /::warning::license-key/)
assert.match(r.stdout, /no-key/)
assert.doesNotMatch(readFileSync(join(dir, 'bqto-environ'), 'utf8'), /^INPUT_LICENSE-KEY=/m)

// license-key with config and the job's XDG_CONFIG_HOME: run gets XDG_CONFIG_HOME back and no key.
r = action('main.mjs', pro({ INPUT_PROFILE: 'app', INPUT_CONFIG: join(dir, 'profiles.toml'), 'INPUT_LICENSE-KEY': 'BQTO-1111-2222', XDG_CONFIG_HOME: '/x', INPUT_RUN: 'test -z "\${BQTO_LICENSE_KEY+set}" && echo "xdg=$XDG_CONFIG_HOME"' }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.match(r.stdout, /xdg=\/x/)

// license-key without run: bqto gets the key, and later steps do not.
r = action('main.mjs', pro({ INPUT_INSTANCE: 'db', 'INPUT_LICENSE-KEY': 'BQTO-1111-2222' }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.equal(readFileSync(join(dir, 'license-key'), 'utf8'), 'BQTO-1111-2222')
for (const name of ['GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_STATE']) assert.doesNotMatch(readFileSync(files[name], 'utf8'), /BQTO-1111-2222/)
const keyState = read('GITHUB_STATE')
assert.equal(action('post.mjs', { STATE_pid: keyState.pid, STATE_log: keyState.log }).status, 0)

// license-key with the free edition: a warning says it needs edition: pro.
r = action('main.mjs', { INPUT_INSTANCE: 'db', 'INPUT_LICENSE-KEY': 'BQTO-1111-2222', INPUT_RUN: 'true' })
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.match(r.stdout, /::warning::license-key needs edition: pro/)

// Without license-key, bqto gets no key from the action.
r = action('main.mjs', { INPUT_INSTANCE: 'db', INPUT_RUN: 'true' })
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.equal(readFileSync(join(dir, 'license-key'), 'utf8'), 'unset')

r = await stubborn
assert.equal(r.status, 0, r.stdout)
assert.match(r.stdout, /sending SIGTERM[\s\S]*terminated after cleanup/)

console.log('ok')
