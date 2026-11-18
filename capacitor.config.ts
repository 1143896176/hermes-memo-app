import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.hermes.memo',
  appName: '智能备忘录',
  webDir: 'dist',
  backgroundColor: '#ffffff',
  plugins: {
    Nodejs: {
      nodeDir: 'nodejs',
      startMode: 'auto',
    },
    Keyboard: {
      // iOS 的 WKWebView 不会因为弹键盘自动改视口高度（Android 靠 adjustResize），
      // 不设 native 的话底部输入框会被键盘整个盖住、用户看不见自己打的字。
      resize: 'native',
      // App 只有浅色主题（style.css 锁定 color-scheme: light），键盘也统一浅色，
      // 否则系统深色模式下会弹出黑键盘，和界面割裂。
      style: 'LIGHT',
      // 键盘背后的补白按页面背景色走，避免深色模式下键盘下方闪一块黑边。
      autoBackdropColor: 'auto',
    },
  },
  server: {
    // 允许 WebView 直接 fetch 外部 API（智谱、OpenAI、Groq 等）
    allowNavigation: ['open.bigmodel.cn', 'api.openai.com', 'fastai.enncloud.cn'],
    // Android WebView cleartext 默认关闭，这里不需要（都是 HTTPS）
  },
  ios: {
    // WebView 铺满到刘海下沿，靠 CSS env(safe-area-inset-*) 自己让位：
    // 这样 NavBar 的 safe-area-inset-top 和 Tabbar 的 safe-area-inset-bottom 才拿得到真实数值。
    contentInset: 'never',
    // 禁止捏合/双击缩放（原生壳里缩放只会让布局错位）
    zoomEnabled: false,
    // 按手机视口渲染，不要走桌面视口
    preferredContentMode: 'mobile',
    // 和全局一致：键盘/转场时露白，而不是默认黑
    backgroundColor: '#ffffff',
  },
};

export default config;
