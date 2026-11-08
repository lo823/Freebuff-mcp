/**
 * The four skills that ship with AI-FREEBUFF.
 *
 * A "skill" here is a directory of instructions (usually a SKILL.md plus
 * reference material) cloned from a public repository. The loader injects the
 * active skill text into the agent's system prompt, so saying
 * "use the unslop skill" actually changes how the agent writes.
 */

export interface SkillDefinition {
  slug: string;
  name: string;
  /** `owner/repo` on GitHub. */
  repo: string;
  url: string;
  branch: string;
  description: string;
  tags: string[];
  /** Files to look for, in order, when extracting instructions. */
  entryFiles: string[];
}

export const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    slug: 'unslop',
    name: 'Unslop',
    repo: 'heydamir/unslop',
    url: 'https://github.com/heydamir/unslop',
    branch: 'main',
    description: 'Strips AI-sounding prose so writing reads like a human wrote it.',
    tags: ['writing', 'editing', 'tone'],
    entryFiles: ['SKILL.md', 'skill.md', 'README.md'],
  },
  {
    slug: 'ui-ux-pro-max',
    name: 'UI/UX Pro Max',
    repo: 'nextlevelbuilder/ui-ux-pro-max-skill',
    url: 'https://github.com/nextlevelbuilder/ui-ux-pro-max-skill',
    branch: 'main',
    description: 'Design-system level UI/UX guidance: hierarchy, motion, palette, accessibility.',
    tags: ['design', 'ui', 'ux', 'frontend'],
    entryFiles: ['SKILL.md', 'skill.md', 'README.md'],
  },
  {
    slug: 'superpowers',
    name: 'Superpowers',
    repo: 'obra/superpowers',
    url: 'https://github.com/obra/superpowers',
    branch: 'main',
    description: 'Structured planning and execution workflows for long coding tasks.',
    tags: ['workflow', 'planning', 'engineering'],
    entryFiles: ['SKILL.md', 'skill.md', 'README.md'],
  },
  {
    slug: 'openai-skills',
    name: 'OpenAI Skills',
    repo: 'openai/skills',
    url: 'https://github.com/openai/skills',
    branch: 'main',
    description: 'OpenAI’s public skill collection: documents, spreadsheets, slides and more.',
    tags: ['documents', 'spreadsheets', 'slides', 'productivity'],
    entryFiles: ['SKILL.md', 'skill.md', 'README.md'],
  },
];

export const SKILL_ALIASES: Record<string, string> = {
  unslop: 'unslop',
  'un-slop': 'unslop',
  'ui-ux': 'ui-ux-pro-max',
  'uiux': 'ui-ux-pro-max',
  'ui-ux-pro-max-skill': 'ui-ux-pro-max',
  'uipro': 'ui-ux-pro-max',
  superpowers: 'superpowers',
  'super-powers': 'superpowers',
  'openai-skills': 'openai-skills',
  'openai/skills': 'openai-skills',
  openai: 'openai-skills',
  skills: 'openai-skills',
};

export function findBuiltinSkill(input: string): SkillDefinition | undefined {
  const normalized = input.trim().toLowerCase();
  const byAlias = SKILL_ALIASES[normalized];
  if (byAlias) return BUILTIN_SKILLS.find((skill) => skill.slug === byAlias);
  return BUILTIN_SKILLS.find(
    (skill) => skill.slug === normalized || skill.name.toLowerCase() === normalized || skill.url.toLowerCase() === normalized,
  );
}

/** Accepts `owner/repo`, a full GitHub URL, or a skill slug. */
export function resolveSkillDefinition(input: string): SkillDefinition {
  const builtin = findBuiltinSkill(input);
  if (builtin) return builtin;

  const cleaned = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error(`Cannot resolve skill "${input}". Use a slug, owner/repo, or a GitHub URL.`);
  const repo = `${parts[0]}/${parts[1]}`;
  const slug = parts[1].toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return {
    slug,
    name: parts[1],
    repo,
    url: `https://github.com/${repo}`,
    branch: 'main',
    description: `Custom skill from ${repo}`,
    tags: ['custom'],
    entryFiles: ['SKILL.md', 'skill.md', 'README.md'],
  };
}
