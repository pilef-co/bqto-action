import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const READY_TIMEOUT = 5 * 60_000

const input = name => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim()

// Same format as @actions/core: a random delimiter, so a value cannot inject another line.
const write = (file, name, value) => {
  const eof = `ghadelimiter_${randomUUID()}`
  appendFileSync(process.env[file], `${name}<<${eof}\n${value}\n${eof}\n`)
}

const escape = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

const fail = message => {
  console.log(`::error::${escape(message)}`)
  process.exit(1)
}

const tail = file => readFileSync(file, 'utf8').split('\n').slice(-30).join('\n')

// Splits like a shell, with single and double quotes and backslashes, and without expansion.
const split = s => {
  const words = []
  let word = null
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
    } else if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) word += s[++i]
      else word += c
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word)
      word = null
    } else {
      word ??= ''
      if (c === "'" || c === '"') quote = c
      else if (c === '\\' && i + 1 < s.length) word += s[++i]
      else word += c
    }
  }
  if (quote) fail(`args has an unclosed ${quote} quote`)
  if (word !== null) words.push(word)
  return words
}

const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
if (process.platform !== 'linux' || !arch) {
  fail(`bqto-action runs on Linux runners, amd64 or arm64, not ${process.platform} ${process.arch}`)
}

const edition = input('edition') || 'free'
if (edition !== 'free' && edition !== 'pro') fail(`edition is ${edition}, not free or pro`)
const licenseKey = input('license-key')
const pro = edition === 'pro'
const bqto = join(import.meta.dirname, 'bin', `${pro ? 'bqto-pro' : 'bqto'}_linux_${arch}`)
if (pro && !existsSync(bqto)) fail('this version of bqto-action carries no bqto Pro\nFix: use a newer version of pilef-co/bqto-action')

const env = { ...process.env }
const config = input('config')
if (config) {
  const home = mkdtempSync(join(process.env.RUNNER_TEMP, 'bqto-config-'))
  mkdirSync(join(home, 'bqto'))
  try {
    copyFileSync(config, join(home, 'bqto', 'config.toml'))
  } catch (e) {
    fail(`cannot read config ${config}: ${e.message}`)
  }
  env.XDG_CONFIG_HOME = home
}
// The runner also passes the key as INPUT_LICENSE-KEY; only bqto gets it, as BQTO_LICENSE_KEY.
delete env['INPUT_LICENSE-KEY']
if (licenseKey) {
  console.log(`::add-mask::${escape(licenseKey)}`)
  if (edition !== 'pro') console.log('::warning::license-key needs edition: pro. The free bqto ignores the key.')
  env.BQTO_LICENSE_KEY = licenseKey
}
// The command in run gets the job's XDG_CONFIG_HOME back, and never the license key.
// env reads options only before the first NAME=VALUE, so every -u comes first.
const unset = []
const set = []
if (config) {
  if (process.env.XDG_CONFIG_HOME) set.push(`XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME}`)
  else unset.push('XDG_CONFIG_HOME')
}
if (licenseKey) unset.push('BQTO_LICENSE_KEY')
const runEnv = unset.length || set.length ? ['env', ...unset.flatMap(name => ['-u', name]), ...set] : []

const args = ['connect']
for (const name of ['service', 'project', 'instance', 'profile', 'stack', 'network', 'region', 'zone', 'duration', 'port']) {
  if (input(name)) args.push(`--${name}`, input(name))
}
// A re-run with debug logging debugs bqto too.
if (process.env.RUNNER_DEBUG === '1') args.push('--debug')
const extra = split(input('args'))
if (extra.includes('--')) fail('args cannot hold --; put the command in run')
args.push(...extra, '--no-input')

const run = input('run')
const webOff = ['0', 'f', 'F', 'false', 'FALSE', 'False']
if (run && extra.some(a => /^--?web(=|$)/.test(a) && !webOff.includes(a.split('=')[1]))) {
  fail('--web with run would print the web proxy secret in the job log\nFix: drop --web; the command reaches Cloud Run through ALL_PROXY and HTTPS_PROXY')
}
// bqto Pro without a working key runs as the free bqto, which refuses --web.
if (run && pro && spawnSync(bqto, ['license', 'status'], { env, encoding: 'utf8' }).status === 0) args.push('--web=false')
if (run) {
  // The command's exit code is bqto's, and the runner's cancel signal goes to node only.
  const child = spawn(bqto, [...args, '--', ...runEnv, 'bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', run], {
    stdio: 'inherit',
    env,
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('error', err => fail(`cannot start bqto: ${err.message}`))
  child.on('close', (code, signal) => process.exit(code ?? 128 + constants.signals[signal]))
} else {
  // Output goes to files: a child that holds the step's stdout open delays the end of the step.
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP, 'bqto-'))
  const out = join(dir, 'stdout.log')
  const err = join(dir, 'stderr.log')
  const child = spawn(bqto, [...args, '--output', 'json'], {
    detached: true,
    stdio: ['ignore', openSync(out, 'w'), openSync(err, 'w')],
    env,
  })
  child.unref()
  let exited = false
  child.on('exit', () => (exited = true))
  child.on('error', e => fail(`cannot start bqto: ${e.message}`))
  // Saved first, so the post step ends the session even if this step fails or is cancelled.
  write('GITHUB_STATE', 'pid', child.pid)
  write('GITHUB_STATE', 'log', err)

  let sessions
  for (const deadline = Date.now() + READY_TIMEOUT; ; await sleep(1000)) {
    sessions = readFileSync(out, 'utf8')
      .split('\n')
      .slice(0, -1)
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line))
      .filter(e => e.event === 'ready')
    if (sessions.length) break
    if (exited) {
      console.log(tail(err))
      fail('bqto ended before the session was ready')
    }
    if (Date.now() > deadline) {
      console.log(tail(err))
      fail(`the session was not ready after ${READY_TIMEOUT / 60_000} minutes`)
    }
  }

  for (const s of sessions) if (s.web_token) console.log(`::add-mask::${escape(s.web_token)}`)
  const [ready] = sessions
  for (const name of ['host', 'port', 'remote', 'bastion', 'expires', 'proxy']) write('GITHUB_OUTPUT', name, ready[name] ?? '')
  write('GITHUB_OUTPUT', 'sessions', JSON.stringify(sessions))
  write('GITHUB_ENV', 'BQTO_HOST', ready.host)
  write('GITHUB_ENV', 'BQTO_PORT', ready.port)
  if (ready.proxy === 'socks5') write('GITHUB_ENV', 'BQTO_PROXY', `socks5h://${ready.host}:${ready.port}`)
  if (ready.service === 'cloudsql' || ready.service === 'alloydb') {
    write('GITHUB_ENV', 'PGHOST', ready.host)
    write('GITHUB_ENV', 'PGPORT', ready.port)
  }
  console.log(`session ready on ${ready.host}:${ready.port}, bastion ${ready.bastion}, expires ${ready.expires}`)
}
