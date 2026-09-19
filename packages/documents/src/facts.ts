import type { ProfileFactsSource, ProfileFactsView } from '@job-system/core';
import { normalizeForDedup } from '@job-system/core';

/**
 * PII-minimized facts view (architecture doc 08 §5, task §32). Only data that
 * can back a factual claim travels to documents/AI; email, phone, address and
 * full CV files are deliberately excluded. Salary is opt-in per question.
 */
export function buildProfileFactsView(
  source: ProfileFactsSource,
  options: { includeSalary?: boolean } = {},
): ProfileFactsView {
  const skills = [...source.skills]
    .map((skill) => ({
      ...skill,
      aliases: [...skill.aliases],
      years: skill.years,
    }))
    .sort((a, b) => normalizeForDedup(a.name).localeCompare(normalizeForDedup(b.name)));
  const experiences = [...source.experiences].sort((a, b) =>
    b.startDate.getTime() - a.startDate.getTime(),
  );
  const education = [...source.education].sort((a, b) =>
    normalizeForDedup(a.degree).localeCompare(normalizeForDedup(b.degree)),
  );
  const languages = [...source.languages].sort((a, b) =>
    normalizeForDedup(a.language).localeCompare(normalizeForDedup(b.language)),
  );
  return {
    candidateId: source.profile.id,
    displayName: source.profile.fullName,
    headline: source.profile.headline,
    skills,
    experiences,
    education,
    languages,
    salary:
      options.includeSalary === true
        ? {
            min: source.profile.salaryMin,
            max: source.profile.salaryMax,
            currency: source.profile.salaryCurrency,
          }
        : null,
  };
}
