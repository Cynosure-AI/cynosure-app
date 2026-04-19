import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/dashboard'
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
      component: () => import('@/views/triggers/ChatTriggerView.vue')
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
      redirect: '/settings/providers'
    },
    {
      path: '/settings/providers',
      name: 'settings-providers',
      component: () => import('@/views/settings/ProvidersSettingsView.vue')
    },
    {
      path: '/settings/mcp',
      name: 'settings-mcp',
      component: () => import('@/views/settings/McpSettingsView.vue')
    },
    {
      path: '/settings/memory',
      name: 'settings-memory',
      component: () => import('@/views/settings/MemorySettingsView.vue')
    },
    {
      path: '/settings/preferences',
      name: 'settings-preferences',
      component: () => import('@/views/settings/PreferencesView.vue')
    },
    {
      path: '/settings/backup',
      name: 'settings-backup',
      component: () => import('@/views/settings/BackupSettingsView.vue')
    },
    {
      path: '/settings/speech-to-text',
      name: 'settings-speech-to-text',
      component: () => import('@/views/settings/SpeechToTextView.vue')
    }
  ]
})

export default router
