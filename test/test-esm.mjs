import { ChatOpenAI, createDeepAgent, FilesystemBackend, MemorySaver } from '../public/nodejs/vendor.bundle.mjs';

const c = new ChatOpenAI({ model: 'gpt-4', apiKey: 'sk-test' });
console.log('getName:', c.getName());
console.log('invoke:', typeof c.invoke);
console.log('_modelType in c:', '_modelType' in c);
console.log('--- createDeepAgent ---');
try {
  const agent = await createDeepAgent({ model: c, systemPrompt: 'helpful', tools: [] });
  console.log('agent.invoke:', typeof agent.invoke);
  console.log('agent.stream:', typeof agent.stream);
} catch (e) {
  console.log('threw:', e.message);
}
