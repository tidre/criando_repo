#!/usr/bin/env node
/**
 * validate_backlog.js
 * Uso: node validate_backlog.js <pasta> [--recursive]
 * Gera backlog_report.json
 */
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const readline = require('readline');

const LAYOUT_PATH = path.join(__dirname, 'layout_blocos.json');
if (!fs.existsSync(LAYOUT_PATH)) {
  console.error('layout_blocos.json não encontrado em', LAYOUT_PATH);
  process.exit(1);
}
const layoutRaw = fs.readFileSync(LAYOUT_PATH, 'latin1');
let layout;
try { layout = JSON.parse(layoutRaw); } catch (e) {
  console.error('Erro ao parsear layout:', e.message);
  process.exit(1);
}

async function validateOneSpedFile(filePath) {
  const blockOccurrences = {};
  const missingBlocks = new Set();
  const fieldDiscrepancies = {};

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'latin1' }),
    crlfDelay: Infinity,
  });

  let lineNum = 0;
  for await (const lineRaw of rl) {
    lineNum++;
    const line = lineRaw;
    if (!line.trim().startsWith('|')) continue;
    const partes = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    const reg = partes[0];
    blockOccurrences[reg] = (blockOccurrences[reg] || 0) + 1;
    const actualFields = partes.length - 1;
    const expectedDef = layout[reg];
    if (!expectedDef) {
      missingBlocks.add(reg);
      continue;
    }
    const expectedFields = expectedDef.length - 1;
    if (actualFields !== expectedFields) {
      if (!fieldDiscrepancies[reg]) {
        fieldDiscrepancies[reg] = { expected: expectedFields, occurrences: 0, samples: [], line_numbers: [] };
      }
      const d = fieldDiscrepancies[reg];
      d.occurrences++;
      if (d.samples.length < 3) d.samples.push(line.trim());
      if (d.line_numbers.length < 5) d.line_numbers.push(lineNum);
    }
  }

  return {
    total_unique_blocks: Object.keys(blockOccurrences).length,
    block_occurrences: blockOccurrences,
    missing_blocks: Array.from(missingBlocks),
    field_count_discrepancies: Object.entries(fieldDiscrepancies).map(([reg, v]) => ({
      registro: reg,
      expected_fields: v.expected,
      occurrences: v.occurrences,
      sample_line_numbers: v.line_numbers,
      sample_texts: v.samples,
    })),
  };
}

async function collectTxts(dir, recursive) {
  let results = [];
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        results = results.concat(await collectTxts(full, true));
      }
    } else if (/\.txt$/i.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

(async () => {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Uso: node validate_backlog.js <pasta> [--recursive]');
    process.exit(1);
  }
  const dir = args[0];
  const recursive = args.includes('--recursive');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error('Diretório inválido:', dir);
    process.exit(1);
  }
  console.log(`Buscando .txt em ${dir} (recursive=${recursive})`);
  const txtFiles = await collectTxts(dir, recursive);
  console.log(`Achados ${txtFiles.length} arquivos .txt`);
  const report = { generated_at: new Date().toISOString(), files: {} };
  for (const filePath of txtFiles) {
    try {
      process.stdout.write(`Validando ${filePath}... `);
      report.files[filePath] = await validateOneSpedFile(filePath);
      console.log('ok');
    } catch (e) {
      console.log('erro');
      report.files[filePath] = { error: e.message };
    }
  }
  const outPath = path.join(__dirname, 'backlog_report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Relatório gravado em ${outPath}`);
})();
