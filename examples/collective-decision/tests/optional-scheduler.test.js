const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

test('optional scheduler module imports without pg-boss and explains how to enable it', () => {
  const code = `
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(id, ...args) {
      if (id === 'pg-boss') throw Object.assign(new Error("Cannot find module 'pg-boss'"), { code: 'MODULE_NOT_FOUND' });
      return original.call(this, id, ...args);
    };
    const assert = require('node:assert/strict');
    const { MonitorScheduler } = require('./src/monitor-scheduler');
    assert.throws(() => new MonitorScheduler({}), /connectionString is required/);
    assert.throws(() => new MonitorScheduler({ connectionString: 'unused' }), error => error.code === 'OPTIONAL_DEPENDENCY_MISSING' && error.message.includes('--include=optional'));
  `
  assert.doesNotThrow(() => execFileSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }))
})
