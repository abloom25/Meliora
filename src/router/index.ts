import { createRouter, createWebHistory } from 'vue-router'
import PlayerView from '../views/PlayerView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'player', component: PlayerView },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('../admin/AdminApp.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('../views/NotFoundView.vue'),
    },
  ],
})

export default router
