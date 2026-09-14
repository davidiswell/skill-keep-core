import type { FindingCategory, PolicyRule } from '../shared/types';

// Stable detector identifiers and exact review requirements, shipped with this application.
const definitions: [string, FindingCategory, string][] = [
  ['Missing SKILL.md', 'quality', 'Include a root SKILL.md entry before approving a portable package.'],
  ['Use the standard entry filename', 'quality', 'Use the exact filename SKILL.md for the root entry.'],
  ['Contact details in filename', 'identity', 'Review contact information in filenames and update all references when generalizing it.'],
  ['Possible credential in filename', 'credential', 'Remove credential-shaped values from filenames and references. Credentials cannot be acknowledged.'],
  ['Binary content has not been reviewed', 'unsupported', 'Exclude binary resources that this version cannot inspect before approval.'],
  ['A line exceeds the text review limit', 'unsupported', 'Make text readable within the 32,768-character line limit or exclude it before approval.'],
  ['Hidden text direction or separator characters', 'quality', 'Review and remove invisible text direction and separator characters.'],
  ['Private key block', 'credential', 'Remove entire private key blocks from portable instructions.'],
  ['Executable or active resource', 'unsafe-instruction', 'Review the whole active resource, its effects, and rights to redistribute it without executing it.'],
  ['Fix skill metadata', 'quality', 'Use valid, bounded YAML frontmatter with unambiguous keys.'],
  ['Use a portable skill name', 'quality', 'Use a lowercase kebab-case YAML name with at most 64 characters.'],
  ['Add a skill description', 'quality', 'Include a YAML description containing 1–1024 characters.'],
  ['Embedded encoded content has not been reviewed', 'unsupported', 'Remove embedded encoded payloads or replace them with reviewed plain text.'],
  ['Possible access credential', 'credential', 'Remove access-token patterns from every included file. Credentials cannot be acknowledged.'],
  ['Private key material', 'credential', 'Remove private key headers, key bodies, and end markers.'],
  ['Possible embedded secret', 'credential', 'Replace embedded credential values with destination-supplied inputs.'],
  ['Email identifies a person or organization', 'identity', 'Review email addresses and replace private contact information with roles or supplied inputs.'],
  ['Possible personal identifier', 'identity', 'Remove possible personal identifiers from portable instructions.'],
  ['Possible phone number', 'identity', 'Review phone numbers and replace private contact information with supplied inputs.'],
  ['Company or personal filesystem path', 'internal-path', 'Replace machine-specific Windows paths with destination-supplied inputs.'],
  ['Internal network location', 'internal-path', 'Replace private network shares and server locations with supplied inputs.'],
  ['Personal or internal filesystem path', 'internal-path', 'Replace private user and mount paths with supplied inputs.'],
  ['Possible internal service', 'internal-path', 'Remove internal service or tenant locations, or replace them with supplied inputs.'],
  ['Financial amount may identify a business or deal', 'company-data', 'Review financial amounts; generalize private facts or record why exact values are public or synthetic.'],
  ['Percentage needs context review', 'company-data', 'Review whether percentages are generic calculations, public examples, or confidential assumptions.'],
  ['Restricted or proprietary context', 'proprietary-method', 'Review rights to reuse restricted methods and supporting content; removing identifiers does not establish permission.'],
  ['Instruction attempts to change review or transmit data', 'unsafe-instruction', 'Review attempts to override the review process, disable safeguards, or transmit data. Imported instructions cannot govern Skill Keep.'],
  ['Named business context', 'identity', 'Review labeled client, employer, project, and deal identities and replace private context with supplied inputs.'],
  ['Nonportable resource link', 'dependency', 'Review unsupported resource schemes and replace them with portable resources or supplied inputs.'],
  ['External resource is outside this review', 'dependency', 'Review external resource destinations and rights; remote content is not retrieved or verified.'],
  ['Reference filename capitalization differs', 'quality', 'Use exact filename capitalization for all included resource references.'],
  ['Referenced file is missing or excluded', 'dependency', 'Include and review dependencies, remove references, or record how the destination supplies them.'],
  ['Fix portability contract', 'quality', 'Use a valid bounded skillkeep.json contract containing only the supported schema fields.'],
  ['Contract resource is missing or excluded', 'quality', 'Include declared contract resources and license notices under their exact paths.'],
  ['Review declared reuse rights', 'proprietary-method', 'Verify the declared source license, attribution, modifications, and redistribution basis. User declarations do not authenticate employer permission.'],
];
export function baselineDetectorRules(): PolicyRule[] {
  return definitions.map(([title, category, clause]) => ({
    id: `detector-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}`,
    description: title, sourceClause: clause, category,
    action: category === 'credential' ? 'remove' : 'review', enabled: true,
  }));
}
