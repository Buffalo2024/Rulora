const { HybirdPipeline } = require('../../src')

const slots = {
  headline: { maxChars: 18, maxLines: 1 },
  insight: { maxChars: 28, maxLines: 2 },
  nextStep: { maxChars: 16, maxLines: 1 }
}

const pipeline = new HybirdPipeline({
  id: 'stable-image-reproduction-demo',
  steps: [
    {
      id: 'model_fit_copy_to_slots',
      owner: 'model',
      run: async input => ({ ...input, copy: { headline: '让反馈持续转化为改进', insight: '集中收集并建立统一分类规则', nextStep: '先验证一周流程' } })
    },
    {
      id: 'program_validate_slot_capacity',
      owner: 'program',
      run: async value => value,
      validate: async value => {
        const overflow = Object.entries(value.copy).find(([key, text]) => [...text].length > slots[key].maxChars)
        return overflow ? { field: overflow[0], reason: 'overflow' } : true
      }
    },
    {
      id: 'program_fuse_registered_slots',
      owner: 'program',
      run: async value => ({ ...value, finalImage: 'mock://stable-reproduction.png', outsideSlotChangedPixels: 0 })
    },
    {
      id: 'program_pixel_and_ocr_gate',
      owner: 'program',
      run: async value => ({ ...value, qa: { passed: value.outsideSlotChangedPixels === 0 } }),
      validate: async value => value.qa.passed || value.qa
    }
  ]
})

pipeline.run({ template: 'mock://approved-full-copy-design.png', slots })
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
