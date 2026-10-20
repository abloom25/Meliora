import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { wireApplication } from './app/composition-root'
import router from './router'
import './styles/global.scss'

const app = createApp(App)

app.config.errorHandler = (error, _instance, info) => {
  console.error('[全局错误]', info, error)
}

app.use(createPinia())
// 接线要在挂载之前:store 一旦被组件用起来就该已经装好各处实现
wireApplication()
app.use(router)
app.mount('#app')

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
  })
}
