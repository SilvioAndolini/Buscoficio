'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { LoginGate } from '../../components/login-gate';

interface ExperienceDto {
  id: string;
  company: string;
  title: string;
  startDate: string;
  endDate: string | null;
  description: string;
}

interface SkillDto {
  id: string;
  skillName: string;
  level: string;
  years: number | null;
}

interface EducationDto {
  id: string;
  institution: string;
  degree: string;
  status: string;
}

interface LanguageDto {
  id: string;
  language: string;
  level: string;
}

interface ProfileDto {
  id: string;
  fullName: string;
  email: string;
  headline: string | null;
  summary: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  relocation: boolean;
  remotePreference: string[];
}

interface ProfileResponse {
  profile: ProfileDto | null;
  experiences: ExperienceDto[];
  skills: SkillDto[];
  educations: EducationDto[];
  languages: LanguageDto[];
}

function ProfileContent(): ReactNode {
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({ fullName: '', email: '', headline: '', locationCity: '' });
  const [remoteOnly, setRemoteOnly] = useState(true);

  const load = useCallback(async () => {
    const response = await api<ProfileResponse>('/v1/profile');
    setData(response);
    if (response.profile) {
      setForm({
        fullName: response.profile.fullName,
        email: response.profile.email,
        headline: response.profile.headline ?? '',
        locationCity: response.profile.locationCity ?? '',
      });
      setRemoteOnly(response.profile.remotePreference.includes('remote'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveProfile(event: FormEvent): Promise<void> {
    event.preventDefault();
    setMessage(null);
    await api('/v1/profile', {
      method: 'PUT',
      body: JSON.stringify({
        ...form,
        headline: form.headline || null,
        locationCity: form.locationCity || null,
        remotePreference: remoteOnly ? ['remote'] : [],
      }),
    });
    setMessage('Perfil guardado');
    await load();
  }

  async function addExperience(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await api('/v1/profile/experiences', {
      method: 'POST',
      body: JSON.stringify({
        company: String(formData.get('company')),
        title: String(formData.get('title')),
        startDate: String(formData.get('startDate')),
        endDate: String(formData.get('endDate')) || null,
        description: String(formData.get('description') ?? ''),
      }),
    });
    event.currentTarget.reset();
    await load();
  }

  async function addSkill(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const years = String(formData.get('years') ?? '');
    await api('/v1/profile/skills', {
      method: 'POST',
      body: JSON.stringify({
        skillName: String(formData.get('skillName')),
        level: String(formData.get('level')),
        years: years === '' ? null : Number(years),
      }),
    });
    event.currentTarget.reset();
    await load();
  }

  async function addEducation(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await api('/v1/profile/educations', {
      method: 'POST',
      body: JSON.stringify({
        institution: String(formData.get('institution')),
        degree: String(formData.get('degree')),
        status: String(formData.get('status')),
      }),
    });
    event.currentTarget.reset();
    await load();
  }

  async function addLanguage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await api('/v1/profile/languages', {
      method: 'POST',
      body: JSON.stringify({
        language: String(formData.get('language')),
        level: String(formData.get('level')),
      }),
    });
    event.currentTarget.reset();
    await load();
  }

  if (!data) return <p>Cargando…</p>;

  return (
    <section>
      <h1>Perfil candidato</h1>
      <form className="card" onSubmit={(event) => void saveProfile(event)}>
        <h2>Datos básicos</h2>
        <div className="grid">
          <label>
            Nombre
            <input
              value={form.fullName}
              onChange={(event) => setForm({ ...form, fullName: event.target.value })}
              required
            />
          </label>
          <label>
            Email
            <input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              required
            />
          </label>
          <label>
            Titular
            <input
              value={form.headline}
              onChange={(event) => setForm({ ...form, headline: event.target.value })}
            />
          </label>
          <label>
            Ciudad
            <input
              value={form.locationCity}
              onChange={(event) => setForm({ ...form, locationCity: event.target.value })}
            />
          </label>
        </div>
        <label>
          <input
            type="checkbox"
            checked={remoteOnly}
            style={{ width: 'auto', display: 'inline-block', marginRight: 8 }}
            onChange={(event) => setRemoteOnly(event.target.checked)}
          />
          Busco principalmente remoto
        </label>
        <button type="submit">Guardar perfil</button>
        {message ? <p className="success">{message}</p> : null}
      </form>

      <div className="card">
        <h2>Experiencia</h2>
        <ul>
          {data.experiences.map((experience) => (
            <li key={experience.id}>
              <strong>{experience.title}</strong> · {experience.company}
            </li>
          ))}
          {data.experiences.length === 0 ? <li className="muted">Sin registros</li> : null}
        </ul>
        <form onSubmit={(event) => void addExperience(event)}>
          <div className="grid">
            <label>
              Empresa
              <input name="company" required />
            </label>
            <label>
              Cargo
              <input name="title" required />
            </label>
            <label>
              Inicio
              <input name="startDate" type="date" required />
            </label>
            <label>
              Fin
              <input name="endDate" type="date" />
            </label>
          </div>
          <label>
            Descripción
            <textarea name="description" rows={2} />
          </label>
          <button type="submit">Añadir experiencia</button>
        </form>
      </div>

      <div className="card">
        <h2>Skills</h2>
        <ul>
          {data.skills.map((skill) => (
            <li key={skill.id}>
              <strong>{skill.skillName}</strong> · {skill.level}
              {skill.years ? ` · ${skill.years} años` : ''}
            </li>
          ))}
          {data.skills.length === 0 ? <li className="muted">Sin registros</li> : null}
        </ul>
        <form onSubmit={(event) => void addSkill(event)}>
          <div className="grid">
            <label>
              Skill
              <input name="skillName" required />
            </label>
            <label>
              Nivel
              <select name="level" defaultValue="intermediate">
                <option value="beginner">beginner</option>
                <option value="intermediate">intermediate</option>
                <option value="advanced">advanced</option>
                <option value="expert">expert</option>
              </select>
            </label>
            <label>
              Años
              <input name="years" type="number" min={0} step={0.5} />
            </label>
          </div>
          <button type="submit">Añadir skill</button>
        </form>
      </div>

      <div className="card">
        <h2>Formación</h2>
        <ul>
          {data.educations.map((education) => (
            <li key={education.id}>
              <strong>{education.degree}</strong> · {education.institution}
            </li>
          ))}
          {data.educations.length === 0 ? <li className="muted">Sin registros</li> : null}
        </ul>
        <form onSubmit={(event) => void addEducation(event)}>
          <div className="grid">
            <label>
              Institución
              <input name="institution" required />
            </label>
            <label>
              Título
              <input name="degree" required />
            </label>
            <label>
              Estado
              <select name="status" defaultValue="completed">
                <option value="completed">completed</option>
                <option value="in_progress">in_progress</option>
                <option value="dropped">dropped</option>
              </select>
            </label>
          </div>
          <button type="submit">Añadir formación</button>
        </form>
      </div>

      <div className="card">
        <h2>Idiomas</h2>
        <ul>
          {data.languages.map((language) => (
            <li key={language.id}>
              <strong>{language.language}</strong> · {language.level}
            </li>
          ))}
          {data.languages.length === 0 ? <li className="muted">Sin registros</li> : null}
        </ul>
        <form onSubmit={(event) => void addLanguage(event)}>
          <div className="grid">
            <label>
              Idioma
              <input name="language" required />
            </label>
            <label>
              Nivel
              <select name="level" defaultValue="B2">
                {['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native'].map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="submit">Añadir idioma</button>
        </form>
      </div>
    </section>
  );
}

export default function ProfilePage(): ReactNode {
  return (
    <LoginGate>
      <ProfileContent />
    </LoginGate>
  );
}