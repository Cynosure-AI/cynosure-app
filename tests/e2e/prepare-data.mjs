import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const directory = resolve('.tmp/e2e-data')
await rm(directory, { recursive: true, force: true })
await mkdir(directory, { recursive: true })
