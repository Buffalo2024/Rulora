'use strict'
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
function markdownFiles(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`
    return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith('.md') ? [file] : []
  })
}
const files = ['README.md', 'README_EN.md', 'CONTRIBUTING.md', 'SECURITY.md',
  ...markdownFiles('docs'), ...markdownFiles('examples/collective-decision/docs'),
  'examples/integrations/README.md', 'examples/collective-decision/examples/fixtures/static/README.md',
  'examples/quickstart/README.md', ...['collective-decision'].flatMap(name => [`examples/${name}/README.md`, `examples/${name}/README_EN.md`])]
const failures = []
for (const file of files) {
  const content = fs.readFileSync(path.join(root, file), 'utf8')
  const links = [...content.matchAll(/\]\(<?([^\s)>]+)>?\)/g), ...content.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])
  for (const link of links) {
    if (/^(?:[a-z]+:|#)/i.test(link)) continue
    const target = decodeURIComponent(link.split('#')[0].split('?')[0])
    if (target && !fs.existsSync(path.resolve(root, path.dirname(file), target))) failures.push(`${file}: missing ${target}`)
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
else console.log(`PASS local documentation targets (${files.length} files); remote URLs and anchors not verified`)
