import { desc, eq } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  sha256Hex,
  type CandidateLanguageInput,
  type CandidateProfileInput,
  type CandidateSkillInput,
  type EducationInput,
  type ExperienceInput,
} from '@job-system/core';
import { uuidv7 } from '@job-system/shared';
import type { Db } from '../client.js';
import * as t from '../schema.js';

function profileHashOf(input: CandidateProfileInput): string {
  return sha256Hex(
    JSON.stringify([
      input.fullName,
      input.email,
      input.headline ?? '',
      input.locationCity ?? '',
      input.locationCountry ?? '',
      input.salaryCurrency ?? '',
      input.salaryMin ?? '',
      input.salaryMax ?? '',
      [...input.remotePreference].sort(),
      [...input.employmentTypes].sort(),
      [...input.allowedCountries].sort(),
    ]),
  );
}

export function createCandidateRepo(db: Db) {
  return {
    async getProfile() {
      const [row] = await db.select().from(t.candidateProfile).orderBy(t.candidateProfile.createdAt).limit(1);
      return row ?? null;
    },

    async upsertProfile(input: CandidateProfileInput) {
      const existing = await this.getProfile();
      const values = {
        fullName: input.fullName,
        email: input.email,
        phone: input.phone ?? null,
        headline: input.headline ?? null,
        summary: input.summary ?? null,
        locationCity: input.locationCity ?? null,
        locationCountry: input.locationCountry ?? null,
        locationTimezone: input.locationTimezone ?? null,
        availabilityDate: input.availabilityDate ?? null,
        salaryMin: input.salaryMin ?? null,
        salaryMax: input.salaryMax ?? null,
        salaryCurrency: input.salaryCurrency ?? null,
        remotePreference: [...input.remotePreference],
        employmentTypes: [...input.employmentTypes],
        allowedCountries: [...input.allowedCountries],
        relocation: input.relocation,
        preferences: input.preferences as Record<string, unknown>,
        profileHash: profileHashOf(input),
        updatedAt: new Date(),
      };
      if (!existing) {
        const [row] = await db
          .insert(t.candidateProfile)
          .values({ id: uuidv7(), ...values })
          .returning();
        return row!;
      }
      const [row] = await db
        .update(t.candidateProfile)
        .set(values)
        .where(eq(t.candidateProfile.id, existing.id))
        .returning();
      return row!;
    },

    async listExperiences() {
      return db.select().from(t.experience).orderBy(desc(t.experience.startDate));
    },

    async addExperience(candidateId: string, input: ExperienceInput) {
      const [row] = await db
        .insert(t.experience)
        .values({
          id: uuidv7(),
          candidateId,
          company: input.company,
          title: input.title,
          startDate: input.startDate,
          endDate: input.endDate ?? null,
          description: input.description,
          location: input.location ?? null,
          skills: [...input.skills],
        })
        .returning();
      return row!;
    },

    async updateExperience(id: string, input: ExperienceInput) {
      const [row] = await db
        .update(t.experience)
        .set({
          company: input.company,
          title: input.title,
          startDate: input.startDate,
          endDate: input.endDate ?? null,
          description: input.description,
          location: input.location ?? null,
          skills: [...input.skills],
        })
        .where(eq(t.experience.id, id))
        .returning();
      if (!row) throw new NotFoundError(`Experience not found: ${id}`);
      return row;
    },

    async deleteExperience(id: string) {
      const rows = await db.delete(t.experience).where(eq(t.experience.id, id)).returning();
      if (rows.length === 0) throw new NotFoundError(`Experience not found: ${id}`);
    },

    async listEducations() {
      return db.select().from(t.education).orderBy(desc(t.education.startDate));
    },

    async addEducation(candidateId: string, input: EducationInput) {
      const [row] = await db
        .insert(t.education)
        .values({
          id: uuidv7(),
          candidateId,
          institution: input.institution,
          degree: input.degree,
          field: input.field ?? null,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          status: input.status,
        })
        .returning();
      return row!;
    },

    async deleteEducation(id: string) {
      const rows = await db.delete(t.education).where(eq(t.education.id, id)).returning();
      if (rows.length === 0) throw new NotFoundError(`Education not found: ${id}`);
    },

    async listSkills() {
      const rows = await db
        .select({
          id: t.candidateSkill.id,
          candidateId: t.candidateSkill.candidateId,
          skillId: t.candidateSkill.skillId,
          skillName: t.skill.canonicalName,
          level: t.candidateSkill.level,
          years: t.candidateSkill.years,
        })
        .from(t.candidateSkill)
        .innerJoin(t.skill, eq(t.candidateSkill.skillId, t.skill.id))
        .orderBy(t.skill.canonicalName);
      return rows.map((row) => ({ ...row, years: row.years === null ? null : Number(row.years) }));
    },

    async addSkill(candidateId: string, input: CandidateSkillInput) {
      return db.transaction(async (tx) => {
        const canonical = input.skillName.trim().replace(/\s+/g, ' ');
        let [existingSkill] = await tx
          .select()
          .from(t.skill)
          .where(eq(t.skill.canonicalName, canonical))
          .limit(1);
        if (!existingSkill) {
          [existingSkill] = await tx
            .insert(t.skill)
            .values({ id: uuidv7(), canonicalName: canonical })
            .returning();
        }
        const years = input.years === undefined || input.years === null ? null : input.years.toFixed(1);
        const [row] = await tx
          .insert(t.candidateSkill)
          .values({
            id: uuidv7(),
            candidateId,
            skillId: existingSkill!.id,
            level: input.level,
            years,
          })
          .onConflictDoUpdate({
            target: [t.candidateSkill.candidateId, t.candidateSkill.skillId],
            set: { level: input.level, years },
          })
          .returning();
        return {
          id: row!.id,
          candidateId: row!.candidateId,
          skillId: row!.skillId,
          skillName: existingSkill!.canonicalName,
          level: row!.level,
          years: row!.years === null ? null : Number(row!.years),
        };
      });
    },

    async deleteSkill(id: string) {
      const rows = await db.delete(t.candidateSkill).where(eq(t.candidateSkill.id, id)).returning();
      if (rows.length === 0) throw new NotFoundError(`Candidate skill not found: ${id}`);
    },

    async listLanguages() {
      return db.select().from(t.candidateLanguage).orderBy(t.candidateLanguage.language);
    },

    async addLanguage(candidateId: string, input: CandidateLanguageInput) {
      const [row] = await db
        .insert(t.candidateLanguage)
        .values({ id: uuidv7(), candidateId, language: input.language, level: input.level })
        .onConflictDoUpdate({
          target: [t.candidateLanguage.candidateId, t.candidateLanguage.language],
          set: { level: input.level },
        })
        .returning();
      return row!;
    },

    async deleteLanguage(id: string) {
      const rows = await db.delete(t.candidateLanguage).where(eq(t.candidateLanguage.id, id)).returning();
      if (rows.length === 0) throw new NotFoundError(`Candidate language not found: ${id}`);
    },

    async requireProfileId(): Promise<string> {
      const profile = await this.getProfile();
      if (!profile) {
        throw new ConflictError('Candidate profile does not exist yet; create it before adding nested data');
      }
      return profile.id;
    },
  };
}

export async function listProfileAggregate(db: Db) {
  const repo = createCandidateRepo(db);
  const [profile, experiences, educations, skills, languages] = await Promise.all([
    repo.getProfile(),
    repo.listExperiences(),
    repo.listEducations(),
    repo.listSkills(),
    repo.listLanguages(),
  ]);
  return { profile, experiences, educations, skills, languages };
}