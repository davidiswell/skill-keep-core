import { diffLines } from 'diff';
import type { Finding, Policy, SkillFile } from '../shared/types';
import type { CleaningChange, FindingEvidence } from './contracts';
import { canonicalJson } from './canonical';
import { normalizeFiles } from './files';
import { scanFiles } from './scanner';

/** Observed changes only. Evidence describes matching review rules, never the editor's presumed intent. */
export function summarizeChanges(before: SkillFile[], after: SkillFile[], findings: Finding[], policy: Policy): CleaningChange[] {
  const oldFiles = new Map(normalizeFiles(before).map(file => [file.path, file]));
  const newFiles = new Map(normalizeFiles(after).map(file => [file.path, file]));
  // Do not trust model-supplied policy citations or stale rule descriptions.
  const observedFindings = [...scanFiles(before, policy).findings, ...findings.filter(finding => finding.source === 'model')];
  const changes: CleaningChange[] = [];
  let excerptBudget = 1_000_000;
  const lineCount = (text: string): number => text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  const emit = (filePath: string, startLine: number, endLine: number, oldText: string, newText: string, kind: CleaningChange['kind'], reason: string): void => {
    const applicable = observedFindings.filter(finding => finding.filePath === filePath && finding.startLine <= endLine && finding.endLine >= startLine && !!finding.excerpt && (oldText.includes(finding.excerpt) || ((kind === 'exclude' || kind === 'remove') && finding.excerpt === filePath)));
    const allEvidence = [...new Map(applicable.filter(finding => finding.source === 'rules').flatMap(finding => finding.evidence || []).map(entry => [canonicalJson(entry), entry])).values()] as FindingEvidence[];
    const evidence = allEvidence.slice(0, 1000);
    const titles = [...new Set(applicable.map(finding => finding.title))].slice(0, 10);
    const limit = Math.max(0, Math.min(8000, Math.floor(excerptBudget / 2)));
    const clipped = oldText.length > limit || newText.length > limit;
    const oldExcerpt = oldText.slice(0, limit), newExcerpt = newText.slice(0, limit);
    excerptBudget -= oldExcerpt.length + newExcerpt.length;
    changes.push({ filePath, startLine, endLine, before: oldExcerpt, after: newExcerpt, kind, evidence,
      reason: reason + (titles.length ? ` Overlapping review findings: ${titles.join('; ')}.` : ' No exact rule match establishes why this change was made.') + (clipped ? ' Excerpts are shortened; compare the complete stored versions.' : '') + (allEvidence.length > evidence.length ? ' Evidence links are shortened; inspect the complete source review.' : '') });
  };
  for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    const oldFile = oldFiles.get(path), newFile = newFiles.get(path);
    const oldText = oldFile?.encoding === 'utf8' ? oldFile.content : '';
    const newText = newFile?.encoding === 'utf8' ? newFile.content : '';
    if (!oldFile) { emit(path, 1, Math.max(1, lineCount(newText)), '', newText, 'add', newFile?.excluded ? 'Added a file that is excluded from export.' : 'Added a package file.'); continue; }
    if (!newFile) { emit(path, 1, Math.max(1, lineCount(oldText)), oldText, '', 'remove', 'Removed this file from the draft.'); continue; }
    if (!!oldFile.excluded !== !!newFile.excluded) {
      emit(path, 1, Math.max(1, lineCount(oldText)), newFile.excluded ? oldText : '', newFile.excluded ? '' : newText, newFile.excluded ? 'exclude' : 'add', newFile.excluded ? 'Excluded this file from export; stored original bytes remain local.' : 'Restored this file to the included package.');
      // If bytes also changed, retain a separate edit record below.
    }
    if (oldFile.sha256 === newFile.sha256 && oldFile.encoding === newFile.encoding) continue;
    if (oldFile.encoding !== 'utf8' || newFile.encoding !== 'utf8') {
      emit(path, 1, 1, '', '', 'edit', 'File bytes or encoding changed. Binary contents are not displayed or cleared by this history.'); continue;
    }
    const diff = diffLines(oldText, newText, { timeout: 30, maxEditLength: 2000 });
    if (!diff || diff.filter(part => part.added || part.removed).length > 32 || changes.length > 1500) {
      emit(path, 1, Math.max(1, lineCount(oldText)), oldText, newText, 'edit', 'File text changed. The detailed diff exceeded the bounded history budget.'); continue;
    }
    let oldLine = 1;
    for (let index = 0; index < diff.length; index++) {
      const part = diff[index];
      if (!part.added && !part.removed) { oldLine += part.count; continue; }
      let removed = '', added = '', removedLines = 0;
      while (index < diff.length && (diff[index].added || diff[index].removed)) {
        const change = diff[index];
        if (change.removed) { removed += change.value; removedLines += change.count; } else added += change.value;
        index++;
      }
      index--;
      emit(path, oldLine, Math.max(oldLine, oldLine + removedLines - 1), removed, added, 'edit', 'Changed this passage. Line numbers refer to the source version.');
      oldLine += removedLines;
    }
  }
  return changes;
}
