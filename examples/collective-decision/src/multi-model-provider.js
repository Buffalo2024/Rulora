// Compatibility entry point. The only maintained implementation lives under
// src/providers so production, smoke tests and any older imports share one
// phase-specific protocol implementation.
module.exports = require('./providers/multi-model-provider')
