const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 22000;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));

// --- Validação de layout vs SPED .txt ---
const uploadValidation = multer({ dest: path.join(UPLOADS_DIR, 'tmp') });
app.post('/validate_layout', uploadValidation.single('sped'), async (req, res) => {
  try {
    const layoutPath = req.body.layout ? req.body.layout : path.join(__dirname, 'layout_blocos.json');
    if (!fs.existsSync(layoutPath)) {
      return res.status(400).json({ erro: 'layout_blocos.json não encontrado', caminho: layoutPath });
    }
    const layoutRaw = fs.readFileSync(layoutPath, { encoding: 'latin1' });
    let layout;
    try { layout = JSON.parse(layoutRaw); } catch (e) { return res.status(500).json({ erro: 'Falha ao parsear layout_blocos.json', detalhes: e.message }); }
    if (!req.file) {
      return res.status(400).json({ erro: 'Arquivo SPED .txt (campo \"sped\") não enviado' });
    }
    const filePath = req.file.path;
    const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'latin1' }), crlfDelay: Infinity });

    const missingBlocks = new Set();
    const fieldDiscrepancies = {};
    const blockOccurrences = {};
    let lineNum = 0;
    for await (const line of rl) {
      lineNum++;
      if (!line.trim().startsWith('|')) continue;
      const partes = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
      const reg = partes[0];
      blockOccurrences[reg] = (blockOccurrences[reg] || 0) + 1;
      const actualFields = partes.length - 1; // exclui o registro
      const expectedDef = layout[reg];
      if (!expectedDef) {
        missingBlocks.add(reg);
        continue;
      }
      const expectedFields = expectedDef.length - 1; // ignora "reg"
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

    // limpar arquivo temporário
    try { fs.unlinkSync(filePath); } catch {}

    const summary = {
      total_unique_blocks: Object.keys(blockOccurrences).length,
      block_occurrences: blockOccurrences,
      missing_blocks: Array.from(missingBlocks),
      field_count_discrepancies: Object.entries(fieldDiscrepancies).map(([reg, v]) => ({
        registro: reg,
        expected_fields: v.expected,
        occurrences: v.occurrences,
        sample_line_numbers: v.line_numbers,
        sample_texts: v.samples
      }))
    };
    res.json(summary);
  } catch (e) {
    console.error('Erro validar layout', e);
    res.status(500).json({ erro: 'falha validacao', detalhes: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Validador SPED rodando em http://localhost:${PORT}`);
});
