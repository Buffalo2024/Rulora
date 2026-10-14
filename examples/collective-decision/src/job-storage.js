const path = require('node:path')
const PREFIX = '@rulora/'
const pathKey = key => /(?:_path|_directory|_root)$/.test(key) || key === 'path'
function relativeInside(root, value) {
  const flavor = path.win32.isAbsolute(root) && !path.posix.isAbsolute(root) ? path.win32 : path
  if (!flavor.isAbsolute(value)) return null
  const relative = flavor.relative(root, value)
  return relative === '' || (!flavor.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${flavor.sep}`))
    ? relative.split(flavor.sep).join('/') : null
}
function walk(value, convert, key = '', parent = '') {
  if (typeof value === 'string') return pathKey(key) || parent === 'artifacts' ? convert(value) : value
  if (Array.isArray(value)) return value.map(item => walk(item, convert, key, parent))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, k === 'storage_origins' ? structuredClone(v) : walk(v, convert, k, key)]))
}
class JobStorage {
  constructor({ codeRoot, dataRoot }) { this.codeRoot = path.resolve(codeRoot); this.dataRoot = path.resolve(dataRoot) }
  origins(job) {
    const declared = job.storage_origins || {}
    const data = new Set([this.dataRoot, ...(declared.data_roots || [])])
    const code = new Set([this.codeRoot, ...(declared.code_roots || [])])
    // Derive the old root only from the exact established task layout; never
    // guess a basename or search for a convenient replacement file.
    const output = job.output_directory
    if (typeof output === 'string' && (path.isAbsolute(output) || path.win32.isAbsolute(output))) {
      const p = path.win32.isAbsolute(output) && !path.posix.isAbsolute(output) ? path.win32 : path
      const suffix = p.join('web-ui', 'outputs', job.job_id || '')
      if (output.endsWith(p.sep + suffix)) {
        const oldData = output.slice(0, -(suffix.length + 1)); data.add(oldData)
        if (p.basename(oldData) === '.runtime') code.add(p.dirname(oldData))
      }
    }
    return { data_roots: [...data], code_roots: [...code] }
  }
  mapping(job) {
    const origins = this.origins(job)
    return [...origins.data_roots.map(root => ({root, target:this.dataRoot, scope:'data'})),
      ...origins.code_roots.map(root => ({root, target:this.codeRoot, scope:'code'}))].sort((a,b) => b.root.length-a.root.length)
  }
  decodePath(value, mappings) {
    if (value.startsWith(PREFIX)) {
      const match = value.match(/^@rulora\/(data|code)\/(.*)$/)
      if (!match || match[2].includes('\\') || match[2].split('/').some(part => part === '..') || path.isAbsolute(match[2])) throw new Error('Invalid portable storage path')
      const root = match[1] === 'data' ? this.dataRoot : this.codeRoot
      const resolved = path.resolve(root, match[2])
      if (relativeInside(root, resolved) === null) throw new Error('Portable storage path escapes root')
      return resolved
    }
    for (const m of mappings) { const relative = relativeInside(m.root, value); if (relative !== null) return path.resolve(m.target, relative) }
    return value // External files require their own explicit mount or import.
  }
  decode(job) {
    const origins = this.origins(job), mappings = this.mapping(job)
    return { ...walk(job, value => this.decodePath(value, mappings)), storage_origins: origins }
  }
  encode(job) {
    const origins = this.origins(job), mappings = this.mapping(job)
    const value = walk(job, input => {
      const decoded = this.decodePath(input, mappings)
      for (const [root,scope] of [[this.dataRoot,'data'],[this.codeRoot,'code']]) {
        const relative = relativeInside(root, decoded)
        if (relative !== null) return `${PREFIX}${scope}/${relative}`
      }
      return decoded
    })
    return { ...value, storage_paths_version: 1, storage_origins: origins }
  }
  rebaseDocument(job, document) { return walk(document, value => this.decodePath(value, this.mapping(job))) }
}
module.exports = { JobStorage }
