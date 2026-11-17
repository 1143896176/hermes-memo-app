import 'vant/lib/index.css'
import './style.css'
import { createApp } from 'vue'
import Vant from 'vant'
import App from './App.vue'

// 全量注册：模板里统一写 <van-xxx>，各组件内按需 import 的名字（NavBar 等）
// 与 kebab-case 标签解析不到一起，必须走全局注册，否则 resolveComponent 失败、
// van-* 会退化成原生未知标签（组件不渲染、v-model/事件全部失效）。
createApp(App).use(Vant).mount('#app')
