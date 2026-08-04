const { HybirdPipeline } = require('../../src')
const { IMMUTABLE_MARK, buildNativeReportPrompt } = require('./visual-prompt')

const sampleReport = {
  title: '让零散反馈成为持续改进的依据',
  summary: '你判断问题，数字协作者持续归类与追踪。',
  value: ['保留人的判断标准', '减少重复整理', '形成团队可复用的问题资产'],
  potential: ['从处理反馈转向设计改进机制', '让经验被更多协作者使用'],
  tasks: ['汇总多渠道反馈', '按统一规则分类', '关联证据与责任人', '持续追踪处理结果'],
  steps: ['先验证一周真实流程', '固定分类与复盘规则', '接入稳定的数据来源'],
  plan: ['第1周选定样本', '第2—3周跑通闭环', '第4周复盘并固化']
}

const pipeline = new HybirdPipeline({
  id: 'native-image-report-demo',
  steps: [
    {
      id: 'model_build_report',
      owner: 'model',
      run: async input => ({ ...input, report: sampleReport })
    },
    {
      id: 'program_validate_report',
      owner: 'program',
      run: async value => value,
      validate: async value => value.report.title.length <= 24 || { field: 'title', reason: 'too_long' }
    },
    {
      id: 'program_select_visual_story',
      owner: 'program',
      run: async value => ({ ...value, visualStory: 'A' })
    },
    {
      id: 'program_build_image_task',
      owner: 'program',
      run: async value => ({
        ...value,
        imageTask: {
          prompt: buildNativeReportPrompt(value),
          immutableRequiredText: [IMMUTABLE_MARK]
        }
      }),
      validate: async value => value.imageTask.prompt.includes(IMMUTABLE_MARK) || { reason: 'immutable_mark_missing_from_prompt' }
    },
    {
      id: 'image_generate_native_report',
      owner: 'model',
      run: async value => ({
        ...value,
        candidateImage: 'mock://native-report-v1.png',
        mockOcrText: `Rulora Hybird 开源案例 ${value.report.title} ${IMMUTABLE_MARK}`
      })
    },
    {
      id: 'program_quality_gate',
      owner: 'program',
      run: async value => ({
        ...value,
        qa: {
          passed: value.mockOcrText.includes(IMMUTABLE_MARK),
          checks: ['required-copy', 'immutable-open-source-mark', 'readability', 'visual-density']
        }
      }),
      validate: async value => value.qa.passed || value.qa
    }
  ]
})

pipeline.run({ frozenFacts: ['每周整理反馈', '重复分类耗时'] })
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
