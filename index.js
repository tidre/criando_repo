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

// === Carrega layout e ordem textual ===
const LAYOUT_PATH = path.join(__dirname, 'layout_blocos.json');
const layoutText = fs.readFileSync(LAYOUT_PATH, { encoding: 'latin1' });
const layoutOrder = [];
const keyRegex = /"([^"]+)":\s*\[/g;
let m;
while (m = keyRegex.exec(layoutText)) layoutOrder.push(m[1]);
const layout = JSON.parse(layoutText);

// Helper de validação de um .txt
async function validateOneSpedFile(filePath) {
  const blockOccurrences = {};
  const missingBlocks = new Set();
  const fieldDiscrepancies = {};
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'latin1' }),
    crlfDelay: Infinity
  });
  let lineNum = 0;
  for await (const raw of rl) {
    lineNum++;
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const parts = line.replace(/^\|/, '').replace(/\|$/, '').split('|');
    const reg = parts[0];
    blockOccurrences[reg] = (blockOccurrences[reg] || 0) + 1;
    const expectedDef = layout[reg];
    if (!expectedDef) {
      missingBlocks.add(reg);
      continue;
    }
    const actualFields = parts.length - 1;
    const expectedFields = expectedDef.length - 1;
    if (actualFields !== expectedFields) {
      fieldDiscrepancies[reg] ??= { expected: expectedFields, occurrences: 0, samples: [], line_numbers: [] };
      const d = fieldDiscrepancies[reg];
      d.occurrences++;
      if (d.samples.length < 3) d.samples.push(line);
      if (d.line_numbers.length < 5) d.line_numbers.push(lineNum);
    }
  }
  return {
    blockOccurrences,
    missingBlocks: Array.from(missingBlocks),
    fieldDiscrepancies: Object.entries(fieldDiscrepancies).map(([r,v]) => ({
      registro: r,
      expected_fields: v.expected,
      occurrences: v.occurrences,
      sample_line_numbers: v.line_numbers,
      sample_texts: v.samples
    }))
  };
}

app.use(express.static(path.join(__dirname,'public')));

// --- Upload único ---
const uploadSingle = multer({ dest: path.join(UPLOADS_DIR,'tmp') });
app.post('/validate_layout', uploadSingle.single('sped'), async (req,res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie .txt no campo sped' });
  try {
    const { blockOccurrences, missingBlocks, fieldDiscrepancies } = 
      await validateOneSpedFile(req.file.path);
    fs.unlinkSync(req.file.path);

    // monta array de ocorrências ordenado
    const occArr = layoutOrder
      .filter(r => blockOccurrences[r] != null)
      .map(r => ({ registro: r, ocorrencias: blockOccurrences[r] }));

    // missingBlocks já é array; filtra e ordena
    const missArr = layoutOrder.filter(r => missingBlocks.includes(r));

    return res.json({
      total_unique_blocks: occArr.length,
      block_occurrences: occArr,
      missing_blocks: missArr,
      field_count_discrepancies: fieldDiscrepancies
    });
  } catch(e) {
    console.error(e);
    return res.status(500).json({ erro:'falha validacao', detalhes: e.message });
  }
});

// --- Upload .zip/.rar ---
const uploadArchive = multer({ dest: path.join(UPLOADS_DIR,'archives') });
app.post('/validate_layout_archive', uploadArchive.single('archive'), async (req,res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie .zip ou .rar no campo archive' });
  const archivePath = req.file.path;
  const tempDir = path.join(UPLOADS_DIR, `ext_${Date.now()}`);
  fs.mkdirSync(tempDir,{recursive:true});
  try {
    const name = req.file.originalname.toLowerCase();
    if (name.endsWith('.zip')) {
      await fs.createReadStream(archivePath)
        .pipe(unzipper.Parse())
        .on('entry', async ent => {
          const sanitized = path.normalize(ent.path).replace(/^(\.\.(\/|\\|$))+/g,'');
          const dest = path.join(tempDir,sanitized);
          if (!dest.startsWith(tempDir)) return ent.autodrain();
          if (ent.type==='Directory') {
            await fsPromises.mkdir(dest,{recursive:true});
            ent.autodrain();
          } else {
            await fsPromises.mkdir(path.dirname(dest),{recursive:true});
            ent.pipe(fs.createWriteStream(dest));
          }
        }).promise();
    } else if (name.endsWith('.rar')) {
      const r = spawnSync('unrar',['x','-y',archivePath,tempDir]);
      if (r.status!==0) throw new Error(r.stderr.toString());
    } else {
      return res.status(400).json({ erro:'Formato não suportado' });
    }

    // coleta .txt
    async function walk(dir) {
      let out=[];
      for (const e of await fsPromises.readdir(dir,{withFileTypes:true})) {
        const f = path.join(dir,e.name);
        if (e.isDirectory()) {
          out = out.concat(await walk(f));
        } else if (/\.txt$/i.test(e.name)) {
          out.push(f);
        }
      }
      return out;
    }
    const files = await walk(tempDir);
    if (!files.length) return res.status(404).json({ erro:'Nenhum .txt no archive' });

    const per_file = {};
    for (const f of files) {
      try {
        const {blockOccurrences,missingBlocks,fieldDiscrepancies} = await validateOneSpedFile(f);

        const occArr = layoutOrder
          .filter(r=>blockOccurrences[r]!=null)
          .map(r=>({ registro:r, ocorrencias:blockOccurrences[r]}));
        const missArr = layoutOrder.filter(r=>missingBlocks.includes(r));

        per_file[path.relative(tempDir,f)] = {
          block_occurrences: occArr,
          missing_blocks: missArr,
          field_count_discrepancies: fieldDiscrepancies
        };
      } catch(err){
        per_file[path.relative(tempDir,f)] = { erro: err.message };
      }
    }

    // aggregate
    const agg = { total_files: files.length, missing_files:0, discrep_files:0, unique_missing:[] };
    const uniqSet = new Set();
    for (const v of Object.values(per_file)) {
      if (v.missing_blocks.length) {
        agg.missing_files++;
        v.missing_blocks.forEach(b=>uniqSet.add(b));
      }
      if (v.field_count_discrepancies.length) agg.discrep_files++;
    }
    agg.unique_missing = layoutOrder.filter(r=>uniqSet.has(r));

    return res.json({ aggregate: agg, per_file });
  } catch(err) {
    console.error(err);
    return res.status(500).json({ erro:'falha archive', detalhes:err.message });
  } finally {
    try{ fs.rmSync(tempDir,{recursive:true,force:true}); }catch{}
    try{ fs.unlinkSync(archivePath);}catch{}
  }
});

app.listen(PORT,()=>console.log(`Rodando em http://localhost:${PORT}`));
