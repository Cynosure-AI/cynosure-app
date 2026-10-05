import { expect, test } from '@playwright/test'

test('a new installation can enter and leave onboarding', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveURL(/\/onboarding$/)
  await expect(page.getByRole('heading', { name: /Welcome to Cynosure/i })).toBeVisible()
  await page.getByRole('button', { name: /^Continue/i }).click()

  await expect(page.getByRole('heading', { name: 'What should Cyno call you?' })).toBeVisible()
  await page.getByPlaceholder('What should we call you?').fill('Ada')
  await page.getByRole('button', { name: /^Continue/i }).click()

  await expect(page.getByRole('heading', { name: 'Connect an AI Provider' })).toBeVisible()
  await expect(page.getByText('Add a provider first')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Continue/i })).toBeDisabled()
  // Steps after the provider step stay out of reach until a provider exists.
  await expect(page.getByRole('button', { name: /First Agent/ })).toBeDisabled()
  // A hosted provider cannot be added without an API key.
  await expect(page.getByRole('button', { name: /^Add Provider/ })).toBeDisabled()

  await page.getByRole('button', { name: /Skip setup/i }).click()
  await expect(page).toHaveURL(/\/chat$/)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cy-onboarding-complete'))).toBe('true')

  const userSettings = await page.request.get('http://127.0.0.1:3199/api/user-settings')
  await expect(userSettings.json()).resolves.toMatchObject({ name: 'Ada' })
})
