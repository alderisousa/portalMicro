import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import packageJson from './package.json' with { type: 'json' }

function getBuildCommit() {
  const vercelCommit = process.env.VERCEL_GIT_COMMIT_SHA?.trim()
  if (vercelCommit && /^[0-9a-f]{7,40}$/i.test(vercelCommit)) return vercelCommit.slice(0, 7)

  try {
    const localCommit = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return /^[0-9a-f]{7}$/i.test(localCommit) ? localCommit : ''
  } catch {
    return ''
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __BUILD_COMMIT__: JSON.stringify(getBuildCommit()),
  },
})
