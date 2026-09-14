import AdmZip from 'adm-zip';
import type { BenchmarkCheck, EvaluatedWorkbook, FinancialFixture, Target, WorkbookCell, WorkbookPlan } from './types';
import { parseWorkbookPlan } from './protocol';

const equals = (a: number, b: number) => Math.abs(a - b) < 0.000001;
export function evaluateWorkbookPlan(raw: WorkbookPlan, fixture: FinancialFixture): { checks: BenchmarkCheck[]; workbook: EvaluatedWorkbook } {
  const plan = parseWorkbookPlan({ requestId: raw.requestId, fixtureId: fixture.id }, JSON.stringify(raw), 'stop');
  const amounts = {} as Record<Target, [number, number]>;
  for (const mapping of plan.mappings) {
    const values = fixture.statements.map(statement => statement.lines.find(line => line.accountKey === mapping.accountKey)!.amount * plan.unitMultiplier);
    const income = ['revenue', 'cost', 'operating_expense', 'depreciation'].includes(mapping.target);
    amounts[mapping.target] = [values[0], income && plan.incomeBasis === 'monthly-from-ytd' ? values[1] - values[0] : values[1]];
  }
  const ebitda = [0, 1].map(index => amounts.revenue[index] - amounts.cost[index] - (plan.ebitdaFormula === 'revenue-cost' ? 0 : amounts.operating_expense[index]) - (plan.ebitdaFormula.endsWith('-depreciation') ? amounts.depreciation[index] : 0));
  const balance = [0, 1].map(index => plan.balanceFormula === 'none' ? 0 : amounts.assets[index] - amounts.liabilities[index] - (plan.balanceFormula === 'assets-liabilities-equity' ? amounts.equity[index] : 0));
  const expected = fixture.expected;
  const expectedEbitda = [0, 1].map(index => expected.revenue[index] - expected.cost[index] - expected.operating_expense[index]);
  const expectedBalance = [0, 1].map(index => expected.assets[index] - expected.liabilities[index] - expected.equity[index]);
  const check = (id: string, label: string, passed: boolean, detail: string): BenchmarkCheck => ({ id, label, passed, detail });
  const exact = (target: Target) => amounts[target].every((value, index) => equals(value, expected[target][index]));
  const checks = [
    check('stable-mapping', 'Stable account mapping despite renamed labels', plan.mappings.every(item => fixture.mapping.some(expected => expected.accountKey === item.accountKey && expected.target === item.target)), 'Mappings are compared with the fixture chart of accounts; display labels change between periods.'),
    check('units', 'Source units converted to USD', plan.unitMultiplier === (fixture.units === 'USD thousands' ? 1000 : 1), 'The multiplier is checked against the source unit declaration.'),
    check('monthly-income', 'Monthly values derived from cumulative income statements', (['revenue', 'cost', 'operating_expense', 'depreciation'] as Target[]).every(exact), 'All eight rendered income values must match independently calculated monthly amounts.'),
    check('ending-balances', 'Balance sheet retains ending balances', (['assets', 'liabilities', 'equity'] as Target[]).every(exact), 'Balance sheet values must remain period-end amounts rather than monthly differences.'),
    check('date-cells', 'Period headers use actual spreadsheet dates', plan.periodHeaders === 'excel-dates', 'Headers are rendered as numeric Excel date serials with a date format.'),
    check('ebitda', 'EBITDA formula and values are correct', plan.ebitdaFormula === 'revenue-cost-operating_expense' && ebitda.every((value, index) => equals(value, expectedEbitda[index])), 'Trusted arithmetic checks both cached values and the selected cell-reference formula; depreciation is excluded.'),
    check('reconciliation', 'Balance reconciliation formula preserves the source difference', plan.balanceFormula === 'assets-liabilities-equity' && balance.every((value, index) => equals(value, expectedBalance[index])), 'Both reconciliation values and the assets-minus-liabilities-minus-equity formula must be correct.'),
    check('imbalance-flag', 'Source imbalances are flagged', plan.flagImbalance && balance.every((value, index) => (!equals(value, 0)) === (!equals(expectedBalance[index], 0))), 'The unbalanced fixture must report its nonzero difference rather than hide it.'),
  ];
  const dateCell = (date: string): WorkbookCell => plan.periodHeaders === 'excel-dates' ? { value: Math.round((Date.parse(date + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000), format: 'date' } : { value: date };
  const row = (label: string, values: readonly number[]): WorkbookCell[] => [{ value: label }, ...values.map(value => ({ value, format: 'currency' as const }))];
  const formulaRow = (label: string, values: readonly number[], makeFormula: (column: string) => string): WorkbookCell[] => [{ value: label }, ...values.map((value, index) => ({ value, formula: makeFormula(index === 0 ? 'B' : 'C'), format: 'currency' as const }))];
  const workbook: EvaluatedWorkbook = { name: 'Synthetic financials', rows: [
    [{ value: 'Account' }, ...fixture.periods.map(dateCell)], row('Revenue', amounts.revenue), row('Cost', amounts.cost), row('Operating expense', amounts.operating_expense), row('Depreciation', amounts.depreciation),
    formulaRow('EBITDA', ebitda, column => `${column}2-${column}3${plan.ebitdaFormula === 'revenue-cost' ? '' : `-${column}4`}${plan.ebitdaFormula.endsWith('-depreciation') ? `-${column}5` : ''}`),
    row('Assets', amounts.assets), row('Liabilities', amounts.liabilities), row('Equity', amounts.equity),
    ...(plan.balanceFormula === 'none' ? [row('Balance difference', balance)] : [formulaRow('Balance difference', balance, column => `${column}7-${column}8${plan.balanceFormula === 'assets-liabilities-equity' ? `-${column}9` : ''}`)]),
    row('Imbalance flagged', balance.map(value => plan.flagImbalance && !equals(value, 0) ? 1 : 0)),
  ] };
  return { checks, workbook };
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
/** App-owned minimal XLSX renderer. Only bounded local cell-reference subtraction formulas are accepted. */
export function renderWorkbookXlsx(workbook: EvaluatedWorkbook): Buffer {
  if (workbook.rows.length > 30 || workbook.rows.some(row => row.length > 3)) throw new Error('Unexpected benchmark workbook dimensions.');
  const rows = workbook.rows.map((row, index) => `<row r="${index + 1}">${row.map((cell, column) => {
    const address = `${String.fromCharCode(65 + column)}${index + 1}`;
    if (cell.formula && !/^[BC][2-9](?:-[BC][2-9]){1,3}$/.test(cell.formula)) throw new Error('Only trusted benchmark arithmetic formulas can be rendered.');
    if (typeof cell.value === 'number') {
      if (!Number.isFinite(cell.value)) throw new Error('Nonfinite workbook value.');
      return `<c r="${address}" s="${cell.format === 'date' ? 1 : cell.format === 'currency' ? 2 : 0}">${cell.formula ? `<f>${xml(cell.formula)}</f>` : ''}<v>${cell.value}</v></c>`;
    }
    if (cell.value.length > 200 || cell.formula) throw new Error('Unexpected benchmark cell text.');
    return `<c r="${address}" t="inlineStr"><is><t>${xml(cell.value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const zip = new AdmZip();
  const add = (name: string, text: string) => zip.addFile(name, Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${text}`));
  add('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
  add('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  add('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Synthetic financials" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>');
  add('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  add('xl/styles.xml', '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>');
  add('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="26" customWidth="1"/><col min="2" max="3" width="19" customWidth="1"/></cols><sheetData>${rows}</sheetData></worksheet>`);
  return zip.toBuffer();
}
