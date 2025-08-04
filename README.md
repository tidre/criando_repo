# Validador SPED

## Propósito

Essa ferramenta valida arquivos SPED `.txt` comparando os blocos presentes no arquivo com o layout definido em `layout_blocos.json`, reportando:
- Blocos que aparecem no `.txt` mas estão faltando no layout.
- Discrepâncias na quantidade de campos por registro (esperado vs encontrado).
- Contagem de ocorrências por bloco.

Também inclui interface web simples para uso por pessoas sem conhecimento técnico, e um script CLI para validar backlog.

## Estrutura

- `index.js` — servidor Express com endpoint `/validate_layout`.
- `public/validador.html` — interface web para upload e visualização do resultado.
- `validate_backlog.js` — script CLI para processar uma pasta inteira de arquivos `.txt`.
- `layout_blocos.json` — **não incluído**: você deve copiar o seu arquivo real para a raiz do projeto.
- `backlog_report.json` — gerado pelo script CLI.

## Instalação

1. Copie seu `layout_blocos.json` para a raiz (mesmo diretório de `index.js`):
   ```bash
   cp /caminho/do/seu/layout_blocos.json .
   ```

2. Instale dependências:
   ```bash
   npm install express multer
   ```

3. (Opcional) Torne o script CLI executável:
   ```bash
   chmod +x validate_backlog.js
   ```

## Uso

### 1. Interface Web

1. Rode o servidor:
   ```bash
   node index.js
   ```
2. Abra no navegador:
   ```
   http://localhost:22000/validador.html
   ```
3. Selecione o arquivo `.txt` do SPED, opcionalmente informe um layout alternativo (caminho no servidor), clique em **Validar**.  
4. Veja o resumo, blocos faltando e discrepâncias. Exporte JSON ou CSV com os botões.

### 2. Endpoint direto (para automação / Insomnia)

- Requisição `POST` para:
  ```
  http://localhost:22000/validate_layout
  ```
- Corpo: `multipart/form-data`
  - `sped`: arquivo `.txt`
  - `layout`: (opcional) caminho para outro `layout_blocos.json` (ex: `/outro/layout.json`)

Exemplo com `curl`:
```bash
curl -F "sped=@arquivo.txt" http://localhost:22000/validate_layout
```

### 3. Backlog (vários arquivos atrasados)

1. Execute:
   ```bash
   node validate_backlog.js caminho/para/pasta_com_txts --recursive
   ```
2. No fim será gerado `backlog_report.json` com a validação de cada arquivo.

## Resultado

O endpoint e o script retornam um JSON com formato parecido com:
```json
{
  "total_unique_blocks": 12,
  "block_occurrences": { "C100": 5, "C170": 20 },
  "missing_blocks": ["X001"],
  "field_count_discrepancies": [
    {
      "registro": "C170",
      "expected_fields": 30,
      "occurrences": 2,
      "sample_line_numbers": [10, 54],
      "sample_texts": ["|C170|...|", "|C170|...|"]
    }
  ]
}
```

## Recomendações

- Coloque esse serviço num servidor compartilhado interno se várias pessoas vão usar.  
- Pode combinar com um atalho / script .bat para abrir a interface diretamente.  
- Para auditoria, salve os JSONs de resultado com timestamp.

## Dependências mínimas

- Node.js 18+ (ou compatível)
- `express`
- `multer`

## Exemplo rápido

```bash
cp ~/meu/layout_blocos.json .
npm install express multer
node index.js
# abrir no navegador e validar
```
