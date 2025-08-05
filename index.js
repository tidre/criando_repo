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

// Função que valida um único arquivo .txt
async function validateOneSpedFile(filePath, layout) {
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

// Rota para validar upload único
const uploadValidation = multer({ dest: path.join(UPLOADS_DIR, 'tmp') });
app.post('/validate_layout', uploadValidation.single('sped'), async (req, res) => {
  try {
    // Carrega e parseia layout
    const layoutPath = req.body.layout || path.join(__dirname, 'layout_blocos.json');
    if (!fs.existsSync(layoutPath)) {
      return res.status(400).json({ erro: 'layout_blocos.json não encontrado', caminho: layoutPath });
    }
    const layoutRaw = fs.readFileSync(layoutPath, { encoding: 'latin1' });
    let layout, layoutOrder;
    try {
      layout = JSON.parse(layoutRaw);
      layoutOrder = Object.keys(layout);
    } catch (e) {
      return res.status(500).json({ erro: 'Falha ao parsear layout', detalhes: e.message });
    }

    if (!req.file) {
      return res.status(400).json({ erro: 'Arquivo SPED não enviado (campo "sped")' });
    }

    // Valida o arquivo
    const summaryRaw = await validateOneSpedFile(req.file.path, layout);
    // limpa temporário
    try { fs.unlinkSync(req.file.path); } catch {}

    // Ordena block_occurrences conforme layoutOrder
    const occArr = Object.entries(summaryRaw.block_occurrences)
      .sort(([a], [b]) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b));

    // Ordena missing_blocks conforme layoutOrder
    const missArr = summaryRaw.missing_blocks
      .sort((a, b) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b));

    // Monta resposta final
    const summary = {
      total_unique_blocks: occArr.length,
      block_occurrences: Object.fromEntries(occArr),
      missing_blocks: missArr,
      field_count_discrepancies: summaryRaw.field_count_discrepancies
    };

    return res.json(summary);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: 'falha validacao', detalhes: err.message });
  }
});

// Rota para validar .zip / .rar com múltiplos .txt
const uploadArchive = multer({ dest: path.join(UPLOADS_DIR, 'archives') });
app.post('/validate_layout_archive', uploadArchive.single('archive'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ erro: 'Envie um arquivo .zip ou .rar (campo "archive")' });
  }

  // Carrega layout
  const layoutPath = req.body.layout || path.join(__dirname, 'layout_blocos.json');
  if (!fs.existsSync(layoutPath)) {
    return res.status(400).json({ erro: 'layout_blocos.json não encontrado', caminho: layoutPath });
  }
  const layoutRaw = fs.readFileSync(layoutPath, { encoding: 'latin1' });
  let layout, layoutOrder;
  try {
    layout = JSON.parse(layoutRaw);
    layoutOrder = Object.keys(layout);
  } catch (e) {
    return res.status(500).json({ erro: 'Falha ao parsear layout', detalhes: e.message });
  }

  // Pasta temporária de extração
  const tempDir = path.join(UPLOADS_DIR, `extract_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Extrai ZIP ou RAR
  const archivePath = req.file.path;
  const nameLower = req.file.originalname.toLowerCase();
  try {
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
      return res.status(400).json({ erro: 'Formato não suportado. Use .zip ou .rar' });
    }

    // Coleta todos .txt extraídos
    async function walk(dir) {
      let out = [];
      for (const ent of await fsPromises.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          out = out.concat(await walk(full));
        } else if (/\.txt$/i.test(ent.name)) {
          out.push(full);
        }
      }
      return out;
    }
    const txtFiles = await walk(tempDir);
    if (!txtFiles.length) {
      return res.status(404).json({ erro: 'Nenhum .txt encontrado no archive' });
    }

    // Valida cada .txt
    const per_file = {};
    for (const f of txtFiles) {
      try {
        const raw = await validateOneSpedFile(f, layout);

        // Ordena no raw
        const occArr2 = Object.entries(raw.block_occurrences)
          .sort(([a], [b]) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b));
        raw.block_occurrences = Object.fromEntries(occArr2);
        raw.missing_blocks.sort((a, b) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b));

        per_file[path.relative(tempDir, f)] = raw;
      } catch (e) {
        per_file[path.relative(tempDir, f)] = { erro: e.message };
      }
    }

    // Monta estatísticas agregadas
    const aggregate = {
      total_files: txtFiles.length,
      files_with_missing_blocks: 0,
      files_with_discrepancies: 0,
      unique_missing_blocks: new Set()
    };
    Object.values(per_file).forEach(s => {
      if (s.missing_blocks?.length) {
        aggregate.files_with_missing_blocks++;
        s.missing_blocks.forEach(b => aggregate.unique_missing_blocks.add(b));
      }
      if (s.field_count_discrepancies?.length) {
        aggregate.files_with_discrepancies++;
      }
    });
    const uniq = Array.from(aggregate.unique_missing_blocks);
    aggregate.unique_missing_blocks = uniq.sort(
      (a, b) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b)
    );

    res.json({ aggregate, per_file });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Falha ao processar archive', detalhes: err.message });
  } finally {
    // cleanup
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(archivePath); } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`Validador SPED rodando em http://localhost:${PORT}`);
});
