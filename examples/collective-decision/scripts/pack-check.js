'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const [pack] = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))
for (const file of pack.files) {
  assert(!/(?:^|\/)(?:node_modules|\.runtime|output|deploy|data|verification)(?:\/|$)|\.local\.|\.env/.test(file.path), `Private path in package: ${file.path}`)
  if (/\.(?:js|json|md|html|css|yml|yaml)$/.test(file.path)) {
    const value = fs.readFileSync(path.join(root, file.path), 'utf8')
    assert(!/\/Users\/[A-Za-z0-9._-]+\//.test(value), `Local path in package: ${file.path}`)
    assert(!/\bsk-[A-Za-z0-9_-]{20,}\b/.test(value), `Possible key in package: ${file.path}`)
  }
}
for (const required of ['src/enterprise-decision.js', 'examples/enterprise-collective.js', 'config/enterprise-decision.json', 'web/index.html', 'LICENSE']) assert(pack.files.some(file => file.path === required), `Missing: ${required}`)
console.log(JSON.stringify({ files: pack.files.length, bytes: pack.size, private_paths: 0, status: 'PASS' }))
