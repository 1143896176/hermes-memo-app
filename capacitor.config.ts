import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.hermes.memo',
  appName: '智能备忘录',
  webDir: 'dist',
  plugins: {
    Nodejs: {
      nodeDir: 'nodejs',
      startMode: 'auto',
    },
  },
  server: {
    // 允许 WebView 直接 fetch 外部 API（智谱、OpenAI 等）
    allowNavigation: ['open.bigmodel.cn', 'api.openai.com', 'fastai.enncloud.cn'],
    // Android WebView cleartext 默认关闭，这里不需要（都是 HTTPS）
  },
};

export default config;