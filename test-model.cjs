// 复现 model.invoke is not a function
const config = require('./public/nodejs/config.js');
config.setConfig({
  apiKey: 'test-key',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4-flash',
  temperature: 0,
});

(async () => {
  console.log('--- getting model ---');
  const model = await config.getModel();
  console.log('model type:', typeof model);
  console.log('model constructor:', model && model.constructor && model.constructor.name);
  console.log('invoke:', typeof model.invoke);
  console.log('stream:', typeof model.stream);
  console.log('--- invoke own? ---', Object.prototype.hasOwnProperty.call(model, 'invoke'));

  const vendor = require('./public/nodejs/vendor.bundle.js');
  console.log('--- instanceof ChatOpenAI? ---', model instanceof vendor.ChatOpenAI);
  console.log('--- instanceof BaseChatOpenAI? ---', model instanceof vendor.BaseChatOpenAI);

  // 看 model 的原型链
  let p = model;
  const chain = [];
  while (p) {
    chain.push(p.constructor && p.constructor.name || 'Object');
    p = Object.getPrototypeOf(p);
  }
  console.log('--- proto chain ---', chain.join(' -> '));

  // 尝试调用 invoke 来验证
  try {
    await model.invoke('hi');
    console.log('invoke OK');
  } catch (e) {
    console.log('invoke threw:', e.message);
  }

  // 现在尝试 createDeepAgent
  console.log('\n--- trying createDeepAgent ---');
  try {
    const agent = await vendor.createDeepAgent({
      model,
      systemPrompt: 'You are helpful.',
      tools: [],
    });
    console.log('agent type:', typeof agent);
    console.log('agent.invoke:', typeof agent.invoke);
    console.log('agent.stream:', typeof agent.stream);
    console.log('agent keys:', Object.keys(agent).slice(0, 20).join(', '));
  } catch (e) {
    console.log('createDeepAgent threw:', e.message);
    console.log(e.stack.split('\n').slice(0, 8).join('\n'));
  }
})();