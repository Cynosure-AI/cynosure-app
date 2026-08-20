import { expect, test } from '@playwright/test'

test('a new installation can enter and leave onboarding', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveURL(/\/onboarding$/)
  await expect(page.getByRole('heading', { name: /Welcome to Cynosure/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /Continue/i })).toBeDisabled()

  await page.getByLabel('What should we call you?').fill('Ada')
  await expect(page.getByRole('button', { name: /Continue/i })).toBeEnabled()

  await page.getByRole('button', { name: /Continue/i }).click()
  await expect(page.getByRole('heading', { name: 'Connect an AI Provider' })).toBeVisible()
  await expect(page.getByText('Add a provider first')).toBeVisible()

  await page.getByRole('button', { name: /Skip setup/i }).click()
  await expect(page).toHaveURL(/\/triggers\/chat$/)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cy-onboarding-complete'))).toBe('true')

  const userSettings = await page.request.get('http://127.0.0.1:3199/api/user-settings')
  await expect(userSettings.json()).resolves.toEqual({ name: 'Ada' })
})
