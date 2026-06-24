import { createRouter, createWebHistory } from 'vue-router'
import App from '../App.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'player', component: App },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('../admin/AdminApp.vue'),
    },
  ],
})

export default router
