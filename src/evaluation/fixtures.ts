import { createHash } from 'node:crypto';
import { fileFromBytes } from '../core';
import type { FinancialFixture, Target } from './types';

export const SUITE_ID = 'financial-workbook-v1';
// Bump whenever prompts, plan interpretation, scoring or rendering semantics change.
export const BENCHMARK_ENGINE_VERSION = 'financial-workbook-engine-v1';
const targets: Target[] = ['revenue', 'cost', 'operating_expense', 'depreciation', 'assets', 'liabilities', 'equity'];
const keys = ['I10', 'I20', 'I30', 'I40', 'B10', 'B20', 'B30'];
const mapping = keys.map((accountKey, index) => ({ accountKey, target: targets[index] }));
function fixture(id: string, name: string, units: FinancialFixture['units'], dates: [string, string], values: [number[], number[]]): FinancialFixture {
  const scale = units === 'USD thousands' ? 1000 : 1;
  const expected = Object.fromEntries(targets.map((target, index) => [target, [values[0][index] * scale, (index < 4 ? values[1][index] - values[0][index] : values[1][index]) * scale]])) as FinancialFixture['expected'];
  return { id, name, units, periods: dates, mapping, expected,
    statements: values.map((amounts, period) => ({ date: dates[period], basis: 'year-to-date' as const,
      lines: keys.map((accountKey, index) => ({ accountKey, displayLabel: period === 0 ? targets[index] : targets[(index + 1) % targets.length], amount: amounts[index] })) })),
  };
}
// All entities, account keys and financial amounts in this suite are synthetic.
export const FINANCIAL_FIXTURES: readonly FinancialFixture[] = [
  fixture('monthly-thousands', 'Synthetic monthly financial statements', 'USD thousands', ['2025-01-31', '2025-02-28'], [[120, 45, 20, 5, 500, 300, 200], [275, 101, 44, 11, 540, 310, 230]]),
  fixture('monthly-unbalanced', 'Synthetic imbalance and changed labels', 'USD', ['2024-01-31', '2024-02-29'], [[91000, 32000, 17000, 3000, 440000, 250000, 190000], [200000, 77000, 39000, 6500, 470000, 265000, 204500]]),
];
export const fixtureHash = (fixture: FinancialFixture): string => createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
export const SUITE_HASH = createHash('sha256').update(JSON.stringify({ engineVersion: BENCHMARK_ENGINE_VERSION, fixtures: FINANCIAL_FIXTURES })).digest('hex');
export function getFixture(id: string): FinancialFixture {
  const fixture = FINANCIAL_FIXTURES.find(item => item.id === id);
  if (!fixture) throw new Error('Unknown synthetic benchmark fixture.');
  return fixture;
}
export function fixtureInput(fixture: FinancialFixture) {
  // Never put expected answers in the model prompt.
  return { id: fixture.id, periods: fixture.periods, units: fixture.units, mapping: fixture.mapping, statements: fixture.statements };
}
export function syntheticSkillPair() {
  const procedure = `---\nname: financial-workbook\ndescription: Turn financial statements into a monthly workbook with formulas and checks.\n---\nUse stable account keys and the supplied mapping table, never display labels. Convert year-to-date income accounts to monthly values by subtracting the prior period; January equals January year-to-date. Keep balance sheet accounts as ending balances. Convert source units to dollars. Use real Excel date cells for period headers. Calculate EBITDA as revenue minus cost minus operating expense, excluding depreciation. Keep a formula for assets minus liabilities minus equity and flag nonzero differences; never force an imbalance to zero.\n`;
  const privateExample = '\nExample for fictional Meridian Sample Group, Project Paper Kite: source contact reviewer@meridian-sample.invalid; internal folder C:\\MeridianSample\\Private\\packet.\n';
  return { originalFiles: [fileFromBytes('SKILL.md', Buffer.from(procedure + privateExample))], cleanedFiles: [fileFromBytes('SKILL.md', Buffer.from(procedure + '\nAccept the client, contact and source folder as user-provided inputs.\n'))] };
}
