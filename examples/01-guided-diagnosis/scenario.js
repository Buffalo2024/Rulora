module.exports = {
  id: 'workloop-lite',
  opening: '我们用一个简短示例了解你的工作。',
  branches: [
    {
      id: 'work_anchor',
      label: '工作锚点',
      openingQuestion: '你主要负责什么工作，通常交付什么结果？',
      requiredFields: ['role', 'deliverable'],
      fields: {
        role: { schema: { type: 'string', minLength: 2, maxLength: 40 } },
        deliverable: { schema: { type: 'string', minLength: 2, maxLength: 60 } }
      }
    },
    {
      id: 'repeated_task',
      label: '重复任务',
      openingQuestion: '最近一项以后还会重复发生的任务是什么？',
      requiredFields: ['task', 'bottleneck'],
      fields: {
        task: { schema: { type: 'string', minLength: 3, maxLength: 80 } },
        bottleneck: { schema: { type: 'string', minLength: 3, maxLength: 100 } }
      }
    }
  ],
  output: {
    type: 'object',
    required: ['summary', 'recommended_next_step'],
    properties: {
      summary: { type: 'string', maxLength: 120 },
      recommended_next_step: { type: 'string', maxLength: 120 }
    }
  }
}
