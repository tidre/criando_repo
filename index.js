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

/**
 * Valida um único arquivo SPED .txt contra o layout.
 * Retorna objeto com ocorrências, blocos faltando e discrepâncias.
 */
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
        fieldDiscrepancies[reg] = {
          expected: expectedFields,
          occurrences: 0,
          samples: [],
          line_numbers: []
        };
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

app.use(express.static(path.join(__dirname, 'public')));

// --- Validação de layout vs SPED .txt (upload único) ---
const uploadValidation = multer({ dest: path.join(UPLOADS_DIR, 'tmp') });
app.post('/validate_layout', uploadValidation.single('sped'), async (req, res) => {
  try {
    // carrega layout
    const layoutPath = req.body.layout
      ? req.body.layout
      : path.join(__dirname, 'layout_blocos.json');
    if (!fs.existsSync(layoutPath)) {
      return res.status(400).json({
        erro: 'layout_blocos.json não encontrado',
        caminho: layoutPath
      });
    }
    const layoutRaw = fs.readFileSync(layoutPath, { encoding: 'latin1' });
    let layout, layoutOrder;
    try {
      layout = JSON.parse(layoutRaw);
      layoutOrder = Object.keys(layout);
    } catch (e) {
      return res.status(500).json({
        erro: 'Falha ao parsear layout_blocos.json',
        detalhes: e.message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        erro: 'Arquivo SPED .txt (campo "sped") não enviado'
      });
    }

    const filePath = req.file.path;
    const result = await validateOneSpedFile(filePath, layout);
    // remove .txt temporário
    try { fs.unlinkSync(filePath); } catch {}

    // ordena missing_blocks
    const missingArr = result.missing_blocks.sort(
      (a, b) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b)
    );
    // ordena block_occurrences
    const occurrencesArr = Object.entries(result.block_occurrences)
      .sort(([a], [b]) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b));

    const summary = {
      total_unique_blocks: occurrencesArr.length,
      block_occurrences: Object.fromEntries(occurrencesArr),
      missing_blocks: missingArr,
      field_count_discrepancies: result.field_count_discrepancies
    };

    res.json(summary);
  } catch (e) {
    console.error('Erro validar layout', e);
    res.status(500).json({ erro: 'falha validacao', detalhes: e.message });
  }
});

// --- Validação a partir de arquivo compactado (.zip/.rar) ---
const uploadArchive = multer({ dest: path.join(UPLOADS_DIR, 'archives') });
app.post('/validate_layout_archive', uploadArchive.single('archive'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ erro: 'Envie um .zip ou .rar no campo "archive"' });
  }

  // carrega layout
  const layoutPath = req.body.layout
    ? req.body.layout
    : path.join(__dirname, 'layout_blocos.json');
  if (!fs.existsSync(layoutPath)) {
    return res.status(400).json({
      erro: 'layout_blocos.json não encontrado',
      caminho: layoutPath
    });
  }
  const layoutRaw = fs.readFileSync(layoutPath, { encoding: 'latin1' });
  let layout, layoutOrder;
  try {
    layout = JSON.parse(layoutRaw);
    layoutOrder = Object.keys(layout);
  } catch (e) {
    return res.status(500).json({
      erro: 'Erro ao parsear layout',
      detalhes: e.message
    });
  }

  const tempDir = path.join(UPLOADS_DIR, `extract_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const archivePath = req.file.path;
  const lower = req.file.originalname.toLowerCase();

  try {
    // descompacta
    if (lower.endsWith('.zip')) {
      await fs.createReadStream(archivePath)
        .pipe(unzipper.Parse())
        .on('entry', async entry => {
          const fileName = entry.path;
          const sanitized = path.normalize(fileName)
            .replace(/^(\.\.(\/|\\|$))+/g, '');
          const destPath = path.join(tempDir, sanitized);
          if (!destPath.startsWith(path.resolve(tempDir))) {
            entry.autodrain();
            return;
          }
          if (entry.type === 'Directory') {
            await fsPromises.mkdir(destPath, { recursive: true });
            entry.autodrain();
          } else {
            await fsPromises.mkdir(path.dirname(destPath), { recursive: true });
            entry.pipe(fs.createWriteStream(destPath));
          }
        })
        .promise();

    } else if (lower.endsWith('.rar')) {
      const result = spawnSync('unrar', ['x', '-y', archivePath, tempDir]);
      if (result.status !== 0) {
        throw new Error(
          `Falha ao extrair .rar: ${result.stderr.toString() || result.stdout.toString()}`
        );
      }

    } else {
      return res.status(400).json({
        erro: 'Formato não suportado. Use .zip ou .rar'
      });
    }

    // encontra todos os .txt extraídos
    const walk = async dir => {
      let files = [];
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files = files.concat(await walk(full));
        } else if (/\.txt$/i.test(entry.name)) {
          files.push(full);
        }
      }
      return files;
    };

    const txtFiles = await walk(tempDir);
    if (txtFiles.length === 0) {
      return res.status(404).json({
        erro: 'Nenhum .txt encontrado dentro do arquivo'
      });
    }

    // valida cada .txt
    const summaries = {};
    for (const f of txtFiles) {
      try {
        const rawSummary = await validateOneSpedFile(f, layout);
        // ordena missing_blocks
        rawSummary.missing_blocks.sort(
          (a, b) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b)
        );
        // ordena block_occurrences
        const occArr = Object.entries(rawSummary.block_occurrences)
          .sort(([a], [b]) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b));
        rawSummary.block_occurrences = Object.fromEntries(occArr);

        summaries[path.relative(tempDir, f)] = rawSummary;
      } catch (e) {
        summaries[path.relative(tempDir, f)] = { erro: e.message };
      }
    }

    // agrupa estatísticas gerais
    const aggregate = {
      total_files: txtFiles.length,
      files_with_missing_blocks: 0,
      files_with_discrepancies: 0,
      unique_missing_blocks: new Set()
    };
    for (const summary of Object.values(summaries)) {
      if (summary.missing_blocks?.length) {
        aggregate.files_with_missing_blocks++;
        summary.missing_blocks.forEach(b =>
          aggregate.unique_missing_blocks.add(b)
        );
      }
      if (summary.field_count_discrepancies?.length) {
        aggregate.files_with_discrepancies++;
      }
    }
    // ordena blocos únicos faltando
    const uniq = Array.from(aggregate.unique_missing_blocks);
    aggregate.unique_missing_blocks = uniq.sort(
      (a, b) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b)
    );

    res.json({ aggregate, per_file: summaries });

  } catch (err) {
    console.error('Erro no archive validation', err);
    res.status(500).json({ erro: 'Falha ao processar archive', detalhes: err.message });
  } finally {
    // limpa arquivos temporários
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(archivePath); } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`Validador SPED rodando em http://localhost:${PORT}`);
});
