import type { Category } from '../../../shared/types.ts';

export const CATEGORY_LABEL: Record<Category, string> = {
  compute: 'Compute',
  database: 'Database',
  storage: 'Storage',
  network: 'Networking',
  integration: 'Messaging',
  api: 'API',
  security: 'Security & identity',
  monitoring: 'Monitoring',
  other: 'Other',
};

/** CSS custom property per category; values live in styles.css so both themes can tune them. */
export const categoryVar = (c: Category) => `var(--cat-${c})`;
