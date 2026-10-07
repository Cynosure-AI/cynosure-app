type RegistryServerEntry = {
    server: Record<string, unknown>
    _meta?: Record<string, unknown>
}

type EnvironmentVariable = {
    name: string
    description?: string
    isRequired: boolean
    format?: string
    isSecret?: boolean
}

export type RecommendedCategory = 'productivity' | 'development' | 'files' | 'web' | 'media' | 'ai' | 'communication' | 'utilities'

/** Cynosure-specific metadata attached to curated entries (category chip and publisher label). */
export const CYNOSURE_META_KEY = 'ai.cynosure/recommended'

type CuratedInfo = {
    title: string
    description: string
    publisher: string
    category: RecommendedCategory
    websiteUrl?: string
    repositoryUrl?: string
    icon?: string
}

function iconFor(src: string): { src: string; mimeType: string }[] {
    const mimeType = src.endsWith('.svg') ? 'image/svg+xml'
        : src.endsWith('.ico') ? 'image/x-icon'
            : 'image/png'
    return [{ src, mimeType }]
}

function curated(name: string, info: CuratedInfo, server: Record<string, unknown>): RegistryServerEntry {
    return {
        server: {
            name,
            title: info.title,
            description: info.description,
            version: 'latest',
            ...(info.websiteUrl ? { websiteUrl: info.websiteUrl } : {}),
            ...(info.repositoryUrl ? { repository: { url: info.repositoryUrl, source: 'github' } } : {}),
            ...(info.icon ? { icons: iconFor(info.icon) } : {}),
            ...server,
        },
        _meta: { [CYNOSURE_META_KEY]: { category: info.category, publisher: info.publisher } },
    }
}

/** Hosted Streamable HTTP server. Servers that need sign-in use the OAuth flow on first connect. */
function remoteServer(
    name: string,
    url: string,
    info: CuratedInfo,
    headers?: Record<string, unknown>[],
): RegistryServerEntry {
    return curated(name, info, {
        isRemote: true,
        remotes: [{ type: 'streamable-http', url, ...(headers ? { headers } : {}) }],
    })
}

function npmServer(
    identifier: string,
    info: CuratedInfo,
    environmentVariables?: EnvironmentVariable[],
): RegistryServerEntry {
    return curated(identifier, info, {
        packages: [{
            registryType: 'npm',
            identifier: `${identifier}@latest`,
            version: 'latest',
            transport: { type: 'stdio' },
            ...(environmentVariables ? { environmentVariables } : {}),
        }],
    })
}

const CYNOSURE_MCP_ORGANIZATION = 'Cynosure-MCP-Collection'

/** First-party server from the Cynosure MCP collection, published under `@cynosure-mcp/`. */
function cynosureMcp(
    packageName: string,
    title: string,
    description: string,
    repositoryName: string,
    category: RecommendedCategory,
    environmentVariables?: EnvironmentVariable[],
): RegistryServerEntry {
    return npmServer(packageName, {
        title,
        description,
        publisher: 'Cynosure',
        category,
        repositoryUrl: `https://github.com/${CYNOSURE_MCP_ORGANIZATION}/${repositoryName}`,
        icon: `https://unpkg.com/${packageName}@latest/icon.png`,
    }, environmentVariables)
}

function apiKey(name: string, description: string): EnvironmentVariable[] {
    return [{ name, description, isRequired: true, format: 'password', isSecret: true }]
}

/**
 * Curated, widely used MCP servers from the vendors that maintain them, plus
 * a selection of Cynosure's own servers. Prefer hosted remotes (no local runtime needed) and npm packages; avoid
 * anything that needs Python/uv or duplicates a built-in tool (files, shell,
 * memory, notifications).
 */
export const recommendedServers: RegistryServerEntry[] = [
    // ── Web search & browsing ──────────────────────────────────────────────
    remoteServer('exa', 'https://mcp.exa.ai/mcp', {
        title: 'Exa Search',
        description: 'Search the web and find code examples and research with Exa. No API key needed.',
        publisher: 'Exa',
        category: 'web',
        websiteUrl: 'https://exa.ai/mcp',
        repositoryUrl: 'https://github.com/exa-labs/exa-mcp-server',
        icon: 'https://exa.ai/favicon.ico',
    }),
    npmServer('tavily-mcp', {
        title: 'Tavily',
        description: 'Real-time web search, page extraction, and site crawling built for AI agents.',
        publisher: 'Tavily',
        category: 'web',
        websiteUrl: 'https://tavily.com',
        repositoryUrl: 'https://github.com/tavily-ai/tavily-mcp',
        icon: 'https://tavily.com/favicon.ico',
    }, apiKey('TAVILY_API_KEY', 'Tavily API key from https://app.tavily.com (free tier available).')),
    npmServer('@brave/brave-search-mcp-server', {
        title: 'Brave Search',
        description: 'Private web, news, image, and local search using the independent Brave Search index.',
        publisher: 'Brave',
        category: 'web',
        websiteUrl: 'https://brave.com/search/api/',
        repositoryUrl: 'https://github.com/brave/brave-search-mcp-server',
        icon: 'https://brave.com/static-assets/images/brave-favicon.png',
    }, apiKey('BRAVE_API_KEY', 'Brave Search API key from https://api-dashboard.search.brave.com (free tier available).')),
    npmServer('firecrawl-mcp', {
        title: 'Firecrawl',
        description: 'Scrape, crawl, and extract structured data from any website as clean Markdown.',
        publisher: 'Firecrawl',
        category: 'web',
        websiteUrl: 'https://www.firecrawl.dev',
        repositoryUrl: 'https://github.com/firecrawl/firecrawl-mcp-server',
        icon: 'https://www.firecrawl.dev/favicon.ico',
    }, apiKey('FIRECRAWL_API_KEY', 'Firecrawl API key from https://www.firecrawl.dev/app/api-keys.')),
    npmServer('@playwright/mcp', {
        title: 'Playwright Browser',
        description: 'Let the assistant open pages, click, fill forms, and take screenshots in a real browser.',
        publisher: 'Microsoft',
        category: 'web',
        websiteUrl: 'https://playwright.dev',
        repositoryUrl: 'https://github.com/microsoft/playwright-mcp',
        icon: 'https://playwright.dev/img/playwright-logo.svg',
    }),

    // ── Productivity & business apps ───────────────────────────────────────
    remoteServer('notion', 'https://mcp.notion.com/mcp', {
        title: 'Notion',
        description: 'Search, read, create, and update pages and databases in your Notion workspace.',
        publisher: 'Notion',
        category: 'productivity',
        websiteUrl: 'https://developers.notion.com/docs/mcp',
        repositoryUrl: 'https://github.com/makenotion/notion-mcp-server',
        icon: 'https://www.notion.so/images/favicon.ico',
    }),
    remoteServer('zapier', 'https://mcp.zapier.com/api/mcp/mcp', {
        title: 'Zapier',
        description: 'Connect Gmail, Google Calendar, Slack, Sheets, and 8,000+ other apps through Zapier actions.',
        publisher: 'Zapier',
        category: 'productivity',
        websiteUrl: 'https://zapier.com/mcp',
        icon: 'https://zapier.com/favicon.ico',
    }),
    remoteServer('atlassian', 'https://mcp.atlassian.com/v1/mcp', {
        title: 'Atlassian (Jira & Confluence)',
        description: 'Search and manage Jira issues and Confluence pages from your Atlassian Cloud site.',
        publisher: 'Atlassian',
        category: 'productivity',
        websiteUrl: 'https://www.atlassian.com/platform/remote-mcp-server',
        repositoryUrl: 'https://github.com/atlassian/atlassian-mcp-server',
        icon: 'https://www.atlassian.com/favicon.ico',
    }),
    remoteServer('linear', 'https://mcp.linear.app/mcp', {
        title: 'Linear',
        description: 'Find, create, and update Linear issues, projects, and comments.',
        publisher: 'Linear',
        category: 'productivity',
        websiteUrl: 'https://linear.app/docs/mcp',
        icon: 'https://linear.app/favicon.ico',
    }),
    remoteServer('stripe', 'https://mcp.stripe.com', {
        title: 'Stripe',
        description: 'Look up customers, payments, invoices, and subscriptions, and search the Stripe docs.',
        publisher: 'Stripe',
        category: 'productivity',
        websiteUrl: 'https://docs.stripe.com/mcp',
        repositoryUrl: 'https://github.com/stripe/agent-toolkit',
        icon: 'https://stripe.com/favicon.ico',
    }),

    // ── Media & design ────────────────────────────────────────────────────
    remoteServer('canva', 'https://mcp.canva.com/mcp', {
        title: 'Canva',
        description: 'Create, search, and export Canva designs, presentations, and social posts.',
        publisher: 'Canva',
        category: 'media',
        websiteUrl: 'https://www.canva.dev/docs/mcp/',
        icon: 'https://github.com/canva.png',
    }),

    // ── Development ───────────────────────────────────────────────────────
    remoteServer('github', 'https://api.githubcopilot.com/mcp/', {
        title: 'GitHub',
        description: 'Manage repositories, issues, pull requests, and Actions workflows on GitHub.',
        publisher: 'GitHub',
        category: 'development',
        websiteUrl: 'https://github.com/github/github-mcp-server',
        repositoryUrl: 'https://github.com/github/github-mcp-server',
        icon: 'https://github.githubassets.com/favicons/favicon.svg',
    }, [{
        name: 'Authorization',
        description: 'GitHub personal access token',
        isRequired: true,
        isSecret: true,
        value: 'Bearer {GITHUB_PERSONAL_ACCESS_TOKEN}',
        variables: {
            GITHUB_PERSONAL_ACCESS_TOKEN: {
                description: 'Personal access token from https://github.com/settings/tokens',
                isRequired: true,
                isSecret: true,
            },
        },
    }]),
    npmServer('chrome-devtools-mcp', {
        title: 'Chrome DevTools',
        description: 'Control and inspect Chrome tabs for browser automation, screenshots, console output, and page debugging.',
        publisher: 'Google',
        category: 'development',
        repositoryUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
        icon: 'https://www.google.com/chrome/static/images/chrome-logo.svg',
    }),
    remoteServer('context7', 'https://mcp.context7.com/mcp', {
        title: 'Context7',
        description: 'Up-to-date, version-specific documentation and code examples for popular libraries.',
        publisher: 'Upstash',
        category: 'development',
        websiteUrl: 'https://context7.com',
        repositoryUrl: 'https://github.com/upstash/context7',
        icon: 'https://context7.com/favicon.ico',
    }),
    remoteServer('deepwiki', 'https://mcp.deepwiki.com/mcp', {
        title: 'DeepWiki',
        description: 'Ask questions about any public GitHub repository using AI-generated documentation.',
        publisher: 'Cognition',
        category: 'development',
        websiteUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
        icon: 'https://github.com/CognitionAI.png',
    }),
    remoteServer('sentry', 'https://mcp.sentry.dev/mcp', {
        title: 'Sentry',
        description: 'Investigate errors, issues, and performance problems from your Sentry projects.',
        publisher: 'Sentry',
        category: 'development',
        websiteUrl: 'https://docs.sentry.io/product/sentry-mcp/',
        repositoryUrl: 'https://github.com/getsentry/sentry-mcp',
        icon: 'https://github.com/getsentry.png',
    }),

    // ── AI ────────────────────────────────────────────────────────────────
    remoteServer('huggingface', 'https://huggingface.co/mcp', {
        title: 'Hugging Face',
        description: 'Search models, datasets, Spaces, and papers on the Hugging Face Hub.',
        publisher: 'Hugging Face',
        category: 'ai',
        websiteUrl: 'https://huggingface.co/settings/mcp',
        repositoryUrl: 'https://github.com/huggingface/hf-mcp-server',
        icon: 'https://huggingface.co/favicon.ico',
    }),
    npmServer('@modelcontextprotocol/server-sequential-thinking', {
        title: 'Sequential Thinking',
        description: 'Structured step-by-step reasoning tool for breaking down complex problems.',
        publisher: 'Model Context Protocol',
        category: 'ai',
        repositoryUrl: 'https://github.com/modelcontextprotocol/servers',
        icon: 'https://github.com/modelcontextprotocol.png',
    }),

    // ── Cynosure MCP collection ───────────────────────────────────────────
    cynosureMcp(
        '@cynosure-mcp/webfetch',
        'Webfetch',
        'Fetch web pages with browser rendering and convert them to clean, LLM-readable Markdown.',
        'mcp-webfetch',
        'web',
    ),
    cynosureMcp(
        '@cynosure-mcp/weather',
        'Weather',
        'Fetch current weather and forecasts using the free Open-Meteo API.',
        'mcp-weather',
        'web',
    ),
    cynosureMcp(
        '@cynosure-mcp/document-parser',
        'Document Reader & Writer',
        'Read documents as Markdown, and create or edit DOCX files for downloadable artifacts.',
        'mcp-document-parser',
        'files',
    ),
    cynosureMcp(
        '@cynosure-mcp/computer-controller',
        'Computer Controller',
        'Control the desktop: launch apps, capture screenshots, move the mouse, type text, and interact with the OS.',
        'mcp-computer-controller',
        'files',
        [
            {
                name: 'DISPLAY_INDEX',
                description: 'Restrict screenshot and display operations to a specific monitor index. Leave empty to allow all displays.',
                isRequired: false,
                format: 'number',
            },
            {
                name: 'GEMINI_MODE',
                description: "Set to 'true' to scale screenshots to 1000x1000 for Gemini's native coordinate system.",
                isRequired: false,
                format: 'boolean',
            },
        ],
    ),
    cynosureMcp(
        '@cynosure-mcp/sftp-ssh',
        'SFTP & SSH',
        'Browse and modify remote files over SFTP, and execute non-interactive commands over SSH.',
        'mcp-sftp-ssh',
        'files',
        [
            { name: 'SFTP_HOST', description: 'Remote SSH/SFTP host name or IP address.', isRequired: true, format: 'string' },
            { name: 'SFTP_PORT', description: 'Remote SSH/SFTP port. Defaults to 22.', isRequired: false, format: 'number' },
            { name: 'SFTP_USERNAME', description: 'Remote SSH/SFTP user name.', isRequired: true, format: 'string' },
            { name: 'SFTP_PASSWORD', description: 'Password authentication. Omit when using a private key.', isRequired: false, format: 'password', isSecret: true },
            { name: 'SFTP_PRIVATE_KEY_PATH', description: 'Local path to an SSH private key.', isRequired: false, format: 'string', isSecret: true },
            { name: 'SFTP_PRIVATE_KEY', description: 'Inline SSH private key. Literal \\n sequences are converted to newlines.', isRequired: false, format: 'password', isSecret: true },
            { name: 'SFTP_PRIVATE_KEY_PASSPHRASE', description: 'Optional private-key passphrase.', isRequired: false, format: 'password', isSecret: true },
            { name: 'SFTP_ROOT', description: 'Remote path exposed as the MCP root. Defaults to /.', isRequired: false, format: 'string' },
            { name: 'SSH_HOST_FINGERPRINT', description: 'Optional SHA-256 host-key fingerprint.', isRequired: false, format: 'string' },
        ],
    ),
    cynosureMcp(
        '@cynosure-mcp/imap-email',
        'IMAP Email',
        'Read, search, draft, and send email through IMAP and SMTP.',
        'mcp-imap-email',
        'communication',
        [
            { name: 'IMAP_HOST', description: 'IMAP server hostname, for example imap.gmail.com.', isRequired: true, format: 'string' },
            { name: 'IMAP_PORT', description: 'IMAP server port. Defaults to 993.', isRequired: false, format: 'number' },
            { name: 'IMAP_USER', description: 'IMAP login username or email address.', isRequired: true, format: 'string' },
            { name: 'IMAP_PASSWORD', description: 'IMAP login password or app-specific password.', isRequired: true, format: 'password', isSecret: true },
            { name: 'SMTP_HOST', description: 'SMTP server hostname. Falls back to IMAP_HOST if not set.', isRequired: false, format: 'string' },
            { name: 'SMTP_PORT', description: 'SMTP server port. Defaults to 587.', isRequired: false, format: 'number' },
            { name: 'SMTP_USER', description: 'SMTP login user. Falls back to IMAP_USER if not set.', isRequired: false, format: 'string' },
            { name: 'SMTP_PASSWORD', description: 'SMTP login password. Falls back to IMAP_PASSWORD if not set.', isRequired: false, format: 'password', isSecret: true },
            { name: 'EMAIL_FROM', description: 'Default From address for sending. Falls back to IMAP_USER.', isRequired: false, format: 'string' },
        ],
    ),
    cynosureMcp(
        '@cynosure-mcp/system-notifications',
        'System Notifications',
        'Send local system notifications from MCP tools.',
        'mcp-system-notifications',
        'communication',
    ),
    cynosureMcp(
        '@cynosure-mcp/media-file-converter',
        'Media File Converter',
        'Convert images, audio, and video files between common formats using ffmpeg.',
        'mcp-media-file-converter',
        'media',
    ),
    cynosureMcp(
        '@cynosure-mcp/youtube-video-downloader',
        'YouTube Video Downloader',
        'Download videos from YouTube, Vimeo, and other supported sites using yt-dlp with progress tracking.',
        'mcp-youtube-video-downloader',
        'media',
    ),
    cynosureMcp(
        '@cynosure-mcp/webcam',
        'Webcam',
        'Capture still images from an attached webcam.',
        'mcp-webcam',
        'media',
        [
            {
                name: 'WEBCAM_DEVICE',
                description: 'Default webcam device. Leave empty to auto-detect the first available camera.',
                isRequired: false,
                format: 'string',
            },
            {
                name: 'WEBCAM_OUTPUT_DIR',
                description: 'Directory where captured images are saved. Defaults to a temporary directory.',
                isRequired: false,
                format: 'string',
            },
        ],
    ),
    cynosureMcp(
        '@cynosure-mcp/claude-code-terminal',
        'Claude Code Terminal',
        'Start and control Anthropic Claude Code CLI coding sessions from another agent.',
        'mcp-claude-code-terminal',
        'development',
    ),
    cynosureMcp(
        '@cynosure-mcp/codex-terminal',
        'Codex Terminal',
        'Start and control OpenAI Codex CLI coding sessions from another agent.',
        'mcp-codex-terminal',
        'development',
    ),
]
