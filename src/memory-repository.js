class MemoryRepository {
  constructor() {
    this.records = new Map()
  }

  async create(record) {
    if (this.records.has(record.id)) throw new Error(`record already exists: ${record.id}`)
    this.records.set(record.id, structuredClone(record))
    return structuredClone(record)
  }

  async get(id) {
    const record = this.records.get(id)
    return record ? structuredClone(record) : null
  }

  async save(record) {
    if (!this.records.has(record.id)) throw new Error(`record not found: ${record.id}`)
    this.records.set(record.id, structuredClone(record))
    return structuredClone(record)
  }
}

module.exports = { MemoryRepository }
