import { createRouter, createWebHistory } from 'vue-router'
import { SK_ONBOARDING_COMPLETE } from '@/utils/storage-keys'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/dashboard'
    },
    {
      path: '/onboarding',
      name: 'onboarding',
      component: () => import('@/views/OnboardingView.vue')
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue')
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
      name: 'triggers-channels',
      component: () => import('@/views/triggers/ChannelsView.vue')
    },
    {
      path: '/triggers/channels/:id',
      name: 'channel-detail',
      component: () => import('@/views/triggers/ChannelDetailView.vue')
    },
    {
      path: '/triggers/file-watchers',
      name: 'triggers-file-watchers',
      component: () => import('@/views/triggers/FileWatchView.vue')
    },
    {
      path: '/triggers/file-watchers/:id',
      name: 'file-watcher-detail',
      component: () => import('@/views/triggers/FileWatchDetailView.vue')
    },
    // Instances
    {
      path: '/instances',
      name: 'instances',
      component: () => import('@/views/InstancesView.vue')
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
    // Memory Spaces
    {
      path: '/memory-spaces',
      name: 'memory-spaces',
      component: () => import('@/views/MemorySpacesView.vue')
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
      redirect: '/settings/ai'
    },
    {
      path: '/settings/ai',
      name: 'settings-ai',
      component: () => import('@/views/settings/AISettingsView.vue')
    },
    {
      path: '/settings/providers',
      redirect: { name: 'settings-ai', query: { tab: 'providers' } }
    },
    {
      path: '/settings/mcp',
      name: 'settings-mcp',
      component: () => import('@/views/settings/McpSettingsView.vue')
    },
    {
      path: '/settings/memory',
      redirect: { name: 'settings-ai', query: { tab: 'memory' } }
    },
    {
      path: '/settings/appearance',
      name: 'settings-appearance',
      component: () => import('@/views/settings/AppearanceView.vue')
    },
    {
      path: '/settings/preferences',
      redirect: { name: 'settings-appearance' }
    },
    {
      path: '/settings/backup',
      name: 'settings-backup',
      component: () => import('@/views/settings/BackupSettingsView.vue')
    },
    {
      path: '/settings/speech-to-text',
      redirect: { name: 'settings-ai', query: { tab: 'speech-to-text' } }
    }
  ]
})

// Redirect to onboarding on first visit (before any providers are configured)
router.beforeEach((to) => {
  if (to.name === 'dashboard' || to.path === '/dashboard') {
    const done = localStorage.getItem(SK_ONBOARDING_COMPLETE)
    if (!done || done === 'false') {
      return { name: 'onboarding' }
    }
  }
})

export default router
