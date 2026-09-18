import { expect, test } from '@playwright/test';

/**
 * UI smoke: the web app only talks to /v1 through the Next.js proxy.
 * The full data pipeline is covered by the API+worker E2E; this suite proves
 * the UI wiring (auth cookie, proxy, pages).
 */
const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-password';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/jobs');
  const passwordInput = page.getByLabel('Contraseña');
  const runButton = page.getByRole('button', { name: 'Ejecutar búsqueda mock' });
  // The gate resolves client-side (Cargando… → login form or content).
  await expect(passwordInput.or(runButton)).toBeVisible({ timeout: 15_000 });
  if (await passwordInput.isVisible()) {
    await passwordInput.fill(PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
  }
  await expect(runButton).toBeVisible();
}

test('manages profile and resume versions from the UI', async ({ page }) => {
  await login(page);

  await page.goto('/profile');
  await page.getByLabel('Nombre').fill('Ada Lovelace');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByRole('button', { name: 'Guardar perfil' }).click();
  await expect(page.getByText('Perfil guardado')).toBeVisible();

  await page.goto('/resumes');
  await page.getByLabel('Nombre').fill('Engineering CV');
  await page.getByRole('button', { name: 'Crear CV' }).click();
  await expect(page.getByRole('heading', { name: /Engineering CV/ })).toBeVisible();

  await page.setInputFiles('input[type="file"]', {
    name: 'cv-v1.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('CV version one'),
  });
  await page.getByRole('button', { name: 'Subir versión inmutable' }).click();
  await expect(page.getByRole('cell', { name: 'v1' })).toBeVisible();
});

test('runs a mock search from the UI and shows canonical jobs', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Ejecutar búsqueda mock' }).click();
  await expect(page.getByText('Búsqueda completada')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('cell', { name: 'Senior React Developer' })).toBeVisible();

  await page
    .getByRole('row', { name: /Senior React Developer/ })
    .getByRole('button', { name: 'Ver' })
    .click();
  await expect(page.getByText(/listing\(s\)/)).toBeVisible();
  await expect(page.getByText(/destino: greenhouse/)).toBeVisible();
});