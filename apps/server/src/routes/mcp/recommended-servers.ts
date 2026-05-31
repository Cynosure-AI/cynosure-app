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

const CYNOSURE_MCP_REPOSITORY = {
    url: 'https://github.com/andreasjhagen/Cynosure-MCPs',
    source: 'github',
}

function npmServer(
    identifier: string,
    title: string,
    description: string,
    options: {
        packageIdentifier?: string
        environmentVariables?: EnvironmentVariable[]
        arguments?: { value?: string; fromEnv?: string }[]
        repository?: Record<string, string>
        icons?: { src: string; mimeType: string }[]
    } = {},
): RegistryServerEntry {
    return {
        server: {
            name: identifier,
            title,
            description,
            version: 'latest',
            packages: [{
                registryType: 'npm',
                identifier: options.packageIdentifier || identifier,
                version: 'latest',
                transport: { type: 'stdio' },
                ...(options.environmentVariables ? { environmentVariables: options.environmentVariables } : {}),
                ...(options.arguments ? { arguments: options.arguments } : {}),
            }],
            ...(options.repository ? { repository: options.repository } : {}),
            ...(options.icons ? { icons: options.icons } : {}),
        },
    }
}

function cynosureMcp(
    packageName: string,
    title: string,
    description: string,
    subfolder: string,
    environmentVariables?: EnvironmentVariable[],
): RegistryServerEntry {
    return npmServer(packageName, title, description, {
        environmentVariables,
        repository: { ...CYNOSURE_MCP_REPOSITORY, subfolder },
        icons: [{
            src: `https://raw.githubusercontent.com/andreasjhagen/Cynosure-MCPs/main/${subfolder}/icon.png`,
            mimeType: 'image/png',
        }],
    })
}

export const recommendedServers: RegistryServerEntry[] = [
    npmServer(
        '@katomato65/time-mcp',
        'Time MCP',
        'Time and timezone utilities for current time, conversions, and date-aware workflows.',
    ),
    npmServer(
        '@toolsdk.ai/tavily-mcp',
        'Tavily MCP',
        'Web search and extraction powered by Tavily.',
        {
            environmentVariables: [{
                name: 'TAVILY_API_KEY',
                description: 'Tavily API key',
                isRequired: true,
                format: 'password',
                isSecret: true,
            }],
        },
    ),
    cynosureMcp(
        '@cynosure-mcp/clockify',
        'Clockify',
        'Track time with Clockify: manage workspaces, projects, tasks, users, and time entries.',
        'mcp-clockify',
        [
            {
                name: 'CLOCKIFY_API_KEY',
                description: 'Your Clockify API key from Profile Settings > API.',
                isRequired: true,
                format: 'password',
                isSecret: true,
            },
            {
                name: 'CLOCKIFY_BASE_URL',
                description: 'Clockify API base URL. Defaults to https://api.clockify.me/api/v1.',
                isRequired: false,
                format: 'string',
            },
        ],
    ),
    cynosureMcp(
        '@cynosure-mcp/computer-controller',
        'Computer Controller',
        'Control the desktop: launch apps, capture screenshots, move the mouse, type text, and interact with the OS.',
        'mcp-computer-controller',
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
        '@cynosure-mcp/cynosure',
        'Cynosure',
        'Manage Cynosure agents, conversations, memory, providers, MCP servers, and settings.',
        'mcp-cynosure',
        [{
            name: 'CYNOSURE_URL',
            description: 'Base URL of the Cynosure server, for example http://localhost:3000.',
            isRequired: true,
            format: 'string',
        }],
    ),
    cynosureMcp(
        '@cynosure-mcp/defuddle',
        'Defuddle',
        'Extract clean content and metadata from web pages, including YouTube transcripts.',
        'mcp-defuddle',
    ),
    cynosureMcp(
        '@cynosure-mcp/document-parser',
        'Document Parser',
        'Extract text from documents and return it as Markdown.',
        'mcp-document-parser',
    ),
    cynosureMcp(
        '@cynosure-mcp/imap-email',
        'IMAP Email',
        'Read, search, draft, and send email through IMAP and SMTP.',
        'mcp-imap-email',
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
        '@cynosure-mcp/media-file-converter',
        'Media File Converter',
        'Convert images, audio, and video files between common formats using ffmpeg.',
        'mcp-media-file-converter',
    ),
    cynosureMcp(
        '@cynosure-mcp/mermaid-diagrams',
        'Mermaid Diagrams',
        'Render Mermaid.js diagrams such as flowcharts, sequence diagrams, and Gantt charts to images.',
        'mcp-mermaid-diagrams',
        [{
            name: 'MERMAID_OUTPUT_DIR',
            description: 'Directory to save rendered diagrams. Defaults to an OS temp directory.',
            isRequired: false,
            format: 'string',
        }],
    ),
    cynosureMcp(
        '@cynosure-mcp/music-tagger',
        'Music Tagger',
        'Identify and tag music files with AcoustID fingerprinting and MusicBrainz metadata.',
        'mcp-music-tagger',
        [{
            name: 'ACOUSTID_API_KEY',
            description: 'Free API key from https://acoustid.org/api-key. Required for fingerprinting.',
            isRequired: true,
            format: 'password',
            isSecret: true,
        }],
    ),
    cynosureMcp(
        '@cynosure-mcp/nullpointer-file-share',
        'Nullpointer File Share',
        'Upload files to 0x0.st for temporary file sharing.',
        'mcp-nullpointer-file-share',
    ),
    cynosureMcp(
        '@cynosure-mcp/qr-code',
        'QR Code',
        'Generate QR code images and read QR codes from image files.',
        'mcp-qr-code',
        [{
            name: 'QR_CODE_OUTPUT_DIR',
            description: 'Directory where generated QR code images are saved. Defaults to a temporary directory.',
            isRequired: false,
            format: 'string',
        }],
    ),
    cynosureMcp(
        '@cynosure-mcp/stability-ai',
        'Stability AI',
        'Generate, edit, and upscale images with Stability AI.',
        'mcp-stability-ai',
        [
            {
                name: 'STABILITY_API_KEY',
                description: 'Your Stability AI API key from https://platform.stability.ai/account/keys.',
                isRequired: true,
                format: 'password',
                isSecret: true,
            },
            {
                name: 'STABILITY_OUTPUT_DIR',
                description: 'Directory to save generated images. Defaults to an OS temp directory.',
                isRequired: false,
                format: 'string',
            },
        ],
    ),
    cynosureMcp(
        '@cynosure-mcp/system-notifications',
        'System Notifications',
        'Send local system notifications from MCP tools.',
        'mcp-system-notifications',
    ),
    cynosureMcp(
        '@cynosure-mcp/ticknotes',
        'TickNotes',
        'Manage TickNotes workspaces, lists, and tasks through Supabase.',
        'mcp-ticknotes',
        [
            {
                name: 'TICKNOTES_SUPABASE_URL',
                description: 'Your TickNotes Supabase project URL.',
                isRequired: true,
                format: 'string',
            },
            {
                name: 'TICKNOTES_SUPABASE_KEY',
                description: 'Your TickNotes Supabase anonymous/public key.',
                isRequired: true,
                format: 'password',
                isSecret: true,
            },
            {
                name: 'TICKNOTES_EMAIL',
                description: 'Email address for your TickNotes account.',
                isRequired: true,
                format: 'string',
            },
            {
                name: 'TICKNOTES_PASSWORD',
                description: 'Password for your TickNotes account.',
                isRequired: true,
                format: 'password',
                isSecret: true,
            },
        ],
    ),
    cynosureMcp(
        '@cynosure-mcp/weather',
        'Weather',
        'Fetch current weather and forecasts using the free Open-Meteo API.',
        'mcp-weather',
    ),
    cynosureMcp(
        '@cynosure-mcp/webcam',
        'Webcam',
        'Capture still images from an attached webcam.',
        'mcp-webcam',
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
        '@cynosure-mcp/webfetch',
        'Webfetch',
        'Fetch web pages with browser rendering and convert them to clean, LLM-readable Markdown.',
        'mcp-webfetch',
    ),
    cynosureMcp(
        '@cynosure-mcp/youtube-video-downloader',
        'YouTube Video Downloader',
        'Download videos from YouTube, Vimeo, and other supported sites using yt-dlp with progress tracking.',
        'mcp-youtube-video-downloader',
    ),
    npmServer(
        'chrome-devtools-mcp',
        'Chrome DevTools',
        'Control and inspect Chrome tabs for browser automation, screenshots, console output, and page debugging.',
        { packageIdentifier: 'chrome-devtools-mcp@latest' },
    ),
    npmServer(
        '@modelcontextprotocol/server-filesystem',
        'Filesystem',
        'Read and write files within a directory you explicitly allow.',
        {
            environmentVariables: [{
                name: 'DIRECTORY',
                description: 'Directory path to grant this MCP access to',
                isRequired: true,
            }],
            arguments: [{ fromEnv: 'DIRECTORY' }],
        },
    ),
    {
        server: {
            name: 'gmail',
            title: 'Gmail',
            description: 'Read, send, search, and manage Gmail through Smithery.',
            version: 'latest',
            packages: [{
                registryType: 'smithery',
                identifier: 'gmail',
                version: 'latest',
                transport: { type: 'stdio' },
            }],
        },
    },
    {
        server: {
            name: 'github',
            title: 'GitHub',
            description: 'Manage repositories, issues, pull requests, workflows, and other GitHub resources through Smithery.',
            version: 'latest',
            packages: [{
                registryType: 'smithery',
                identifier: 'github',
                version: 'latest',
                transport: { type: 'stdio' },
            }],
        },
    },
]
