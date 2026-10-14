# Robô de Ofertas

Publica num grupo de WhatsApp as ofertas que você cura numa planilha do Google
Sheets: o robô lê o link de afiliado da planilha, extrai título e foto do
produto, monta a mensagem de venda e envia — rodando no seu PC, com custo zero
de infraestrutura.

## Onde o projeto está — 17/08/2026

**Pronto e verificado**

- **Virada de estratégia concluída**: a coleta automática pela API do ML foi
  substituída pela curadoria humana na planilha. O código antigo (OAuth,
  busca no catálogo, scoring, painel de afiliados) segue no repositório,
  dormente — ver *Fluxo antigo*, no fim.
- **Ponte com a planilha no ar**: web app do Apps Script implantado
  (`scripts/planilha-webapp.gs`), lido e escrito pelo robô via
  `SHEET_WEBAPP_URL`/`SHEET_WEBAPP_TOKEN` no `.env`
- **Scraping validado com link real**: `og:title` e `og:image` extraídos de um
  `meli.la` de verdade, foto baixada em JPEG (o WebP do mlstatic vira `.jpg`
  trocando a extensão)
- **WhatsApp pareado**: sessão em `data/wa-session/`, reconectando sem QR, e
  envio já testado no grupo de teste com `npm run wa:test`
- **`WA_GROUP_JID` apontando para o grupo de teste** (Grupo de Ofertas -
  Teste). O grupo real é o Grupo de Ofertas — trocar só na virada para
  produção
- `npm test` passando (29 verificações), typecheck limpo
- **Preço no momento do envio** (17/08): o robô extrai preço atual, "de",
  frete grátis e parcelamento do JSON embutido na página do link — validado
  ao vivo nos 4 links da planilha. Colunas B/C viram override opcional
- **Ciclo real validado de ponta a ponta** (17/08, 16:28): 3 links da planilha
  publicados no grupo de teste com foto + legenda, espaçados de ~1 min, e a
  coluna Status marcada com `ENVIADO ✅`
- **Ritmo de produção configurado**: 1 oferta por ciclo
  (`dedupe.maxPostsPerRun`) com ciclo a cada 30 min; janela de silêncio da 1h
  às 7h (`schedule: "0,30 0,7-23 * * *"`) — o espaçamento entre ofertas é o
  agendador, não um sleep

**Falta fazer, na ordem**

1. Conferir no celular como as mensagens ficaram no grupo de teste
2. ~~Apontar o `WA_GROUP_JID` para o grupo real, trocar `DRY_RUN=false` no
   `.env` e agendar no Agendador de Tarefas~~ — feito em 18/08/2026: robô
   publicando no grupo real e no ar pela tarefa `RoboOfertasWhatsApp`

## Como funciona

```
planilha (links curados)  →  filtro de já enviados  →  scraping (título+foto)  →  mensagem  →  WhatsApp
   Apps Script web app        coluna Status + SQLite     og:title / og:image       legenda      foto + legenda
```

Quem decide o que é oferta é você, ao colar o link (já afiliado) na planilha.
O robô só enriquece e publica. Não há scoring nem conversão de afiliado — os
dois maiores pontos de fragilidade do fluxo antigo deixaram de existir.

**A planilha** (primeira aba, cabeçalho na linha 1):

| A: Link | B: Preço | C: Preço De | D: Comentário | E: Status |
|---|---|---|---|---|
| obrigatória | opcional | opcional | opcional | o robô preenche |

- Só o **Link** é obrigatório: o robô lê **preço, "de", frete grátis e
  parcelamento direto da página no momento do envio** (do JSON embutido no
  card do produto — ver `extractFeaturedPrice` em `src/scrape/product.ts`),
  então preço desatualizado na planilha deixou de ser um risco.
- **Preço**/**Preço De** preenchidos **sobrescrevem** o da página — use para
  cupom ou preço negociado. Aceita "189,90", "R$ 1.234,56" etc. Divergência
  entre planilha e página gera aviso no log, mas a planilha vence.
- **Comentário** vira uma linha destacada na mensagem ("Menor preço do ano").
- **Status** recebe `ENVIADO ✅ dd/mm hh:mm` após publicar. Linha com status
  preenchido nunca é reenviada; apagar o status **não** reenvia sozinho,
  porque o banco (`data/ofertas.db`, tabela `posted`) também guarda o link.

**O scraping** (`src/scrape/product.ts`): o link curto (`meli.la/...`)
redireciona para a página "Perfil Social" do afiliado, cujos `og:title` e
`og:image` são do produto — `<title>` e `og:description` são do perfil e são
ignorados de propósito. Caminho normal é um fetch com User-Agent de navegador;
se o ML passar a bloquear, o fallback abre a página no Chromium do Playwright
(`npm run playwright:install` uma vez). A foto é baixada preferindo a variante
`.jpg` do mlstatic, porque o WhatsApp trata WebP como figurinha.

## Riscos que você precisa conhecer

**WhatsApp.** O envio usa o [Baileys](https://github.com/WhiskeySockets/Baileys),
que conversa com o WhatsApp Web por engenharia reversa e **viola os Termos de
Serviço do WhatsApp**. O número pode ser banido sem aviso. Use um chip dedicado,
nunca o seu pessoal. A alternativa oficial (Cloud API da Meta) limita grupos a 8
participantes, o que não serve para grupo de ofertas — foi por isso que o
caminho não-oficial foi escolhido.

**Scraping.** A extração de título/foto depende das meta tags `og:` das páginas
do ML — não documentadas como API. Se sumirem, a linha falha com erro claro no
log e fica pendente na planilha; nada é publicado pela metade.

**Web app da planilha.** A implantação precisa estar como acesso "Qualquer
pessoa" (a proteção é o token dentro do script). Quem tiver URL + token lê e
escreve na planilha através do script — os dois vivem só no `.env`.

## Pré-requisitos

1. **Node.js 22.5+** (usa o SQLite embutido — não precisa compilar nada).
2. **Planilha no Google Sheets** com o web app do Apps Script implantado —
   o código é `scripts/planilha-webapp.gs`, e o passo a passo está no
   cabeçalho do próprio arquivo.
3. **Chip dedicado** para o WhatsApp do robô, já adicionado ao grupo alvo.

## Instalação

```bash
npm install
```

Copie `.env.example` para `.env` e preencha `SHEET_WEBAPP_URL`,
`SHEET_WEBAPP_TOKEN`, `HTTP_TOKEN` (um valor aleatório qualquer) e, depois do
pareamento, `WA_GROUP_JID`.

Deixe `DRY_RUN=true` até o final da configuração — nada é enviado ao WhatsApp
enquanto isso.

## Configuração passo a passo

Cada passo é verificável sozinho. Não pule para o seguinte sem o anterior
funcionando.

### 1. Conferir a ponte com a planilha

```bash
npm run sheet:rows
```

Lista as linhas como o robô as vê e diz quais estão pendentes de envio. Se der
403, a implantação do Apps Script não está como "Qualquer pessoa".

### 2. Parear o WhatsApp

```bash
npm run wa:login
```

Escaneie o QR com o **chip dedicado**. A sessão fica em `data/wa-session/` e
sobrevive a reinícios.

O WhatsApp costuma encerrar a conexão com `código 515` logo depois do
pareamento. É esperado: as credenciais já foram gravadas, basta rodar o comando
outra vez — e a segunda execução **não deve pedir QR**. Se pedir, a sessão não
está sendo persistida; não escaneie de novo antes de investigar.

### 3. Descobrir o JID do grupo

```bash
npm run wa:groups
```

Copie a linha `WA_GROUP_JID=...` do grupo desejado para o `.env`.

> Antes de apontar para o grupo real, use um grupo de teste. Vale a pena.

Para conferir o envio sem depender da planilha:

```bash
npm run wa:test
```

Manda uma oferta fictícia, marcada como teste, para o `WA_GROUP_JID` atual.
Ele **ignora o `DRY_RUN` de propósito** — testar envio com o envio desligado não
testaria nada. Por isso imprime o destino e espera 5s antes de disparar.

### 4. Rodar em seco

```bash
npm run dev
```

Com `DRY_RUN=true`, as mensagens são impressas no console em vez de enviadas.
Para disparar um ciclo na hora, sem esperar o horário agendado:

```bash
curl -X POST http://127.0.0.1:8787/run -H "x-api-token: SEU_TOKEN"
```

Confira as mensagens (o console indica se a foto veio). Quando estiverem boas,
troque `DRY_RUN=false` no `.env`. Em DRY_RUN **nada é marcado** — nem no banco,
nem na coluna Status — então o primeiro ciclo real reenvia o que você viu em
seco; é o comportamento desejado.

## Operação contínua (Agendador de Tarefas do Windows)

O cron vive **dentro** do processo, então o robô é um serviço que fica no ar —
não uma tarefa disparada a cada ciclo. Isso é obrigatório: o Baileys precisa de
processo vivo para manter a sessão do WhatsApp.

**Fechar o terminal não desfaz o pareamento.** Vale separar duas coisas: a
*conexão* (viva só enquanto o processo roda) e o *pareamento* (arquivos em
`data/wa-session/`, que ficam no disco). Matar o processo derruba a conexão e,
com ela, o agendamento — nada é publicado até subir de novo —, mas a próxima
execução reconecta sozinha, sem QR. O pareamento só se perde em quatro
situações: você desvincula o aparelho em *Dispositivos conectados* no celular, o
número é banido, alguém apaga `data/wa-session/`, ou o dispositivo fica
desvinculado por inatividade — o WhatsApp derruba dispositivos vinculados depois
de cerca de 14 dias sem que o celular principal se conecte. Quando isso
acontece, o log traz `logged out` e a solução é rodar `npm run wa:login` de
novo.

```bash
npm run build
```

A tarefa **já está registrada** como `RoboOfertasWhatsApp` (criada em
18/08/2026). O XML dela vive em `scripts/robo-ofertas-task.xml`; para recriar
em outra máquina, ajuste o `UserId` e o `WorkingDirectory` e rode:

```bash
schtasks /Create /TN "RoboOfertasWhatsApp" /XML scripts/robo-ofertas-task.xml /F
```

O que a tarefa faz:

- **Disparadores**: ao fazer logon (com 30s de atraso) **e** um gatilho de
  horário que se repete **a cada 2 minutos, indefinidamente**.
- **Ação**: `node.exe` (caminho completo: `C:\Program Files\nodejs\node.exe`)
  com os argumentos `--disable-warning=ExperimentalWarning dist/src/index.js`
  e *Iniciar em* apontando para a pasta do projeto (obrigatório: sem isso o `.env` e o `data/` não são
  encontrados).
- **Se já estiver em execução**: *Ignorar nova instância*. É esse par —
  repetir a cada 2 min + ignorar nova instância — que faz o robô voltar
  sozinho: a cada 2 minutos o Windows tenta subir; se o processo está vivo,
  a tentativa é descartada; se caiu, ele volta. O downtime máximo é 2 min.

**Não confie em *Reiniciar se a tarefa falhar*.** Testado em 18/08/2026:
matando o processo, a tarefa registrou falha (`LastTaskResult` 0xFFFFFFFF) e
**não** relançou nada em 80s. Essa opção cobre falha de *inicialização*, não
processo que morreu depois de subir. A repetição de 2 min foi testada do
mesmo jeito e ressuscitou o robô em menos de 2 minutos.

Comandos úteis:

```bash
schtasks /Query /TN "RoboOfertasWhatsApp" /V /FO LIST   # estado
schtasks /End   /TN "RoboOfertasWhatsApp"               # parar (volta em 2 min!)
schtasks /Change /TN "RoboOfertasWhatsApp" /DISABLE     # parar de verdade
```

Parar o robô exige **desabilitar** a tarefa — só matar o processo não
adianta, ele volta em 2 minutos.

O PC precisa estar ligado nos horários agendados, e o usuário precisa estar
logado: a tarefa roda com *token interativo* (não guarda senha), então numa
máquina reiniciada que parou na tela de bloqueio ela só sobe após o logon.

Log em `logs/app.log`. Estado em tempo real:

```bash
curl http://127.0.0.1:8787/health -H "x-api-token: SEU_TOKEN"
```

## Ajustando o comportamento

Em `config.json`, sem tocar em código. As chaves que valem para o fluxo atual:

| Chave | Efeito |
|---|---|
| `schedule` | Horários (cron, fuso America/Sao_Paulo) |
| `dedupe.maxPostsPerRun` | Teto de linhas publicadas por ciclo |
| `whatsapp.minDelayMs` / `maxDelayMs` | Intervalo entre mensagens (higiene anti-ban) |

As seções `search`, `scoring` e `affiliate` pertencem ao fluxo antigo e são
ignoradas pelo ciclo atual.

## API local

Escuta apenas em `127.0.0.1`, exige o header `x-api-token`.

| Rota | Faz |
|---|---|
| `GET /health` | Estado da planilha configurada e do WhatsApp |
| `GET /deals` | Lê a planilha, faz o scraping e devolve as mensagens **sem publicar** |
| `GET /deals/last` | Última prévia calculada, sem recalcular |
| `POST /run` | Dispara um ciclo (aceita `{"dryRun": true}`) |

Ela existe também para o dia em que você quiser um orquestrador externo (n8n,
por exemplo): ele assume o agendamento chamando `POST /run`, sem que a lógica
mude de lugar.

## Testes

```bash
npm test
```

24 verificações — template curado, parsing de preço, extração de og:, camada
HTTP, e o núcleo do fluxo antigo (scoring/dedupe, que segue testado enquanto o
código existir) — com dados sintéticos, em banco temporário. Não precisa de
credenciais.

## Adicionando outra loja

Enquanto o link da loja expuser `og:title`/`og:image`, basta colar na planilha:
o scraping e a mensagem são agnósticos de loja (só o rodapé da mensagem cita o
Mercado Livre hoje — `renderOffer` em `src/message/template.ts`). Um canal novo
(Telegram, Discord) é um módulo em `src/channels/` citado em `src/registry.ts`.

## Fluxo antigo (API do ML) — dormente

O projeto nasceu buscando ofertas na API oficial do ML, validando desconto
contra histórico próprio de preços e afiliando via automação do painel. Esse
código continua no repositório (`src/providers/`, `src/affiliate/`,
`src/pipeline/scoring.ts`, scripts `ml:*`), desligado do ciclo desde a virada
para a planilha. Foi abandonado porque o ML desativou o `/sites/MLB/search`
(403 para todos), a coleta via catálogo gerava links cuja afiliação era
incerta, e a automação do painel era o ponto mais frágil do sistema. Para
religar um dia: citar o provider e o conversor de novo em `src/registry.ts` e
reintroduzir o estágio de scoring no `src/pipeline/run.ts`.

## Problemas comuns

**`Este programa está bloqueado por uma política de grupo`** — o AppLocker desta
máquina bloqueia os atalhos `.cmd` de `node_modules/.bin`. Por isso todos os
scripts do `package.json` chamam `node node_modules/...` direto. Se você criar um
script novo, siga o mesmo padrão e não use `npx`.

**`Web app da planilha respondeu 403`** — a implantação do Apps Script está
restrita. Em *Implantar → Gerenciar implantações*, troque o acesso para
"Qualquer pessoa" e publique uma nova versão.

**Editei o script da planilha e nada mudou** — Apps Script só aplica mudanças
após *Implantar → Gerenciar implantações → nova versão*. A URL não muda.

**Scraping falhou numa linha** — o erro fica no log e no campo
`scrapeFailures` da resposta de `POST /run`; a linha continua sem status e será
tentada de novo no próximo ciclo. Se o erro citar navegador ausente, rode
`npm run playwright:install`.

**WhatsApp deslogado** — rode `npm run wa:login` e escaneie o QR outra vez.

**Nada é publicado** — confira `DRY_RUN` no `.env` e rode `npm run sheet:rows`:
ele diz, linha a linha, por que cada uma está ou não pendente.

## Segurança

`data/` contém a sessão do WhatsApp e o banco local; o `.env` contém o token do
web app da planilha. Qualquer um deles dá acesso a algo seu. A pasta e o
arquivo estão no `.gitignore` — mantenha assim.
