'use strict'
const test = require('node:test')
for (const name of ['output-boundary', 'bounded-loop', 'candidate-selection']) {
  test(`documented quickstart runs: ${name}`, async () => require(`../examples/quickstart/${name}/run`).main())
}
