import { createAdminApi } from '../services/admin-api'
import { markAdminUnauthenticated } from './useAdminAuth'

const adminApi = createAdminApi({ onUnauthenticated: markAdminUnauthenticated })

export function useAdminApi(): ReturnType<typeof createAdminApi> {
  return adminApi
}
