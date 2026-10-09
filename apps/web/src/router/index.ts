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
    // Activity
    {
      path: '/activity',
      name: 'activity',
      component: () => import('@/views/ActivityLogView.vue')
    },
    // Projects
    {
      path: '/projects',
      name: 'projects',
      component: () => import('@/views/ProjectsView.vue')
    },
    {
      path: '/projects/:id',
      name: 'project-detail',
      component: () => import('@/views/ProjectDetailView.vue')
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
    // Library
    {
      path: '/library',
      redirect: '/library/generated'
    },
    {
      path: '/library/:section(generated|uploads)',
      name: 'library',
      component: () => import('@/views/LibraryView.vue')
    },
    // Preserve bookmarks created before Artifacts was renamed to Library.
    {
      path: '/artifacts/:section(generated|uploads)?',
      redirect: (to) => `/library/${typeof to.params.section === 'string' ? to.params.section : 'generated'}`
    },
    // Memory Folders
    {
      path: '/memory-folders',
      redirect: '/memory-folders/documents'
    },
    {
      // The knowledge graph views were removed; keep old links working.
      path: '/memory-folders/:section(relationships|visual-graph)',
      redirect: '/memory-folders/documents'
    },
    {
      path: '/memory-folders/:section(documents)',
      name: 'memory-folders',
      component: () => import('@/views/MemoryView.vue')
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
