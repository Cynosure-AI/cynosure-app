type OAuthCallbackPageVariant = 'success' | 'error' | 'warning'

type OAuthCallbackPageOptions = {
    title: string
    message: string
    detail?: string
    variant: OAuthCallbackPageVariant
    autoClose?: boolean
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function renderAutoCloseScript(autoClose?: boolean): string {
    if (!autoClose) return ''

    return `
        <script>
            window.setTimeout(function () {
                window.close()
            }, 2200)
        </script>
    `
}

export function renderOAuthCallbackPage(options: OAuthCallbackPageOptions): string {
    const variantClass = `is-${options.variant}`
    const detail = options.detail
        ? `<p class="detail">${escapeHtml(options.detail)}</p>`
        : ''

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.title)} | Cynosure</title>
    <style>
        :root {
            color-scheme: dark;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #0c0f14;
            color: #eef2f7;
        }

        * {
            box-sizing: border-box;
        }

        body {
            min-height: 100vh;
            margin: 0;
            display: grid;
            place-items: center;
            padding: 32px 18px;
            background:
                radial-gradient(circle at top left, rgba(47, 129, 247, 0.16), transparent 34rem),
                linear-gradient(135deg, #0c0f14 0%, #121820 52%, #111417 100%);
        }

        main {
            width: min(100%, 460px);
            padding: 34px;
            border: 1px solid rgba(148, 163, 184, 0.2);
            border-radius: 8px;
            background: rgba(17, 24, 39, 0.84);
            box-shadow: 0 24px 70px rgba(0, 0, 0, 0.38);
            text-align: center;
        }

        .mark {
            width: 56px;
            height: 56px;
            margin: 0 auto 22px;
            display: grid;
            place-items: center;
            border-radius: 999px;
            font-size: 28px;
            font-weight: 800;
        }

        .is-success .mark {
            background: rgba(34, 197, 94, 0.14);
            color: #4ade80;
            border: 1px solid rgba(74, 222, 128, 0.3);
        }

        .is-error .mark,
        .is-warning .mark {
            background: rgba(248, 113, 113, 0.13);
            color: #f87171;
            border: 1px solid rgba(248, 113, 113, 0.28);
        }

        h1 {
            margin: 0;
            font-size: 25px;
            line-height: 1.18;
            letter-spacing: 0;
        }

        .message {
            margin: 14px 0 0;
            color: #cbd5e1;
            font-size: 16px;
            line-height: 1.55;
        }

        .detail {
            margin: 18px 0 0;
            padding: 12px 14px;
            border-radius: 8px;
            background: rgba(15, 23, 42, 0.86);
            color: #94a3b8;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 13px;
            line-height: 1.45;
            overflow-wrap: anywhere;
        }

        .hint {
            margin: 22px 0 0;
            color: #94a3b8;
            font-size: 14px;
            line-height: 1.45;
        }

        @media (max-width: 520px) {
            main {
                padding: 28px 22px;
            }

            h1 {
                font-size: 22px;
            }
        }
    </style>
</head>
<body>
    <main class="${variantClass}">
        <div class="mark" aria-hidden="true">${options.variant === 'success' ? '&#10003;' : '!'}</div>
        <h1>${escapeHtml(options.title)}</h1>
        <p class="message">${escapeHtml(options.message)}</p>
        ${detail}
        <p class="hint">${options.autoClose ? 'This window will try to close automatically.' : 'You can close this window.'}</p>
    </main>
    ${renderAutoCloseScript(options.autoClose)}
</body>
</html>`
}
