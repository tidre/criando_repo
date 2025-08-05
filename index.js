const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const readline = require('readline');
const unzipper = require('unzipper');
const { spawnSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 22000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// === 1) Carrega layout e ordem GLOBALMENTE ===
const LAYOUT_PATH = path.join(__dirname, 'layout_blocos.json');
if (!fs.existsSync(LAYOUT_PATH)) {
  console.error('layout_blocos.json não encontrado em', LAYOUT_PATH);
  process.exit(1);
}
let layoutRaw = fs.readFileSync(LAYOUT_PATH, { encoding: 'latin1' });
let layout, layoutOrder;
try {
  layout = JSON.parse(layoutRaw);
  layoutOrder = Object.keys(layout);
} catch (e) {
  console.error('Falha ao parsear layout_blocos.json:', e.message);
  process.exit(1);
}

// Helper que valida um único .txt
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
    const line = lineRaw.trim();
    if (!line.startsWith('|')) continue;
    const parts = line.replace(/^\|/, '').replace(/\|$/, '').split('|');
    const reg = parts[0];
    blockOccurrences[reg] = (blockOccurrences[reg] || 0) + 1;

    const actualFields = parts.length - 1;
    const expectedDef = layout[reg];
    if (!expectedDef) {
      missingBlocks.add(reg);
      continue;
    }
    const expectedFields = expectedDef.length - 1;
    if (actualFields !== expectedFields) {
      if (!fieldDiscrepancies[reg]) {
        fieldDiscrepancies[reg] = {
          expected: expectedFields,
          occurrences: 0,
          samples: [],
          line_numbers: []
        };
      }
      const d = fieldDiscrepancies[reg];
      d.occurrences++;
      if (d.samples.length < 3) d.samples.push(line);
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

app.use(express.static(path.join(__dirname, 'public')));

// === 2) Rota upload único ===
const uploadSingle = multer({ dest: path.join(UPLOADS_DIR, 'tmp') });
app.post('/validate_layout', uploadSingle.single('sped'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ erro: 'Envie o .txt no campo "sped"' });
  }
  try {
    // valida
    const raw = await validateOneSpedFile(req.file.path);
    // limpa
    fs.unlinkSync(req.file.path);

    // ordena block_occurrences
    const occArr = Object.entries(raw.block_occurrences)
      .sort(([a], [b]) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b));
    // ordena missing_blocks
    const missArr = raw.missing_blocks.sort(
      (a, b) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b)
    );

    return res.json({
      total_unique_blocks: occArr.length,
      block_occurrences: Object.fromEntries(occArr),
      missing_blocks: missArr,
      field_count_discrepancies: raw.field_count_discrepancies
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'falha validacao', detalhes: e.message });
  }
});

// === 3) Rota upload de .zip/.rar ===
const uploadArchive = multer({ dest: path.join(UPLOADS_DIR, 'archives') });
app.post('/validate_layout_archive', uploadArchive.single('archive'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ erro: 'Envie .zip ou .rar no campo "archive"' });
  }
  const archivePath = req.file.path;
  const nameLower = req.file.originalname.toLowerCase();
  const tempDir = path.join(UPLOADS_DIR, `extract_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // extrai
    if (nameLower.endsWith('.zip')) {
      await fs.createReadStream(archivePath)
        .pipe(unzipper.Parse())
        .on('entry', async entry => {
          const sanitized = path.normalize(entry.path).replace(/^(\.\.(\/|\\|$))+/g, '');
          const dest = path.join(tempDir, sanitized);
          if (!dest.startsWith(path.resolve(tempDir))) {
            entry.autodrain();
            return;
          }
          if (entry.type === 'Directory') {
            await fsPromises.mkdir(dest, { recursive: true });
            entry.autodrain();
          } else {
            await fsPromises.mkdir(path.dirname(dest), { recursive: true });
            entry.pipe(fs.createWriteStream(dest));
          }
        })
        .promise();

    } else if (nameLower.endsWith('.rar')) {
      const result = spawnSync('unrar', ['x', '-y', archivePath, tempDir]);
      if (result.status !== 0) {
        throw new Error(result.stderr.toString() || result.stdout.toString());
      }
    } else {
      return res.status(400).json({ erro: 'Formato não suportado — use .zip ou .rar' });
    }

    // encontra .txt
    async function walk(dir) {
      let fns = [];
      for (const ent of await fsPromises.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          fns = fns.concat(await walk(full));
        } else if (/\.txt$/i.test(ent.name)) {
          fns.push(full);
        }
      }
      return fns;
    }
    const txtFiles = await walk(tempDir);
    if (!txtFiles.length) {
      return res.status(404).json({ erro: 'Nenhum .txt dentro do archive' });
    }

    // valida cada um
    const per_file = {};
    for (const f of txtFiles) {
      try {
        const raw = await validateOneSpedFile(f);
        // ordena
        const occArr = Object.entries(raw.block_occurrences)
          .sort(([a], [b]) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b));
        raw.block_occurrences = Object.fromEntries(occArr);
        raw.missing_blocks.sort((a, b) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b));
        per_file[path.relative(tempDir, f)] = raw;
      } catch (e) {
        per_file[path.relative(tempDir, f)] = { erro: e.message };
      }
    }

    // agregado
    const aggregate = {
      total_files: txtFiles.length,
      files_with_missing_blocks: 0,
      files_with_discrepancies: 0,
      unique_missing_blocks: new Set()
    };
    Object.values(per_file).forEach(s => {
      if (s.missing_blocks.length) {
        aggregate.files_with_missing_blocks++;
        s.missing_blocks.forEach(b => aggregate.unique_missing_blocks.add(b));
      }
      if (s.field_count_discrepancies.length) {
        aggregate.files_with_discrepancies++;
      }
    });
    const uniq = Array.from(aggregate.unique_missing_blocks);
    aggregate.unique_missing_blocks = uniq.sort(
      (a, b) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b)
    );

    return res.json({ aggregate, per_file });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Falha archive', detalhes: e.message });
  } finally {
    // cleanup
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(archivePath); } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`Validador SPED em http://localhost:${PORT}`);
});
