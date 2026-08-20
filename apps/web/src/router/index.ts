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
    // Triggers
    {
      path: '/chat',
      redirect: '/triggers/chat'
    },
    {
      path: '/triggers/chat',
      name: 'triggers-chat',
      component: () => import('@/views/triggers/ChatView.vue')
    },
    {
      path: '/triggers/chat/:conversationId',
      name: 'conversation',
      component: () => import('@/views/triggers/ChatView.vue')
    },
    {
      path: '/triggers/cron',
      name: 'triggers-cron',
      component: () => import('@/views/triggers/CronView.vue')
    },
    {
      path: '/triggers/cron/:id',
      name: 'cron-detail',
      component: () => import('@/views/triggers/CronDetailView.vue')
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
      name: 'artifacts',
      component: () => import('@/views/ArtifactsView.vue')
    },
    // Memory Spaces
    {
      path: '/memory-spaces',
      redirect: '/memory-spaces/documents'
    },
    {
      path: '/memory-spaces/:section(documents|relationships|visual-graph)',
      name: 'memory-spaces',
      component: () => import('@/views/MemorySpacesView.vue')
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
      component: () => import('@/views/triggers/ChannelDetailView.vue')
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
