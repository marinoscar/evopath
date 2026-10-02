import { Workbook } from 'exceljs';
import JSZip from 'jszip';

import { datasetColumns } from '../health-export-data';
import { appSlug, healthExportFileName, HEALTH_EXPORT_SCHEMA_VERSION } from '../health-export.constants';
import { exportFixture, FIXTURE_AT_FILE_NAME, FIXTURE_FORMULA_NOTE } from '../testing/export-fixture';
import { pdfPageCount, pdfText } from '../testing/pdf-text';
import { streamToBuffer } from '../testing/stream-to-buffer';
import { csvZipExportStream, tableToCsv } from './csv.writer';
import { renderHealthExport } from './index';
import { healthExportJsonFileSchema, jsonExportStream } from './json.writer';
import { PDF_FOOTER_TEXT, PDF_LAB_UNITS_LINE, PDF_SECTIONS, pdfExportStream, pdfSafe } from './pdf.writer';
import { sheetName, xlsxExportStream } from './xlsx.writer';

/** A strict RFC 4180 reader: quoted fields, doubled quotes, CRLF records. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      if (field !== '') throw new Error(`quote inside an unquoted field at ${i}`);
      quoted = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] !== '\n') throw new Error(`bare CR at ${i}`);
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += 1;
    } else if (ch === '\n') {
      throw new Error(`bare LF at ${i}`);
    } else {
      field += ch;
    }
  }

  if (quoted) throw new Error('unterminated quote');
  if (field !== '' || record.length > 0) throw new Error('last record has no CRLF');
  return records;
}

describe('health export writers', () => {
  describe('JSON', () => {
    it('is valid against the version 1 file schema', async () => {
      const buffer = await streamToBuffer(jsonExportStream(exportFixture()));
      const parsed = JSON.parse(buffer.toString('utf8'));

      expect(healthExportJsonFileSchema.parse(parsed)).toBeTruthy();
      expect(parsed.schemaVersion).toBe(HEALTH_EXPORT_SCHEMA_VERSION);
      expect(parsed.exportedAt).toBe('2026-09-30T12:00:00.000Z');
      expect(parsed.range).toEqual({ from: '2026-09-01', to: '2026-09-30' });
      expect(parsed.profile).toMatchObject({ dateOfBirth: '1990-05-01', ageYears: 36, sexAtBirth: 'female' });
      expect(Object.keys(parsed.datasets)).toEqual(['body', 'vitals', 'labs', 'wellness', 'documents', 'progress_photos', 'memories']);
      // Memories (#325): the active facts, metadata only: id, category, text, source, date added.
      expect(parsed.datasets.memories[0]).toEqual({
        id: '00000000-0000-4000-8000-000000000008',
        category: 'preference',
        content: 'User prefers to be called Bobby.',
        source: 'explicit',
        created_at: '2026-09-15T08:00:00.000Z',
      });
      // Progress photos are an index: day, pose, note, type, size. Never the image or its storage id.
      expect(parsed.datasets.progress_photos[0]).toEqual({
        id: '00000000-0000-4000-8000-000000000007',
        date: '2026-09-14',
        pose: 'front',
        note: 'Morning, fasted',
        mime_type: 'image/jpeg',
        size_bytes: 345678,
        added_at: '2026-09-14T07:30:00.000Z',
      });
      expect(parsed.datasets.body[0]).toMatchObject({ weight_kg: 70.2, notes: FIXTURE_FORMULA_NOTE });
      expect(parsed.datasets.labs[1].value).toBe(-5);
    });

    it('holds only the selected datasets, and a null profile without the profile dataset', async () => {
      const buffer = await streamToBuffer(jsonExportStream(exportFixture(['labs'])));
      const parsed = healthExportJsonFileSchema.parse(JSON.parse(buffer.toString('utf8')));

      expect(parsed.profile).toBeNull();
      expect(Object.keys(parsed.datasets)).toEqual(['labs']);
    });

    it('is still valid with no rows at all', async () => {
      const data = exportFixture(['body']);
      data.tables[0].rows = [];
      const parsed = JSON.parse((await streamToBuffer(jsonExportStream(data))).toString('utf8'));

      expect(healthExportJsonFileSchema.safeParse(parsed).success).toBe(true);
      expect(parsed.datasets).toEqual({ body: [] });
    });
  });

  describe('CSV zip', () => {
    it('holds one RFC 4180 file per selected dataset, BOM first, header of column keys', async () => {
      const zip = await JSZip.loadAsync(await streamToBuffer(csvZipExportStream(exportFixture())));

      expect(Object.keys(zip.files).sort()).toEqual(
        ['body.csv', 'documents.csv', 'labs.csv', 'memories.csv', 'profile.csv', 'progress_photos.csv', 'vitals.csv', 'wellness.csv'].sort(),
      );

      for (const dataset of ['profile', 'body', 'vitals', 'labs', 'wellness', 'documents', 'progress_photos', 'memories'] as const) {
        const bytes = await zip.file(`${dataset}.csv`)!.async('nodebuffer');
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

        const records = parseCsv(bytes.toString('utf8').slice(1));
        expect(records[0]).toEqual(datasetColumns(dataset).map((column) => column.key));
        for (const record of records) expect(record).toHaveLength(records[0].length);
      }
    });

    it('neutralises text cells a spreadsheet would read as a formula, never numbers', async () => {
      const data = exportFixture();
      const body = parseCsv(tableToCsv(data.tables.find((t) => t.dataset === 'body')!).slice(1));
      const labs = parseCsv(tableToCsv(data.tables.find((t) => t.dataset === 'labs')!).slice(1));
      const documents = parseCsv(tableToCsv(data.tables.find((t) => t.dataset === 'documents')!).slice(1));
      const col = (records: string[][], key: string) => records[0].indexOf(key);

      expect(body[1][col(body, 'notes')]).toBe(`'${FIXTURE_FORMULA_NOTE}`);
      expect(body[2][col(body, 'notes')]).toBe("'-not a number");
      expect(labs[1][col(labs, 'notes')]).toBe("'+1 vs last year");
      expect(documents[1][col(documents, 'original_name')]).toBe(`'${FIXTURE_AT_FILE_NAME}`);
      // A numeric column keeps its sign.
      expect(labs[2][col(labs, 'value')]).toBe('-5');
      // Null is an empty field.
      expect(body[1][col(body, 'waist_circumference_cm')]).toBe('');
    });

    it('neutralises a tab or CR at the start of a text cell', () => {
      const data = exportFixture(['wellness']);
      data.tables[0].rows = [{ ...data.tables[0].rows[0], note: '\tcmd' }, { ...data.tables[0].rows[0], note: '\rcmd' }];
      const records = parseCsv(tableToCsv(data.tables[0]).slice(1));
      const note = records[0].indexOf('note');

      expect(records[1][note]).toBe("'\tcmd");
      expect(records[2][note]).toBe("'\rcmd");
    });

    it('quotes a field holding a quote and a comma, and reads it back intact', async () => {
      const zip = await JSZip.loadAsync(await streamToBuffer(csvZipExportStream(exportFixture(['profile']))));
      const text = (await zip.file('profile.csv')!.async('string')).replace(/^﻿/, '');

      expect(text).toContain('"Ana ""Doc"", Pérez"');
      expect(parseCsv(text)[1][0]).toBe('Ana "Doc", Pérez');
    });
  });

  describe('XLSX', () => {
    it('re-opens with one sheet per dataset, a bold frozen header with units', async () => {
      const workbook = new Workbook();
      await workbook.xlsx.load((await streamToBuffer(xlsxExportStream(exportFixture()))) as never);

      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
        'Profile',
        'Body',
        'Vitals',
        'Labs',
        'Wellness - mood',
        'Documents',
        'Progress photos',
        'Memories',
      ]);

      const body = workbook.getWorksheet('Body')!;
      const header = (body.getRow(1).values as unknown[]).slice(1);
      expect(header).toEqual(datasetColumns('body').map((column) => column.header));
      expect(header).toEqual(expect.arrayContaining(['Weight (kg)', 'Body fat (%)', 'Waist (cm)']));
      expect(body.getRow(1).font?.bold).toBe(true);
      expect(body.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
      expect(body.getRow(2).getCell(2).value).toBe(70.2);
      // A string cell is text, never a formula.
      const notesCol = datasetColumns('body').findIndex((c) => c.key === 'notes') + 1;
      expect(body.getRow(2).getCell(notesCol).value).toBe(FIXTURE_FORMULA_NOTE);
      expect(body.getRow(2).getCell(notesCol).type).not.toBe(6 /* ValueType.Formula */);

      const vitals = (workbook.getWorksheet('Vitals')!.getRow(1).values as unknown[]).slice(1);
      expect(vitals).toEqual(expect.arrayContaining(['Systolic pressure (mmHg)', 'Resting heart rate (bpm)']));
      const wellness = (workbook.getWorksheet('Wellness - mood')!.getRow(1).values as unknown[]).slice(1);
      expect(wellness).toEqual(expect.arrayContaining(['Energy (1-5)']));
    });

    it('makes a legal sheet name out of any title', () => {
      expect(sheetName('Wellness / mood')).toBe('Wellness - mood');
      expect(sheetName('a'.repeat(40))).toHaveLength(31);
    });
  });

  describe('PDF', () => {
    it('carries the expected sections, values and the footer on every page', async () => {
      const pdf = await streamToBuffer(pdfExportStream(exportFixture(), { compress: false }));
      const text = pdfText(pdf);

      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(text).toContain('Name: Ana "Doc", Pérez');
      expect(text).toContain('Age: 36');
      expect(text).toContain('Sex at birth: Female');
      expect(text).toContain('Period: 2026-09-01 to 2026-09-30');
      for (const heading of Object.values(PDF_SECTIONS)) expect(text).toContain(heading);
      expect(text).toContain('Lipids');
      expect(text).toContain('LDL cholesterol');
      expect(text).toContain('<100');
      expect(text).toContain('High');
      expect(text).toContain('Glycemic');
      expect(text).toContain('Weight (kg)');
      expect(text).toContain('69.4');
      expect(text).toContain('Energy');
      expect(text).toContain(FIXTURE_AT_FILE_NAME);
      expect(text).toContain('Morning, fasted');

      const pages = pdfPageCount(pdf);
      expect(pages).toBeGreaterThanOrEqual(1);
      expect(text.split(PDF_FOOTER_TEXT).length - 1).toBe(pages);
      expect(PDF_FOOTER_TEXT).toMatch(/^Generated by .+ from user-entered and AI-extracted data\. Not a medical record\.$/);
    });

    it('repeats the footer on every page of a long report', async () => {
      const data = exportFixture(['documents']);
      data.tables[0].rows = Array.from({ length: 120 }, (_, i) => ({ ...data.tables[0].rows[0], original_name: `report-${i}.pdf` }));
      const pdf = await streamToBuffer(pdfExportStream(data, { compress: false }));
      const pages = pdfPageCount(pdf);

      expect(pages).toBeGreaterThan(1);
      expect(pdfText(pdf).split(PDF_FOOTER_TEXT).length - 1).toBe(pages);
      expect(pdfText(pdf)).toContain(`Page ${pages} of ${pages}`);
    });

    it('omits age and sex without the profile dataset, and sections of unselected datasets', async () => {
      const text = pdfText(await streamToBuffer(pdfExportStream(exportFixture(['wellness']), { compress: false })));

      expect(text).not.toContain('Age:');
      expect(text).not.toContain(PDF_SECTIONS.labs);
      expect(text).toContain(PDF_SECTIONS.wellness);
      expect(text).toContain('3.0'); // 7-day average energy (one check-in: 4) / sleep 3
    });

    it('prints characters outside the font as ?', () => {
      expect(pdfSafe('Ana Pérez 李')).toBe('Ana Pérez ?');
    });
  });

  it('renders every format through one entry point', async () => {
    for (const format of ['json', 'csv', 'xlsx', 'pdf'] as const) {
      const buffer = await streamToBuffer(renderHealthExport(exportFixture(), format));
      expect(buffer.length).toBeGreaterThan(100);
    }
  });

  it('names the download after the app and the range', () => {
    expect(appSlug('EvoPath')).toBe('evopath');
    expect(appSlug('My  App!')).toBe('my-app');
    expect(appSlug('!!!')).toBe('app');
    expect(healthExportFileName('2026-01-01', '2026-09-30', 'csv')).toBe(`${appSlug()}-health-2026-01-01-2026-09-30.zip`);
    expect(healthExportFileName('2026-01-01', '2026-09-30', 'pdf')).toMatch(/^[a-z0-9-]+-health-2026-01-01-2026-09-30\.pdf$/);
  });

  describe('lab units (#234)', () => {
    const col = (records: string[][], key: string) => records[0].indexOf(key);

    it('JSON: carries labUnits at the top level, schemaVersion unchanged, lab rows in that unit', async () => {
      const conventional = healthExportJsonFileSchema.parse(
        JSON.parse((await streamToBuffer(jsonExportStream(exportFixture(['labs'])))).toString('utf8')),
      );
      const si = healthExportJsonFileSchema.parse(
        JSON.parse((await streamToBuffer(jsonExportStream(exportFixture(['labs'], { labUnits: 'si' })))).toString('utf8')),
      );

      expect(conventional.schemaVersion).toBe(1);
      expect(si.schemaVersion).toBe(1);
      expect(conventional.labUnits).toBe('conventional');
      expect(si.labUnits).toBe('si');
      expect(conventional.datasets.labs![0]).toMatchObject({ value: 124, unit: 'mg/dL', reference_high: 100 });
      // LDL 124 mg/dL = 3.21 mmol/L; the 100 mg/dL limit = 2.59 mmol/L.
      expect(si.datasets.labs![0]).toMatchObject({
        analyte_key: 'ldl_cholesterol',
        value: 3.21,
        unit: 'mmol/L',
        reference_low: null,
        reference_high: 2.59,
        reference_text: '<100',
      });
      expect(si.datasets.labs![1]).toMatchObject({ analyte_key: 'hba1c', unit: 'mmol/mol', reference_low: 20, reference_high: 38 });
    });

    it('CSV: the labs file names the unit used on each row', async () => {
      for (const [labUnits, value, unit] of [
        ['conventional', '124', 'mg/dL'],
        ['si', '3.21', 'mmol/L'],
      ] as const) {
        const zip = await JSZip.loadAsync(await streamToBuffer(csvZipExportStream(exportFixture(['labs'], { labUnits }))));
        const records = parseCsv((await zip.file('labs.csv')!.async('string')).replace(/^\uFEFF/, ''));

        expect(records[1][col(records, 'analyte_key')]).toBe('ldl_cholesterol');
        expect(records[1][col(records, 'value')]).toBe(value);
        expect(records[1][col(records, 'unit')]).toBe(unit);
      }
    });

    it('XLSX: the Labs sheet holds the converted number and its unit', async () => {
      for (const [labUnits, value, unit] of [
        ['conventional', 124, 'mg/dL'],
        ['si', 3.21, 'mmol/L'],
      ] as const) {
        const workbook = new Workbook();
        await workbook.xlsx.load((await streamToBuffer(xlsxExportStream(exportFixture(['labs'], { labUnits })))) as never);
        const sheet = workbook.getWorksheet('Labs')!;
        const index = (key: string) => datasetColumns('labs').findIndex((c) => c.key === key) + 1;

        expect(sheet.getRow(2).getCell(index('value')).value).toBe(value);
        expect(sheet.getRow(2).getCell(index('unit')).value).toBe(unit);
      }
    });

    it('PDF: prints converted values and ranges, and names the lab units in the header', async () => {
      const conventional = pdfText(await streamToBuffer(pdfExportStream(exportFixture(['labs']), { compress: false })));
      const si = pdfText(
        await streamToBuffer(pdfExportStream(exportFixture(['labs'], { labUnits: 'si' }), { compress: false })),
      );

      expect(conventional).toContain(PDF_LAB_UNITS_LINE.conventional);
      expect(PDF_LAB_UNITS_LINE.conventional).toBe('Lab units: US conventional');
      expect(conventional).toContain('124');
      expect(conventional).toContain('mg/dL');
      expect(conventional).not.toContain('mmol/L');

      expect(si).toContain('Lab units: SI');
      expect(si).toContain('3.21');
      expect(si).toContain('mmol/L');
      expect(si).toContain('mmol/mol');
      expect(si).toContain('20 - 38'); // HbA1c 4-5.6 % as mmol/mol
      expect(si).not.toContain('mg/dL');
    });

    it('PDF: no lab-units line without the labs dataset', async () => {
      const text = pdfText(await streamToBuffer(pdfExportStream(exportFixture(['body']), { compress: false })));
      expect(text).not.toContain('Lab units:');
    });
  });
});
