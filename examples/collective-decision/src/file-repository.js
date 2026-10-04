const fs = require('node:fs/promises')
const path = require('node:path')
const { safeId, writeJsonAtomic } = require('./utils')
const { withFileLock } = require('./file-lock')

class FileRepository {
  constructor(rootDirectory) {
    this.rootDirectory = path.resolve(rootDirectory)
  }

  filePath(id) {
    return path.join(this.rootDirectory, `${safeId(id)}.json`)
  }

  async create(record) {
    const filePath = this.filePath(record.id)
    await fs.mkdir(this.rootDirectory, { recursive: true })
    try {
      await fs.access(filePath)
      throw new Error(`record already exists: ${record.id}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const versioned = { ...record, _version: 1 }
    await withFileLock(`${filePath}.lock`, async () => {
      try {
        await fs.access(filePath)
        throw new Error(`record already exists: ${record.id}`)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await writeJsonAtomic(filePath, versioned)
    })
    return structuredClone(versioned)
  }

  async get(id) {
    try {
      return JSON.parse(await fs.readFile(this.filePath(id), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async save(record, { expectedVersion = record._version } = {}) {
    const filePath = this.filePath(record.id)
    return withFileLock(`${filePath}.lock`, async () => {
      const current = await this.get(record.id)
      if (!current) throw new Error(`record not found: ${record.id}`)
      if (!Number.isInteger(expectedVersion) || expectedVersion !== current._version) {
        const error = new Error(`CAS conflict for ${record.id}: expected ${expectedVersion}, current ${current._version}`)
        error.code = 'CAS_CONFLICT'
        throw error
      }
      const next = { ...record, _version: current._version + 1 }
      await writeJsonAtomic(filePath, next)
      return structuredClone(next)
    })
  }
}

module.exports = { FileRepository }
