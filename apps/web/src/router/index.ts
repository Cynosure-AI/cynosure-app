import { createRouter, createWebHistory } from 'vue-router'
import { SK_ONBOARDING_COMPLETE } from '@/utils/storage-keys'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/chat'
    },
    {
      path: '/onboarding',
      name: 'onboarding',
      component: () => import('@/views/OnboardingView.vue')
    },
    // Chat
    {
      path: '/chat',
      name: 'triggers-chat',
      component: () => import('@/views/triggers/ChatView.vue')
    },
    {
      path: '/chat/:conversationId',
      name: 'conversation',
      component: () => import('@/views/triggers/ChatView.vue')
    },
    // Legacy trigger-prefixed URLs
    {
      path: '/triggers/chat',
      redirect: { name: 'triggers-chat' }
    },
    {
      path: '/triggers/chat/:conversationId',
      redirect: (to) => ({
        name: 'conversation',
        params: { conversationId: to.params.conversationId }
      })
    },
    // Scheduled jobs
    {
      path: '/cron',
      name: 'triggers-cron',
      component: () => import('@/views/triggers/CronView.vue')
    },
    {
      path: '/cron/:id',
      name: 'cron-detail',
      component: () => import('@/views/triggers/CronDetailView.vue')
    },
    {
      path: '/triggers/cron',
      redirect: { name: 'triggers-cron' }
    },
    {
      path: '/triggers/cron/:id',
      redirect: (to) => ({
        name: 'cron-detail',
        params: { id: to.params.id }
      })
    },
    {
      path: '/triggers/channels',
      redirect: { name: 'settings-channels' }
    },
    {
      path: '/triggers/channels/:id',
      redirect: (to) => ({
        name: 'settings-channel-detail',
        params: { id: to.params.id }
      })
    },
    {
      path: '/instances',
      redirect: { name: 'activity' }
    },
    // Activity
    {
      path: '/activity',
      name: 'activity',
      component: () => import('@/views/ActivityLogView.vue')
    },
    // Agents
    {
      path: '/agents',
      name: 'agents',
      component: () => import('@/views/AgentsView.vue')
    },
    {
      path: '/agents/:id',
      name: 'agent-detail',
      component: () => import('@/views/AgentDetailView.vue')
    },
    // Artifacts
    {
      path: '/artifacts',
      redirect: '/artifacts/generated'
    },
    {
      path: '/artifacts/:section(generated|uploads)',
      name: 'artifacts',
      component: () => import('@/views/ArtifactsView.vue')
    },
    // Memory Categories
    {
      path: '/memory-categories',
      redirect: '/memory-categories/documents'
    },
    {
      path: '/memory-categories/:section(documents|relationships|visual-graph)',
      name: 'memory-categories',
      component: () => import('@/views/MemoryCategoriesView.vue')
    },
    {
      path: '/tools-policy',
      name: 'tools-policy',
      component: () => import('@/views/ToolsPolicyView.vue')
    },
    // Notifications
    {
      path: '/notifications',
      name: 'notifications',
      component: () => import('@/views/NotificationsView.vue')
    },
    // Usage
    {
      path: '/usage',
      name: 'usage',
      component: () => import('@/views/UsageView.vue')
    },
    // Settings
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/settings/SettingsView.vue')
    },
    {
      path: '/settings/ai',
      redirect: (to) => {
        const tab = typeof to.query.tab === 'string' ? to.query.tab : 'providers'
        const category = tab === 'speech-to-text' || tab === 'memory' || tab === 'chat'
          ? tab
          : 'providers'
        return { name: 'settings', query: { category } }
      }
    },
    {
      path: '/settings/providers',
      redirect: { name: 'settings', query: { category: 'providers' } }
    },
    {
      path: '/settings/mcp',
      name: 'settings-mcp',
      component: () => import('@/views/settings/McpSettingsView.vue')
    },
    {
      path: '/settings/channels',
      name: 'settings-channels',
      redirect: { name: 'settings', query: { category: 'channels' } }
    },
    {
      path: '/settings/channels/:id',
      name: 'settings-channel-detail',
      redirect: (to) => ({
        name: 'settings',
        query: {
          ...to.query,
          category: 'channels',
          channel: String(to.params.id),
        },
      })
    },
    {
      path: '/settings/memory',
      redirect: { name: 'settings', query: { category: 'memory' } }
    },
    {
      path: '/settings/general',
      redirect: { name: 'settings', query: { category: 'general' } }
    },
    {
      path: '/settings/desktop',
      redirect: { name: 'settings', query: { category: 'desktop-application' } }
    },
    {
      path: '/settings/appearance',
      redirect: { name: 'settings', query: { category: 'general' } }
    },
    {
      path: '/settings/preferences',
      redirect: { name: 'settings', query: { category: 'general' } }
    },
    {
      path: '/settings/backup',
      redirect: { name: 'settings', query: { category: 'backup' } }
    },
    {
      path: '/settings/speech-to-text',
      redirect: { name: 'settings', query: { category: 'speech-to-text' } }
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue')
    }
  ]
})

const onboardingComplete = () => localStorage.getItem(SK_ONBOARDING_COMPLETE) === 'true'

router.beforeEach((to) => {
  if (!onboardingComplete() && to.name !== 'onboarding') {
    return { name: 'onboarding' }
  }
})

export default router
