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

  // Phase 2: per-source breakdown and dedup review sections are visible.
  await expect(page.getByRole('heading', { name: 'Fuentes' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Revisión de duplicados (zona gris)' })).toBeVisible();
  await expect(page.getByText('Sin revisiones pendientes')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'mock' }).first()).toBeVisible();

  await page
    .getByRole('row', { name: /Senior React Developer/ })
    .getByRole('button', { name: 'Ver' })
    .click();
  await expect(page.getByText(/listing\(s\)/)).toBeVisible();
  await expect(page.getByText(/destino: greenhouse/)).toBeVisible();
});

test('ranks matches by score and explains them without an LLM', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);

  await page.goto('/matches');
  await page.getByRole('button', { name: 'Recomputar pendientes' }).click();

  // The worker computes matches; the UI polls until every active job is ranked.
  await expect(page.getByRole('cell', { name: 'Senior React Developer' })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByRole('cell', { name: 'Engineering CV' }).first()).toBeVisible();

  const scoreTexts = await page
    .locator('table tbody tr td:nth-child(2)')
    .allTextContents();
  const scores = scoreTexts
    .map((text) => Number.parseFloat(text.replace('%', '')))
    .filter((value) => !Number.isNaN(value));
  expect(scores.length).toBeGreaterThanOrEqual(2);
  for (let index = 1; index < scores.length; index += 1) {
    expect(scores[index - 1]!).toBeGreaterThanOrEqual(scores[index]!);
  }

  // Expandable breakdown with explicit N/A for absent signals.
  await page
    .getByRole('row', { name: /Senior React Developer/ })
    .getByRole('button', { name: 'Detalle' })
    .click();
  await expect(page.getByRole('heading', { name: 'Desglose del score' })).toBeVisible();
  await expect(page.getByText('N/A').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Razones' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Selección de CV' })).toBeVisible();
});