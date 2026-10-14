/**
 * API da planilha de ofertas — cole este arquivo inteiro no Apps Script da
 * planilha (Extensões > Apps Script) e implante como app da web.
 *
 * O robô local usa dois endpoints:
 *   GET  ?token=...        → lista as linhas da planilha em JSON
 *   POST {token, row, status} → escreve na coluna Status da linha indicada
 *
 * O token abaixo é a única proteção do endpoint: quem tiver a URL e o token
 * lê e escreve na planilha através deste script. Mantenha os dois apenas no
 * .env do robô. Pode trocar o valor à vontade — só reimplante depois.
 */
// Ao colar no Apps Script, troque pelo mesmo valor de SHEET_WEBAPP_TOKEN do
// .env. Este arquivo vai para o repositório: nunca salve o token real aqui.
const TOKEN = "COLE_AQUI_O_SHEET_WEBAPP_TOKEN";

/** Colunas esperadas: A=Link, B=Preço, C=Preço De, D=Comentário, E=Status. */
const STATUS_COLUMN = 5;

function doGet(e) {
  if (!e || !e.parameter || e.parameter.token !== TOKEN) return unauthorized_();

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const rows = sheet.getDataRange().getValues();
  const out = [];

  // Linha 1 é o cabeçalho; `row` é o número real da linha na planilha,
  // usado depois pelo POST para marcar o status no lugar certo.
  for (let i = 1; i < rows.length; i++) {
    const link = String(rows[i][0] || "").trim();
    if (!link) continue;
    out.push({
      row: i + 1,
      link: link,
      preco: String(rows[i][1] || "").trim(),
      precoDe: String(rows[i][2] || "").trim(),
      comentario: String(rows[i][3] || "").trim(),
      status: String(rows[i][4] || "").trim(),
    });
  }

  return json_({ ok: true, rows: out });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "JSON inválido" });
  }
  if (body.token !== TOKEN) return unauthorized_();

  const row = Number(body.row);
  if (!Number.isInteger(row) || row < 2) {
    return json_({ ok: false, error: "row inválida (mínimo 2; a linha 1 é o cabeçalho)" });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  sheet.getRange(row, STATUS_COLUMN).setValue(String(body.status || ""));
  return json_({ ok: true });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function unauthorized_() {
  return json_({ ok: false, error: "token inválido" });
}
