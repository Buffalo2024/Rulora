const { MemoryRepository, OrchestrationMachine } = require('../../src')
const scenario = require('./scenario')

async function main() {
  const machine = new OrchestrationMachine({
    repository: new MemoryRepository(),
    scenario,
    defaults: { tokenLimit: 4000 }
  })

  const session = await machine.createSession({ id: 'demo-diagnosis', sessionKey: 'demo-user' })
  console.log('OPENING', machine.openingMessage())
  console.log('STATE', session)

  await machine.recordUserTurn('demo-diagnosis', {
    sessionKey: 'demo-user',
    turnId: 'turn-1',
    text: '我负责整理客户反馈，每周交付一份产品问题清单。'
  })
  console.log('BRANCH 1', await machine.submitFields('demo-diagnosis', {
    sessionKey: 'demo-user',
    sourceTurnId: 'turn-1',
    fields: { role: '整理客户反馈', deliverable: '产品问题清单' }
  }))

  await machine.recordUserTurn('demo-diagnosis', {
    sessionKey: 'demo-user',
    turnId: 'turn-2',
    text: '每周汇总多个群聊，最麻烦的是重复分类。'
  })
  console.log('BRANCH 2', await machine.submitFields('demo-diagnosis', {
    sessionKey: 'demo-user',
    sourceTurnId: 'turn-2',
    fields: { task: '汇总多个群聊中的反馈', bottleneck: '大量反馈需要重复分类' }
  }))

  console.log('FROZEN', await machine.freeze('demo-diagnosis', { sessionKey: 'demo-user' }))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
