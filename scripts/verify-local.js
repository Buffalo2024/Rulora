'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rulora-release-verification-'))
const tasks = [
  ['.', ['test', 'test:types', 'example:schema', 'examples:quickstart', 'example', 'lab:native-image', 'lab:stable-image', 'docs:check', 'release:check', 'pack:check']],
  ['examples/collective-decision', ['test', 'example', 'example:static', 'example:controlled', 'example:langgraph', 'eval:reliability', 'web:smoke', 'privacy:check', 'pack:check']]
]
const results = []
for (const [directory, scripts] of tasks) for (const script of scripts) {
  const started = Date.now()
  const outcome = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: path.join(root, directory), encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, RULORA_CORE_PATH: root }
  })
  const log = `${results.length + 1}.log`
  fs.writeFileSync(path.join(logRoot, log), `${outcome.stdout || ''}\n${outcome.stderr || ''}\n${outcome.error?.message || ''}`)
  const row = { directory, script, passed: outcome.status === 0, duration_ms: Date.now() - started, log }
  results.push(row)
  console.log(`${row.passed ? 'PASS' : 'FAIL'} ${directory} ${script}`)
}
fs.writeFileSync(path.join(logRoot, 'summary.json'), JSON.stringify({ node: process.version, results }, null, 2))
console.log(`Verification logs: ${logRoot}`)
if (results.some(result => !result.passed)) process.exitCode = 1
