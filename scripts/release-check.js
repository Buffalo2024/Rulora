const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const ignored = new Set(['.git', 'node_modules', 'coverage', 'runtime'])
const textExtensions = new Set(['.js', '.json', '.md', '.yml', '.yaml', '.txt', '.svg', '.example'])
const failures = []
const warnings = []
const legacyHybridSpelling = new RegExp(['hy', 'bird'].join(''), 'i')
const emailPlaceholder = ['YOUR_EMAIL', 'example.com'].join('@')
const usernamePlaceholder = ['YOUR_GITHUB', 'USERNAME'].join('_')

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue
    const fullPath = path.join(directory, entry.name)
    if (fullPath === path.join(root, 'release', 'package')) continue
    if (entry.isDirectory()) walk(fullPath)
    else inspect(fullPath)
  }
}

function inspect(filePath) {
  const extension = path.extname(filePath)
  if (!textExtensions.has(extension) && !filePath.endsWith('.gitignore') && !filePath.endsWith('.npmignore')) return
  const relative = path.relative(root, filePath)
  const content = fs.readFileSync(filePath, 'utf8')
  const forbidden = [
    [/\/Users\/[A-Za-z0-9._-]+\//, 'local absolute path'],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'possible API key'],
    [/\bBearer\s+[A-Za-z0-9._-]{24,}\b/i, 'possible bearer token'],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'possible private key']
  ]
  for (const [pattern, label] of forbidden) if (pattern.test(content)) failures.push(`${relative}: ${label}`)
  if (legacyHybridSpelling.test(content)) failures.push(`${relative}: obsolete Hybrid spelling; use "Hybrid"`)
  if (content.includes(emailPlaceholder) || content.includes(usernamePlaceholder)) warnings.push(`${relative}: release placeholder remains`)
}

walk(root)

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
if (packageJson.private === true) failures.push('package.json: package is private')
if (packageJson.license !== 'Apache-2.0') failures.push('package.json: license must be Apache-2.0')
if (packageJson.types !== 'src/index.d.ts') failures.push('package.json: types entry must point to src/index.d.ts')
if (!fs.existsSync(path.join(root, 'src', 'index.d.ts'))) failures.push('src/index.d.ts: public type declarations are missing')

for (const warning of [...new Set(warnings)]) console.warn(`WARN  ${warning}`)
if (failures.length) {
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  process.exitCode = 1
} else {
  console.log('PASS  release safety checks')
}
